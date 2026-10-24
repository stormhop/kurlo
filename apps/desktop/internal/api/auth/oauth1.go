package auth

import (
	"bytes"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"hash"
	"io"
	"mime"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const formURLEncoded = "application/x-www-form-urlencoded"

var (
	oauth1Now   = time.Now
	oauth1Nonce = func() string {
		buf := make([]byte, 16)
		if _, err := rand.Read(buf); err != nil {
			return strconv.FormatInt(time.Now().UnixNano(), 36)
		}
		return hex.EncodeToString(buf)
	}
)

type oauth1Param struct {
	key   string
	value string
}

func SignOAuth1(req *http.Request, cfg model.AuthConfig) error {
	method := strings.ToUpper(strings.TrimSpace(cfg.OAuth1SignatureMethod))
	if method == "" {
		method = "HMAC-SHA1"
	}
	if strings.TrimSpace(cfg.OAuth1ConsumerKey) == "" {
		return fmt.Errorf("oauth 1.0 requires a consumer key")
	}
	addTo := strings.ToLower(strings.TrimSpace(cfg.OAuth1AddTo))
	if addTo == "" {
		addTo = "header"
	}
	if addTo != "header" && addTo != "query" && addTo != "body" {
		return fmt.Errorf("oauth 1.0 parameters go in the header, the query or the body, not %q", cfg.OAuth1AddTo)
	}

	body, err := oauth1BufferBody(req)
	if err != nil {
		return err
	}
	formBody := isFormURLEncoded(req.Header.Get("Content-Type"))
	if addTo == "body" {
		if len(body) == 0 && req.Header.Get("Content-Type") == "" {
			req.Header.Set("Content-Type", formURLEncoded)
			formBody = true
		}
		if !formBody {
			return fmt.Errorf("oauth 1.0 parameters can only be added to a form-urlencoded body; choose the header or the query instead")
		}
	}

	timestamp := strings.TrimSpace(cfg.OAuth1Timestamp)
	if timestamp == "" {
		timestamp = strconv.FormatInt(oauth1Now().Unix(), 10)
	}
	nonce := strings.TrimSpace(cfg.OAuth1Nonce)
	if nonce == "" {
		nonce = oauth1Nonce()
	}
	version := strings.TrimSpace(cfg.OAuth1Version)
	if version == "" {
		version = "1.0"
	}

	oauthParams := []oauth1Param{
		{"oauth_consumer_key", cfg.OAuth1ConsumerKey},
		{"oauth_signature_method", method},
		{"oauth_timestamp", timestamp},
		{"oauth_nonce", nonce},
		{"oauth_version", version},
	}
	for _, optional := range []oauth1Param{
		{"oauth_token", cfg.OAuth1Token},
		{"oauth_callback", cfg.OAuth1Callback},
		{"oauth_verifier", cfg.OAuth1Verifier},
	} {
		if optional.value != "" || cfg.OAuth1AddEmptyParams {
			oauthParams = append(oauthParams, optional)
		}
	}
	if cfg.OAuth1IncludeBodyHash && !formBody {
		digest, err := oauth1BodyHash(method, body)
		if err != nil {
			return err
		}
		oauthParams = append(oauthParams, oauth1Param{"oauth_body_hash", digest})
	}

	signed := append([]oauth1Param{}, oauthParams...)
	signed = append(signed, oauth1QueryParams(req.URL.RawQuery)...)
	if formBody {
		signed = append(signed, oauth1QueryParams(string(body))...)
	}
	baseString := strings.Join([]string{
		oauth1Encode(strings.ToUpper(req.Method)),
		oauth1Encode(oauth1BaseURL(req)),
		oauth1Encode(oauth1NormalizeParams(signed)),
	}, "&")

	signature, err := oauth1Signature(method, baseString, cfg)
	if err != nil {
		return err
	}
	oauthParams = append(oauthParams, oauth1Param{"oauth_signature", signature})

	switch addTo {
	case "query":
		req.URL.RawQuery = oauth1AppendEncoded(req.URL.RawQuery, oauthParams)
	case "body":
		next := []byte(oauth1AppendEncoded(string(body), oauthParams))
		req.Body = io.NopCloser(bytes.NewReader(next))
		req.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(next)), nil
		}
		req.ContentLength = int64(len(next))
	default:
		req.Header.Set("Authorization", oauth1Header(cfg.OAuth1Realm, oauthParams))
	}
	return nil
}

func oauth1BufferBody(req *http.Request) ([]byte, error) {
	if req.Body == nil || req.Body == http.NoBody {
		return nil, nil
	}
	if req.GetBody == nil {
		head, err := io.ReadAll(io.LimitReader(req.Body, maxSignedPayloadBytes+1))
		if err != nil {
			return nil, err
		}
		if int64(len(head)) > maxSignedPayloadBytes {
			return nil, fmt.Errorf("oauth 1.0 cannot sign a body larger than %d MB", maxSignedPayloadBytes/(1024*1024))
		}
		_ = req.Body.Close()
		req.Body = io.NopCloser(bytes.NewReader(head))
		req.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(head)), nil
		}
		req.ContentLength = int64(len(head))
		return head, nil
	}
	return ReadBodyBytes(req)
}

func isFormURLEncoded(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	return err == nil && strings.EqualFold(mediaType, formURLEncoded)
}

