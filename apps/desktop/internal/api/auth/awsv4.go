package auth

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const unsignedPayload = "UNSIGNED-PAYLOAD"

var maxSignedPayloadBytes int64 = 32 * 1024 * 1024

func Sign(req *http.Request, cfg model.AuthConfig) error {
	if cfg.AWSRegion == "" || cfg.AWSService == "" {
		return fmt.Errorf("aws auth requires region and service to be set")
	}

	if strings.Contains(req.URL.RawQuery, "+") {
		req.URL.RawQuery = strings.ReplaceAll(req.URL.RawQuery, "+", "%20")
	}

	now := time.Now().UTC()
	dateShort := now.Format("20060102")
	dateLong := now.Format("20060102T150405Z")

	bodyHash, err := payloadHash(req)
	if err != nil {
		return err
	}

	req.Header.Set("x-amz-date", dateLong)
	req.Header.Set("x-amz-content-sha256", bodyHash)
	if cfg.AWSSessionToken != "" {
		req.Header.Set("x-amz-security-token", cfg.AWSSessionToken)
	}

	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	req.Header.Set("Host", host)

	signedHeaders := signedHeaderNames(req.Header)
	canonicalHeaders := canonicalHeaderBlock(req.Header, signedHeaders, host)
	signedHeadersStr := strings.Join(signedHeaders, ";")

	canonicalURI := canonicalURIFor(cfg.AWSService, req.URL)

	canonicalRequest := strings.Join([]string{
		req.Method,
		canonicalURI,
		canonicalQueryString(req.URL.RawQuery),
		canonicalHeaders,
		signedHeadersStr,
		bodyHash,
	}, "\n")

	credentialScope := strings.Join([]string{dateShort, cfg.AWSRegion, cfg.AWSService, "aws4_request"}, "/")
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		dateLong,
		credentialScope,
		hex.EncodeToString(hashSHA256([]byte(canonicalRequest))),
	}, "\n")

	signingKey := hmacSHA256(
		hmacSHA256(
			hmacSHA256(
				hmacSHA256([]byte("AWS4"+cfg.AWSSecretKey), []byte(dateShort)),
				[]byte(cfg.AWSRegion),
			),
			[]byte(cfg.AWSService),
		),
		[]byte("aws4_request"),
	)
	signature := hex.EncodeToString(hmacSHA256(signingKey, []byte(stringToSign)))

	req.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		cfg.AWSAccessKey, credentialScope, signedHeadersStr, signature,
	))
	return nil
}

