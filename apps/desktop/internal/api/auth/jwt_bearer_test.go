package auth

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func decodeJWTPart(t *testing.T, part string) map[string]any {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(part)
	if err != nil {
		t.Fatalf("decode %q: %v", part, err)
	}
	out := map[string]any{}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal %s: %v", raw, err)
	}
	return out
}

func splitJWT(t *testing.T, token string) (map[string]any, map[string]any, []byte, string) {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("token %q does not have three parts", token)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("signature: %v", err)
	}
	return decodeJWTPart(t, parts[0]), decodeJWTPart(t, parts[1]), signature, parts[0] + "." + parts[1]
}

func TestSignJWTBearerHS256MatchesHMAC(t *testing.T) {
	cfg := model.AuthConfig{Type: "jwt", JWTSecret: "s3cret", JWTPayload: `{"sub":"42","role":"admin","n":12345678901234567890}`}
	token, err := SignJWTBearer(cfg, time.Unix(1_700_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	header, claims, signature, input := splitJWT(t, token)
	if header["alg"] != "HS256" || header["typ"] != "JWT" {
		t.Fatalf("header = %v", header)
	}
	if claims["sub"] != "42" || claims["role"] != "admin" {
		t.Fatalf("claims = %v", claims)
	}
	if payload := string(mustDecode(t, strings.Split(token, ".")[1])); !strings.Contains(payload, "12345678901234567890") {
		t.Fatalf("large numbers must survive without float rounding: %s", payload)
	}
	mac := hmac.New(sha256.New, []byte("s3cret"))
	mac.Write([]byte(input))
	if !hmac.Equal(mac.Sum(nil), signature) {
		t.Fatal("HS256 signature does not verify")
	}
	if _, ok := claims["iat"]; ok {
		t.Fatal("iat must not be added without expires in")
	}
}

func mustDecode(t *testing.T, part string) []byte {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(part)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestSignJWTBearerExpiresInAddsMissingTimeClaims(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	token, err := SignJWTBearer(model.AuthConfig{JWTSecret: "k", JWTExpiresIn: "600"}, now)
	if err != nil {
		t.Fatal(err)
	}
	_, claims, _, _ := splitJWT(t, token)
	if claims["iat"] != float64(now.Unix()) || claims["exp"] != float64(now.Unix()+600) {
		t.Fatalf("claims = %v", claims)
	}

	token, err = SignJWTBearer(model.AuthConfig{JWTSecret: "k", JWTExpiresIn: "600", JWTPayload: `{"exp": 1}`}, now)
	if err != nil {
		t.Fatal(err)
	}
	_, claims, _, _ = splitJWT(t, token)
	if claims["exp"] != float64(1) || claims["iat"] != float64(now.Unix()) {
		t.Fatalf("payload exp must win: %v", claims)
	}

	if _, err := SignJWTBearer(model.AuthConfig{JWTSecret: "k", JWTExpiresIn: "soon"}, now); err == nil || !strings.Contains(err.Error(), "expires in") {
		t.Fatalf("err = %v", err)
	}
}

func TestSignJWTBearerHeaderFieldsAndBase64Secret(t *testing.T) {
	cfg := model.AuthConfig{
		JWTAlgorithm:    "hs384",
		JWTSecret:       base64.StdEncoding.EncodeToString([]byte{0, 1, 2, 250}),
		JWTSecretBase64: true,
		JWTHeaders:      `{"kid":"key-1","alg":"none","typ":"at+jwt"}`,
	}
	token, err := SignJWTBearer(cfg, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	header, _, signature, input := splitJWT(t, token)
	if header["alg"] != "HS384" || header["kid"] != "key-1" || header["typ"] != "at+jwt" {
		t.Fatalf("header = %v", header)
	}
	newHash, _, _ := jwtHash("HS384")
	mac := hmac.New(newHash, []byte{0, 1, 2, 250})
	mac.Write([]byte(input))
	if !hmac.Equal(mac.Sum(nil), signature) {
		t.Fatal("base64 secret was not decoded before signing")
	}

	cfg.JWTSecret = "not base64!"
	if _, err := SignJWTBearer(cfg, time.Now()); err == nil || !strings.Contains(err.Error(), "base64") {
		t.Fatalf("err = %v", err)
	}
}

func TestSignJWTBearerRSAAndECDSA(t *testing.T) {
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	rsaPEM := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(rsaKey)}))
	for _, algorithm := range []string{"RS256", "PS256"} {
		token, err := SignJWTBearer(model.AuthConfig{JWTAlgorithm: algorithm, JWTPrivateKey: rsaPEM}, time.Now())
		if err != nil {
			t.Fatalf("%s: %v", algorithm, err)
		}
		_, _, signature, input := splitJWT(t, token)
		digest := sha256.Sum256([]byte(input))
		if algorithm == "RS256" {
			err = rsa.VerifyPKCS1v15(&rsaKey.PublicKey, crypto.SHA256, digest[:], signature)
		} else {
			err = rsa.VerifyPSS(&rsaKey.PublicKey, crypto.SHA256, digest[:], signature, nil)
		}
		if err != nil {
			t.Fatalf("%s signature does not verify: %v", algorithm, err)
		}
	}

	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(ecKey)
	if err != nil {
		t.Fatal(err)
	}
	ecPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	token, err := SignJWTBearer(model.AuthConfig{JWTAlgorithm: "ES256", JWTPrivateKey: ecPEM}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, _, signature, input := splitJWT(t, token)
	digest := sha256.Sum256([]byte(input))
	r, s := new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])
	if !ecdsa.Verify(&ecKey.PublicKey, digest[:], r, s) {
		t.Fatal("ES256 signature does not verify")
	}

	if _, err := SignJWTBearer(model.AuthConfig{JWTAlgorithm: "ES256", JWTPrivateKey: rsaPEM}, time.Now()); err == nil || !strings.Contains(err.Error(), "ECDSA") {
		t.Fatalf("key/algorithm mismatch err = %v", err)
	}
	if _, err := SignJWTBearer(model.AuthConfig{JWTAlgorithm: "RS256"}, time.Now()); err == nil || !strings.Contains(err.Error(), "private key") {
		t.Fatalf("missing key err = %v", err)
	}
}