func oauth1BodyHash(method string, body []byte) (string, error) {
	var h hash.Hash
	switch {
	case strings.HasSuffix(method, "SHA1"), method == "PLAINTEXT":
		h = sha1.New()
	case strings.HasSuffix(method, "SHA256"):
		h = sha256.New()
	case strings.HasSuffix(method, "SHA512"):
		h = sha512.New()
	default:
		return "", fmt.Errorf("unsupported oauth 1.0 signature method %q", method)
	}
	h.Write(body)
	return base64.StdEncoding.EncodeToString(h.Sum(nil)), nil
}

func oauth1Signature(method, baseString string, cfg model.AuthConfig) (string, error) {
	key := oauth1Encode(cfg.OAuth1ConsumerSecret) + "&" + oauth1Encode(cfg.OAuth1TokenSecret)
	switch method {
	case "PLAINTEXT":
		return key, nil
	case "HMAC-SHA1", "HMAC-SHA256", "HMAC-SHA512":
		newHash := map[string]func() hash.Hash{"HMAC-SHA1": sha1.New, "HMAC-SHA256": sha256.New, "HMAC-SHA512": sha512.New}[method]
		mac := hmac.New(newHash, []byte(key))
		mac.Write([]byte(baseString))
		return base64.StdEncoding.EncodeToString(mac.Sum(nil)), nil
	case "RSA-SHA1", "RSA-SHA256", "RSA-SHA512":
		privateKey, err := parseOAuth1PrivateKey(cfg.OAuth1PrivateKey)
		if err != nil {
			return "", err
		}
		hashID := map[string]crypto.Hash{"RSA-SHA1": crypto.SHA1, "RSA-SHA256": crypto.SHA256, "RSA-SHA512": crypto.SHA512}[method]
		h := hashID.New()
		h.Write([]byte(baseString))
		sig, err := rsa.SignPKCS1v15(rand.Reader, privateKey, hashID, h.Sum(nil))
		if err != nil {
			return "", fmt.Errorf("oauth 1.0 RSA signature failed: %w", err)
		}
		return base64.StdEncoding.EncodeToString(sig), nil
	default:
		return "", fmt.Errorf("unsupported oauth 1.0 signature method %q", method)
	}
}

func parseOAuth1PrivateKey(pemData string) (*rsa.PrivateKey, error) {
	if strings.TrimSpace(pemData) == "" {
		return nil, fmt.Errorf("oauth 1.0 RSA signatures need a private key")
	}
	block, _ := pem.Decode([]byte(strings.TrimSpace(pemData)))
	if block == nil {
		return nil, fmt.Errorf("oauth 1.0 private key is not valid PEM")
	}
	if strings.Contains(block.Type, "ENCRYPTED") {
		return nil, fmt.Errorf("oauth 1.0 private key is encrypted — decrypt the key first")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("oauth 1.0 could not parse the private key: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("oauth 1.0 RSA signatures need an RSA key, not %T", parsed)
	}
	return key, nil
}

func oauth1BaseURL(req *http.Request) string {
	scheme := strings.ToLower(req.URL.Scheme)
	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	host = strings.ToLower(host)
	if h, port, ok := strings.Cut(host, ":"); ok && !strings.Contains(port, ":") {
		if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
			host = h
		}
	}
	path := req.URL.EscapedPath()
	if path == "" {
		path = "/"
	}
	return scheme + "://" + host + path
}

func oauth1QueryParams(raw string) []oauth1Param {
	var params []oauth1Param
	for _, pair := range strings.Split(raw, "&") {
		if pair == "" {
			continue
		}
		key, value, _ := strings.Cut(pair, "=")
		k, err := url.QueryUnescape(key)
		if err != nil {
			k = key
		}
		v, err := url.QueryUnescape(value)
		if err != nil {
			v = value
		}
		params = append(params, oauth1Param{k, v})
	}
	return params
}

func oauth1NormalizeParams(params []oauth1Param) string {
	encoded := make([]oauth1Param, len(params))
	for i, p := range params {
		encoded[i] = oauth1Param{oauth1Encode(p.key), oauth1Encode(p.value)}
	}
	sort.SliceStable(encoded, func(i, j int) bool {
		if encoded[i].key != encoded[j].key {
			return encoded[i].key < encoded[j].key
		}
		return encoded[i].value < encoded[j].value
	})
	parts := make([]string, len(encoded))
	for i, p := range encoded {
		parts[i] = p.key + "=" + p.value
	}
	return strings.Join(parts, "&")
}

func oauth1AppendEncoded(raw string, params []oauth1Param) string {
	parts := make([]string, 0, len(params)+1)
	if raw != "" {
		parts = append(parts, raw)
	}
	for _, p := range params {
		parts = append(parts, oauth1Encode(p.key)+"="+oauth1Encode(p.value))
	}
	return strings.Join(parts, "&")
}

func oauth1Header(realm string, params []oauth1Param) string {
	parts := make([]string, 0, len(params)+1)
	if realm != "" {
		parts = append(parts, `realm="`+oauth1Encode(realm)+`"`)
	}
	for _, p := range params {
		parts = append(parts, oauth1Encode(p.key)+`="`+oauth1Encode(p.value)+`"`)
	}
	return "OAuth " + strings.Join(parts, ", ")
}

func oauth1Encode(value string) string {
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		if ('A' <= c && c <= 'Z') || ('a' <= c && c <= 'z') || ('0' <= c && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~' {
			out.WriteByte(c)
			continue
		}
		fmt.Fprintf(&out, "%%%02X", c)
	}
	return out.String()
}