func signedHeaderNames(headers http.Header) []string {
	seen := map[string]struct{}{"host": {}}
	for name := range headers {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "x-amz-") || lower == "content-type" {
			seen[lower] = struct{}{}
		}
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func canonicalHeaderBlock(headers http.Header, names []string, host string) string {
	var out strings.Builder
	for _, name := range names {
		out.WriteString(name)
		out.WriteByte(':')
		if name == "host" {
			out.WriteString(canonicalHeaderValue(host))
		} else {
			values := headers.Values(http.CanonicalHeaderKey(name))
			for i, value := range values {
				if i > 0 {
					out.WriteByte(',')
				}
				out.WriteString(canonicalHeaderValue(value))
			}
		}
		out.WriteByte('\n')
	}
	return out.String()
}

func canonicalHeaderValue(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func canonicalURIFor(service string, u *url.URL) string {
	if strings.EqualFold(strings.TrimSpace(service), "s3") {
		if escaped := u.EscapedPath(); escaped != "" {
			return escaped
		}
		return "/"
	}
	normalized := normalizeAWSPath(u.Path)
	if normalized == "/" {
		return "/"
	}
	segments := strings.Split(normalized, "/")
	for i, segment := range segments {
		segments[i] = awsEscapeQueryComponent(awsEscapeQueryComponent(segment))
	}
	return strings.Join(segments, "/")
}

func normalizeAWSPath(path string) string {
	if path == "" {
		return "/"
	}
	trailingSlash := strings.HasSuffix(path, "/")
	var segments []string
	for _, segment := range strings.Split(path, "/") {
		switch segment {
		case "", ".":
			continue
		case "..":
			if len(segments) > 0 {
				segments = segments[:len(segments)-1]
			}
		default:
			segments = append(segments, segment)
		}
	}
	if len(segments) == 0 {
		return "/"
	}
	normalized := "/" + strings.Join(segments, "/")
	if trailingSlash {
		normalized += "/"
	}
	return normalized
}

func payloadHash(req *http.Request) (string, error) {
	if req.Body == nil || req.Body == http.NoBody {
		return hex.EncodeToString(hashSHA256(nil)), nil
	}
	if req.GetBody != nil {
		bodyData, err := ReadBodyBytes(req)
		if err != nil {
			return "", err
		}
		return hex.EncodeToString(hashSHA256(bodyData)), nil
	}

	head, err := io.ReadAll(io.LimitReader(req.Body, maxSignedPayloadBytes+1))
	if err != nil {
		return "", err
	}
	if int64(len(head)) <= maxSignedPayloadBytes {
		rest := req.Body
		_ = rest.Close()
		req.Body = io.NopCloser(bytes.NewReader(head))
		req.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(head)), nil
		}
		req.ContentLength = int64(len(head))
		return hex.EncodeToString(hashSHA256(head)), nil
	}

	req.Body = struct {
		io.Reader
		io.Closer
	}{
		Reader: io.MultiReader(bytes.NewReader(head), req.Body),
		Closer: req.Body,
	}
	return unsignedPayload, nil
}

func ReadBodyBytes(req *http.Request) ([]byte, error) {
	if req.GetBody != nil {
		body, err := req.GetBody()
		if err != nil {
			return nil, err
		}
		defer body.Close()
		return io.ReadAll(body)
	}
	if req.Body == nil || req.Body == http.NoBody {
		return nil, nil
	}
	data, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	_ = req.Body.Close()
	req.Body = io.NopCloser(bytes.NewReader(data))
	req.GetBody = func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(data)), nil
	}
	req.ContentLength = int64(len(data))
	return data, nil
}

func hashSHA256(data []byte) []byte {
	h := sha256.Sum256(data)
	return h[:]
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func canonicalQueryString(raw string) string {
	if raw == "" {
		return ""
	}
	type kv struct{ name, value string }
	pairs := make([]kv, 0)
	for _, pair := range strings.Split(raw, "&") {
		if pair == "" {
			continue
		}
		var name, value string
		if eq := strings.IndexByte(pair, '='); eq >= 0 {
			name = pair[:eq]
			value = pair[eq+1:]
		} else {
			name = pair
		}
		pairs = append(pairs, kv{
			name:  awsEscapeQueryComponent(decodeQueryComponent(name)),
			value: awsEscapeQueryComponent(decodeQueryComponent(value)),
		})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].name != pairs[j].name {
			return pairs[i].name < pairs[j].name
		}
		return pairs[i].value < pairs[j].value
	})
	var b strings.Builder
	for i, p := range pairs {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(p.name)
		b.WriteByte('=')
		b.WriteString(p.value)
	}
	return b.String()
}

func decodeQueryComponent(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '+':
			b.WriteByte(' ')
		case c == '%' && i+2 < len(s) && isHexByte(s[i+1]) && isHexByte(s[i+2]):
			b.WriteByte(unhexByte(s[i+1])<<4 | unhexByte(s[i+2]))
			i += 2
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func awsEscapeQueryComponent(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hexUpper(c >> 4))
		b.WriteByte(hexUpper(c & 0x0f))
	}
	return b.String()
}

func isHexByte(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

func unhexByte(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10
	}
	return 0
}

func hexUpper(n byte) byte {
	if n < 10 {
		return '0' + n
	}
	return 'A' + (n - 10)
}
