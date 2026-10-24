package auth

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func twitterOAuth1Config() model.AuthConfig {
	return model.AuthConfig{
		Type:                  "oauth1",
		OAuth1ConsumerKey:     "xvz1evFS4wEEPTGEFPHBog",
		OAuth1ConsumerSecret:  "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
		OAuth1Token:           "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
		OAuth1TokenSecret:     "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
		OAuth1SignatureMethod: "HMAC-SHA1",
		OAuth1Timestamp:       "1318622958",
		OAuth1Nonce:           "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
	}
}

func twitterOAuth1Request(t *testing.T) *http.Request {
	t.Helper()
	body := "status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21"
	req, err := http.NewRequest(http.MethodPost, "https://api.twitter.com/1.1/statuses/update.json?include_entities=true", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return req
}

func oauth1HeaderParams(t *testing.T, header string) map[string]string {
	t.Helper()
	if !strings.HasPrefix(header, "OAuth ") {
		t.Fatalf("Authorization = %q, want an OAuth header", header)
	}
	params := map[string]string{}
	for _, part := range strings.Split(strings.TrimPrefix(header, "OAuth "), ", ") {
		key, value, _ := strings.Cut(part, "=")
		unquoted, err := url.PathUnescape(strings.Trim(value, `"`))
		if err != nil {
			t.Fatalf("bad header value %q: %v", part, err)
		}
		params[key] = unquoted
	}
	return params
}

func TestSignOAuth1MatchesTheTwitterReferenceSignature(t *testing.T) {
	req := twitterOAuth1Request(t)
	if err := Apply(req, twitterOAuth1Config()); err != nil {
		t.Fatal(err)
	}
	params := oauth1HeaderParams(t, req.Header.Get("Authorization"))
	if got, want := params["oauth_signature"], "hCtSmYh+iHYCEqBWrE7C7hYmtUk="; got != want {
		t.Fatalf("oauth_signature = %q, want %q", got, want)
	}
	for key, want := range map[string]string{
		"oauth_consumer_key":     "xvz1evFS4wEEPTGEFPHBog",
		"oauth_token":            "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
		"oauth_signature_method": "HMAC-SHA1",
		"oauth_version":          "1.0",
	} {
		if params[key] != want {
			t.Fatalf("%s = %q, want %q", key, params[key], want)
		}
	}
	body, _ := io.ReadAll(req.Body)
	if !strings.HasPrefix(string(body), "status=Hello") {
		t.Fatalf("body was not kept for sending: %q", body)
	}
}

func TestSignOAuth1PutsParamsInTheQueryOrTheBody(t *testing.T) {
	cfg := twitterOAuth1Config()
	cfg.OAuth1AddTo = "query"
	req := twitterOAuth1Request(t)
	if err := Apply(req, cfg); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("Authorization") != "" {
		t.Fatalf("query mode must not set Authorization: %q", req.Header.Get("Authorization"))
	}
	query := req.URL.Query()
	if got, want := query.Get("oauth_signature"), "hCtSmYh+iHYCEqBWrE7C7hYmtUk="; got != want {
		t.Fatalf("query oauth_signature = %q, want %q", got, want)
	}
	if query.Get("include_entities") != "true" {
		t.Fatalf("existing query was lost: %q", req.URL.RawQuery)
	}

	cfg.OAuth1AddTo = "body"
	req = twitterOAuth1Request(t)
	if err := Apply(req, cfg); err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(req.Body)
	form, err := url.ParseQuery(string(body))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := form.Get("oauth_signature"), "hCtSmYh+iHYCEqBWrE7C7hYmtUk="; got != want {
		t.Fatalf("body oauth_signature = %q, want %q", got, want)
	}
	if form.Get("status") != "Hello Ladies + Gentlemen, a signed OAuth request!" {
		t.Fatalf("form field lost: %q", body)
	}
	if req.ContentLength != int64(len(body)) {
		t.Fatalf("ContentLength = %d, want %d", req.ContentLength, len(body))
	}
}

func TestSignOAuth1RefusesTheBodyForANonFormRequest(t *testing.T) {
	cfg := twitterOAuth1Config()
	cfg.OAuth1AddTo = "body"
	req, _ := http.NewRequest(http.MethodPost, "https://api.example.test/x", strings.NewReader(`{"a":1}`))
	req.Header.Set("Content-Type", "application/json")
	if err := Apply(req, cfg); err == nil || !strings.Contains(err.Error(), "form-urlencoded") {
		t.Fatalf("err = %v, want a form-urlencoded error", err)
	}
}

func TestSignOAuth1GeneratesTimestampAndNonceAndAddsRealmAndBodyHash(t *testing.T) {
	restoreNow, restoreNonce := oauth1Now, oauth1Nonce
	t.Cleanup(func() { oauth1Now, oauth1Nonce = restoreNow, restoreNonce })
	oauth1Now = func() time.Time { return time.Unix(1700000000, 0) }
	oauth1Nonce = func() string { return "fixed-nonce" }

	req, _ := http.NewRequest(http.MethodPut, "HTTPS://API.Example.test:443/a b?x=1", strings.NewReader(`{"a":1}`))
	req.Header.Set("Content-Type", "application/json")
	cfg := model.AuthConfig{
		Type:                  "oauth1",
		OAuth1ConsumerKey:     "key",
		OAuth1ConsumerSecret:  "secret",
		OAuth1SignatureMethod: "HMAC-SHA256",
		OAuth1Realm:           "Example",
		OAuth1IncludeBodyHash: true,
	}
	if err := Apply(req, cfg); err != nil {
		t.Fatal(err)
	}
	header := req.Header.Get("Authorization")
	if !strings.HasPrefix(header, `OAuth realm="Example", `) {
		t.Fatalf("realm missing: %q", header)
	}
	params := oauth1HeaderParams(t, header)
	if params["oauth_timestamp"] != "1700000000" || params["oauth_nonce"] != "fixed-nonce" {
		t.Fatalf("timestamp/nonce = %q/%q", params["oauth_timestamp"], params["oauth_nonce"])
	}
	sum := sha256.Sum256([]byte(`{"a":1}`))
	if got, want := params["oauth_body_hash"], base64.StdEncoding.EncodeToString(sum[:]); got != want {
		t.Fatalf("oauth_body_hash = %q, want %q", got, want)
	}
	if _, ok := params["oauth_token"]; ok {
		t.Fatalf("empty token should be left out: %q", header)
	}
	if got, want := oauth1BaseURL(req), "https://api.example.test/a%20b"; got != want {
		t.Fatalf("base URL = %q, want %q", got, want)
	}
}

func TestSignOAuth1RSASignaturesVerify(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	for method, hashID := range map[string]crypto.Hash{"RSA-SHA1": crypto.SHA1, "RSA-SHA256": crypto.SHA256} {
		cfg := twitterOAuth1Config()
		cfg.OAuth1SignatureMethod = method
		cfg.OAuth1PrivateKey = keyPEM
		req := twitterOAuth1Request(t)
		if err := Apply(req, cfg); err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		params := oauth1HeaderParams(t, req.Header.Get("Authorization"))
		sig, err := base64.StdEncoding.DecodeString(params["oauth_signature"])
		if err != nil {
			t.Fatalf("%s: signature is not base64: %v", method, err)
		}
		verifyReq := twitterOAuth1Request(t)
		signed := []oauth1Param{
			{"oauth_consumer_key", cfg.OAuth1ConsumerKey}, {"oauth_signature_method", method},
			{"oauth_timestamp", cfg.OAuth1Timestamp}, {"oauth_nonce", cfg.OAuth1Nonce},
			{"oauth_version", "1.0"}, {"oauth_token", cfg.OAuth1Token},
			{"include_entities", "true"}, {"status", "Hello Ladies + Gentlemen, a signed OAuth request!"},
		}
		base := oauth1Encode("POST") + "&" + oauth1Encode(oauth1BaseURL(verifyReq)) + "&" + oauth1Encode(oauth1NormalizeParams(signed))
		h := hashID.New()
		h.Write([]byte(base))
		if err := rsa.VerifyPKCS1v15(&key.PublicKey, hashID, h.Sum(nil), sig); err != nil {
			t.Fatalf("%s signature does not verify: %v", method, err)
		}
	}

	cfg := twitterOAuth1Config()
	cfg.OAuth1SignatureMethod = "RSA-SHA256"
	if err := Apply(twitterOAuth1Request(t), cfg); err == nil || !strings.Contains(err.Error(), "private key") {
		t.Fatalf("missing key err = %v", err)
	}
}

func TestOAuth1EncodeFollowsRFC5849(t *testing.T) {
	for in, want := range map[string]string{
		"Ladies + Gentlemen": "Ladies%20%2B%20Gentlemen",
		"An encoded string!": "An%20encoded%20string%21",
		"Dogs, Cats & Mice":  "Dogs%2C%20Cats%20%26%20Mice",
		"☃":                  "%E2%98%83",
		"-._~":               "-._~",
	} {
		if got := oauth1Encode(in); got != want {
			t.Fatalf("oauth1Encode(%q) = %q, want %q", in, got, want)
		}
	}
}