func TestSignJWTBearerRejectsBadInput(t *testing.T) {
	cases := map[string]model.AuthConfig{
		"requires a secret":     {},
		"not valid JSON":        {JWTSecret: "k", JWTPayload: `{"sub":`},
		"must be a JSON object": {JWTSecret: "k", JWTPayload: `["a"]`},
		"unsupported algorithm": {JWTSecret: "k", JWTAlgorithm: "none"},
	}
	for want, cfg := range cases {
		if _, err := SignJWTBearer(cfg, time.Now()); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v", want, err)
		}
	}
}

func TestApplyJWTBearerPlacesToken(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://api.example.test/items?page=2&q=a%20b", nil)
	if err := Apply(req, model.AuthConfig{Type: "jwt", JWTSecret: "k"}); err != nil {
		t.Fatal(err)
	}
	if h := req.Header.Get("Authorization"); !strings.HasPrefix(h, "Bearer ") || strings.Count(h, ".") != 2 {
		t.Fatalf("Authorization = %q", h)
	}

	req, _ = http.NewRequest(http.MethodGet, "https://api.example.test/items?page=2&q=a%20b", nil)
	if err := Apply(req, model.AuthConfig{Type: "jwt", JWTSecret: "k", JWTHeaderPrefix: "JWT"}); err != nil {
		t.Fatal(err)
	}
	if h := req.Header.Get("Authorization"); !strings.HasPrefix(h, "JWT ") {
		t.Fatalf("Authorization = %q", h)
	}

	req, _ = http.NewRequest(http.MethodGet, "https://api.example.test/items?page=2&q=a%20b", nil)
	if err := Apply(req, model.AuthConfig{Type: "jwt", JWTSecret: "k", JWTAddTo: "query", JWTQueryParam: "access_token"}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(req.URL.RawQuery, "page=2&q=a%20b&access_token=") || req.Header.Get("Authorization") != "" {
		t.Fatalf("query = %q, header = %q", req.URL.RawQuery, req.Header.Get("Authorization"))
	}

	req, _ = http.NewRequest(http.MethodGet, "https://api.example.test/", nil)
	if err := Apply(req, model.AuthConfig{Type: "jwt", JWTPayload: "{"}); err == nil {
		t.Fatal("expected a signing error")
	}
}

func TestPrepareJWTBearerSignsOnceForJWTOnly(t *testing.T) {
	cfg := model.AuthConfig{Type: "jwt", JWTSecret: "k"}
	if err := PrepareJWTBearer(&cfg); err != nil || strings.Count(cfg.Token, ".") != 2 {
		t.Fatalf("token = %q, err = %v", cfg.Token, err)
	}
	signed := cfg.Token
	if err := PrepareJWTBearer(&cfg); err != nil || cfg.Token != signed {
		t.Fatal("an already signed token must be kept")
	}
	bearer := model.AuthConfig{Type: "bearer", Token: "abc"}
	if err := PrepareJWTBearer(&bearer); err != nil || bearer.Token != "abc" {
		t.Fatal("other auth types must be left alone")
	}
}
