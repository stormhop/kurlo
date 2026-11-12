package auth

import (
	"bytes"
	"crypto"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	JWTAddToHeader = "header"
	JWTAddToQuery  = "query"

	defaultJWTAlgorithm    = "HS256"
	defaultJWTHeaderPrefix = "Bearer"
	defaultJWTQueryParam   = "token"
)

var jwtAlgorithms = map[string]bool{
	"HS256": true, "HS384": true, "HS512": true,
	"RS256": true, "RS384": true, "RS512": true,
	"PS256": true, "PS384": true, "PS512": true,
	"ES256": true, "ES384": true, "ES512": true,
}

func JWTAlgorithm(cfg model.AuthConfig) string {
	algorithm := strings.ToUpper(strings.TrimSpace(cfg.JWTAlgorithm))
	if algorithm == "" {
		return defaultJWTAlgorithm
	}
	return algorithm
}

func JWTHeaderPrefix(cfg model.AuthConfig) string {
	if cfg.JWTHeaderPrefix == "" {
		return defaultJWTHeaderPrefix
	}
	return strings.TrimSpace(cfg.JWTHeaderPrefix)
}

func JWTQueryParam(cfg model.AuthConfig) string {
	if name := strings.TrimSpace(cfg.JWTQueryParam); name != "" {
		return name
	}
	return defaultJWTQueryParam
}

func JWTAddsToQuery(cfg model.AuthConfig) bool {
	return strings.EqualFold(strings.TrimSpace(cfg.JWTAddTo), JWTAddToQuery)
}

func SignJWTBearer(cfg model.AuthConfig, now time.Time) (string, error) {
	algorithm := JWTAlgorithm(cfg)
	if !jwtAlgorithms[algorithm] {
		return "", fmt.Errorf("jwt: unsupported algorithm %q", algorithm)
	}

	header, err := jwtJSONObject(cfg.JWTHeaders, "header")
	if err != nil {
		return "", err
	}
	header["alg"] = algorithm
	if _, ok := header["typ"]; !ok {
		header["typ"] = "JWT"
	}

	claims, err := jwtJSONObject(cfg.JWTPayload, "payload")
	if err != nil {
		return "", err
	}
	if lifetime := strings.TrimSpace(cfg.JWTExpiresIn); lifetime != "" {
		seconds, parseErr := strconv.ParseInt(lifetime, 10, 64)
		if parseErr != nil || seconds <= 0 {
			return "", fmt.Errorf("jwt: expires in must be a positive number of seconds, got %q", lifetime)
		}
		if _, ok := claims["iat"]; !ok {
			claims["iat"] = now.Unix()
		}
		if _, ok := claims["exp"]; !ok {
			claims["exp"] = now.Add(time.Duration(seconds) * time.Second).Unix()
		}
	}

	var hmacKey []byte
	var signer crypto.PrivateKey
	if strings.HasPrefix(algorithm, "HS") {
		hmacKey, err = jwtSecretBytes(cfg)
		if err != nil {
			return "", err
		}
	} else {
		if strings.TrimSpace(cfg.JWTPrivateKey) == "" {
			return "", fmt.Errorf("jwt: %s requires a private key in PEM form", algorithm)
		}
		key, _, parseErr := parsePrivateKeyPEM(cfg.JWTPrivateKey)
		if parseErr != nil {
			return "", fmt.Errorf("jwt: %w", parseErr)
		}
		signer = key
	}

	token, err := signJWTWithHeader(header, claims, algorithm, hmacKey, signer)
	if err != nil {
		return "", fmt.Errorf("jwt: %w", err)
	}
	return token, nil
}

func ApplyJWTBearer(req *http.Request, cfg model.AuthConfig) error {
	token := cfg.Token
	if token == "" {
		signed, err := SignJWTBearer(cfg, time.Now())
		if err != nil {
			return err
		}
		token = signed
	}
	if JWTAddsToQuery(cfg) {
		pair := url.QueryEscape(JWTQueryParam(cfg)) + "=" + url.QueryEscape(token)
		if req.URL.RawQuery == "" {
			req.URL.RawQuery = pair
		} else {
			req.URL.RawQuery += "&" + pair
		}
		return nil
	}
	if prefix := JWTHeaderPrefix(cfg); prefix != "" {
		req.Header.Set("Authorization", prefix+" "+token)
	} else {
		req.Header.Set("Authorization", token)
	}
	return nil
}

func PrepareJWTBearer(cfg *model.AuthConfig) error {
	if !strings.EqualFold(strings.TrimSpace(cfg.Type), "jwt") || cfg.Token != "" {
		return nil
	}
	token, err := SignJWTBearer(*cfg, time.Now())
	if err != nil {
		return err
	}
	cfg.Token = token
	return nil
}

func jwtJSONObject(text, label string) (map[string]any, error) {
	out := map[string]any{}
	if strings.TrimSpace(text) == "" {
		return out, nil
	}
	decoder := json.NewDecoder(bytes.NewReader([]byte(text)))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("jwt: %s is not valid JSON: %v", label, err)
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("jwt: %s must be a JSON object", label)
	}
	return object, nil
}

func jwtSecretBytes(cfg model.AuthConfig) ([]byte, error) {
	if cfg.JWTSecret == "" {
		return nil, fmt.Errorf("jwt: %s requires a secret", JWTAlgorithm(cfg))
	}
	if !cfg.JWTSecretBase64 {
		return []byte(cfg.JWTSecret), nil
	}
	secret := strings.TrimSpace(cfg.JWTSecret)
	for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if decoded, err := encoding.DecodeString(secret); err == nil {
			return decoded, nil
		}
	}
	return nil, fmt.Errorf("jwt: secret is marked as base64 but is not valid base64")
}
