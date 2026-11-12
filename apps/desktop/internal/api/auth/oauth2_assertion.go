package auth

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"hash"
	"math/big"
	"strings"
	"time"
)

const (
	ClientAuthBasic           = "basic"
	ClientAuthBody            = "body"
	ClientAuthClientSecretJWT = "client_secret_jwt"
	ClientAuthPrivateKeyJWT   = "private_key_jwt"
)

const clientAssertionType = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"

const assertionLifetime = 5 * time.Minute

func resolveClientAuth(method, secret string) string {
	switch strings.ToLower(strings.TrimSpace(method)) {
	case ClientAuthBasic:
		return ClientAuthBasic
	case ClientAuthBody:
		return ClientAuthBody
	case ClientAuthClientSecretJWT:
		return ClientAuthClientSecretJWT
	case ClientAuthPrivateKeyJWT:
		return ClientAuthPrivateKeyJWT
	default:
		if secret != "" {
			return ClientAuthBasic
		}
		return ClientAuthBody
	}
}

func buildClientAssertion(clientID, audience, algorithm, keyID, secret, privateKeyPEM string, method string) (string, error) {
	if clientID == "" {
		return "", fmt.Errorf("oauth2: client ID is required to build a client assertion")
	}
	if audience == "" {
		return "", fmt.Errorf("oauth2: an audience (usually the token URL) is required to build a client assertion")
	}

	jti, err := randomURLToken(16)
	if err != nil {
		return "", fmt.Errorf("oauth2: failed to generate assertion id: %w", err)
	}
	now := time.Now()
	claims := map[string]any{
		"iss": clientID,
		"sub": clientID,
		"aud": audience,
		"jti": jti,
		"iat": now.Unix(),
		"exp": now.Add(assertionLifetime).Unix(),
	}

	if method == ClientAuthClientSecretJWT {
		if algorithm == "" {
			algorithm = "HS256"
		}
		if !strings.HasPrefix(strings.ToUpper(algorithm), "HS") {
			return "", fmt.Errorf("oauth2: client_secret_jwt requires an HMAC algorithm (HS256/HS384/HS512), got %q", algorithm)
		}
		if secret == "" {
			return "", fmt.Errorf("oauth2: client_secret_jwt requires a client secret")
		}
		return signJWT(claims, strings.ToUpper(algorithm), keyID, []byte(secret), nil)
	}

	if strings.TrimSpace(privateKeyPEM) == "" {
		return "", fmt.Errorf("oauth2: private_key_jwt requires a private key")
	}
	key, inferred, err := parsePrivateKeyPEM(privateKeyPEM)
	if err != nil {
		return "", fmt.Errorf("oauth2: %w", err)
	}
	if algorithm == "" {
		algorithm = inferred
	}
	return signJWT(claims, strings.ToUpper(algorithm), keyID, nil, key)
}

func parsePrivateKeyPEM(pemData string) (crypto.PrivateKey, string, error) {
	block, _ := pem.Decode([]byte(strings.TrimSpace(pemData)))
	if block == nil {
		return nil, "", fmt.Errorf("private key is not valid PEM")
	}
	if strings.Contains(block.Type, "ENCRYPTED") {
		return nil, "", fmt.Errorf("encrypted private keys are not supported — decrypt the key first")
	}

	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, "RS256", nil
	}
	if key, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		return key, ecdsaAlgorithm(key), nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, "", fmt.Errorf("could not parse private key: %w", err)
	}
	switch key := parsed.(type) {
	case *rsa.PrivateKey:
		return key, "RS256", nil
	case *ecdsa.PrivateKey:
		return key, ecdsaAlgorithm(key), nil
	default:
		return nil, "", fmt.Errorf("unsupported private key type %T (RSA and ECDSA are supported)", parsed)
	}
}

func ecdsaAlgorithm(key *ecdsa.PrivateKey) string {
	switch key.Curve.Params().BitSize {
	case 384:
		return "ES384"
	case 521:
		return "ES512"
	default:
		return "ES256"
	}
}

func signJWT(claims map[string]any, algorithm, keyID string, hmacKey []byte, signer crypto.PrivateKey) (string, error) {
	header := map[string]any{"alg": algorithm, "typ": "JWT"}
	if keyID != "" {
		header["kid"] = keyID
	}
	token, err := signJWTWithHeader(header, claims, algorithm, hmacKey, signer)
	if err != nil {
		return "", fmt.Errorf("oauth2: %w", err)
	}
	return token, nil
}

func signJWTWithHeader(header, claims map[string]any, algorithm string, hmacKey []byte, signer crypto.PrivateKey) (string, error) {
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signingInput := base64.RawURLEncoding.EncodeToString(headerJSON) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)

	newHash, cryptoHash, err := jwtHash(algorithm)
	if err != nil {
		return "", err
	}
	hashFn := newHash()
	hashFn.Write([]byte(signingInput))
	digest := hashFn.Sum(nil)

	var signature []byte
	switch {
	case strings.HasPrefix(algorithm, "HS"):
		if len(hmacKey) == 0 {
			return "", fmt.Errorf("algorithm %s requires a shared secret", algorithm)
		}
		mac := hmac.New(newHash, hmacKey)
		mac.Write([]byte(signingInput))
		signature = mac.Sum(nil)
	case strings.HasPrefix(algorithm, "RS"):
		key, ok := signer.(*rsa.PrivateKey)
		if !ok {
			return "", fmt.Errorf("algorithm %s requires an RSA private key", algorithm)
		}
		signature, err = rsa.SignPKCS1v15(rand.Reader, key, cryptoHash, digest)
		if err != nil {
			return "", fmt.Errorf("failed to sign token: %w", err)
		}
	case strings.HasPrefix(algorithm, "PS"):
		key, ok := signer.(*rsa.PrivateKey)
		if !ok {
			return "", fmt.Errorf("algorithm %s requires an RSA private key", algorithm)
		}
		signature, err = rsa.SignPSS(rand.Reader, key, cryptoHash, digest, &rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthEqualsHash, Hash: cryptoHash})
		if err != nil {
			return "", fmt.Errorf("failed to sign token: %w", err)
		}
	case strings.HasPrefix(algorithm, "ES"):
		key, ok := signer.(*ecdsa.PrivateKey)
		if !ok {
			return "", fmt.Errorf("algorithm %s requires an ECDSA private key", algorithm)
		}
		r, s, signErr := ecdsa.Sign(rand.Reader, key, digest)
		if signErr != nil {
			return "", fmt.Errorf("failed to sign token: %w", signErr)
		}
		byteLen := (key.Curve.Params().BitSize + 7) / 8
		signature = append(padBigInt(r, byteLen), padBigInt(s, byteLen)...)
	default:
		return "", fmt.Errorf("unsupported signing algorithm %q", algorithm)
	}

	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func jwtHash(algorithm string) (func() hash.Hash, crypto.Hash, error) {
	switch {
	case strings.HasSuffix(algorithm, "256"):
		return sha256.New, crypto.SHA256, nil
	case strings.HasSuffix(algorithm, "384"):
		return sha512.New384, crypto.SHA384, nil
	case strings.HasSuffix(algorithm, "512"):
		return sha512.New, crypto.SHA512, nil
	default:
		return nil, 0, fmt.Errorf("unsupported signing algorithm %q", algorithm)
	}
}

func padBigInt(v *big.Int, size int) []byte {
	buf := make([]byte, size)
	v.FillBytes(buf)
	return buf
}
