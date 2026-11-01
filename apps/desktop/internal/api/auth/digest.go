package auth

import (
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const maxDigestAuthIntBody = 32 * 1024 * 1024

type DigestTransport struct {
	username     string
	password     string
	base         http.RoundTripper
	AllowRequest func(*http.Request) bool
}

func NewDigestTransport(username, password string, base http.RoundTripper) *DigestTransport {
	return &DigestTransport{username: username, password: password, base: base}
}

func (d *DigestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if d.AllowRequest != nil && !d.AllowRequest(req) {
		return d.base.RoundTrip(req)
	}
	first := req.Clone(req.Context())
	if req.GetBody != nil {
		body, err := req.GetBody()
		if err != nil {
			return nil, fmt.Errorf("digest auth: failed to get request body: %w", err)
		}
		first.Body = body
	}

	resp, err := d.base.RoundTrip(first)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		return resp, err
	}

	wwwAuth := resp.Header.Get("WWW-Authenticate")
	if !strings.HasPrefix(strings.ToLower(wwwAuth), "digest ") {
		return resp, nil
	}
	_ = resp.Body.Close()

	challenge := parseDigestChallenge(wwwAuth[len("Digest "):])
	uri := req.URL.RequestURI()

	var entityBody []byte
	if digestNeedsEntityBody(challenge["qop"]) {
		entityBody, err = digestReadEntityBody(req)
		if err != nil {
			return nil, err
		}
	}

	authHeader, err := computeDigestAuth(d.username, d.password, req.Method, uri, challenge, entityBody)
	if err != nil {
		return nil, err
	}

	retry := req.Clone(req.Context())
	retry.Header.Set("Authorization", authHeader)
	if req.GetBody != nil {
		body, err := req.GetBody()
		if err != nil {
			return nil, fmt.Errorf("digest auth: failed to get request body for retry: %w", err)
		}
		retry.Body = body
	}

	return d.base.RoundTrip(retry)
}

func digestReadEntityBody(req *http.Request) ([]byte, error) {
	if req.Body == nil || req.Body == http.NoBody {
		return nil, nil
	}
	if req.GetBody == nil {
		return nil, fmt.Errorf("digest auth: server requires qop=auth-int but this request body cannot be re-read to sign it")
	}
	if req.ContentLength > maxDigestAuthIntBody {
		return nil, fmt.Errorf("digest auth: qop=auth-int requires hashing the whole body, which exceeds the %d MB limit", maxDigestAuthIntBody/(1024*1024))
	}
	body, err := req.GetBody()
	if err != nil {
		return nil, fmt.Errorf("digest auth: failed to get request body to sign: %w", err)
	}
	defer body.Close()
	buf, err := io.ReadAll(io.LimitReader(body, maxDigestAuthIntBody+1))
	if err != nil {
		return nil, fmt.Errorf("digest auth: failed to read request body to sign: %w", err)
	}
	if len(buf) > maxDigestAuthIntBody {
		return nil, fmt.Errorf("digest auth: qop=auth-int requires hashing the whole body, which exceeds the %d MB limit", maxDigestAuthIntBody/(1024*1024))
	}
	return buf, nil
}

type digestAlgorithm struct {
	name    string
	hash    func(string) string
	session bool
}

func digestMD5(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

func digestSHA256(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func digestSHA512256(s string) string {
	sum := sha512.Sum512_256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func resolveDigestAlgorithm(name string) (digestAlgorithm, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "MD5"
	}
	base := name
	session := false
	if idx := strings.LastIndex(strings.ToLower(name), "-sess"); idx >= 0 && strings.EqualFold(name[idx:], "-sess") {
		base = name[:idx]
		session = true
	}
	var hash func(string) string
	switch {
	case strings.EqualFold(base, "MD5"):
		hash = digestMD5
	case strings.EqualFold(base, "SHA-256"), strings.EqualFold(base, "SHA256"):
		hash = digestSHA256
	case strings.EqualFold(base, "SHA-512-256"), strings.EqualFold(base, "SHA512-256"):
		hash = digestSHA512256
	default:
		return digestAlgorithm{}, fmt.Errorf("digest auth: unsupported algorithm %q (supported: MD5, SHA-256, SHA-512-256, and their -sess variants)", name)
	}
	return digestAlgorithm{name: name, hash: hash, session: session}, nil
}

func computeDigestAuth(username, password, method, uri string, params map[string]string, entityBody []byte) (string, error) {
	realm := params["realm"]
	nonce := params["nonce"]
	qop := params["qop"]
	opaque := params["opaque"]

	algorithm, err := resolveDigestAlgorithm(params["algorithm"])
	if err != nil {
		return "", err
	}
	hash := algorithm.hash

	useAuthInt := digestNeedsEntityBody(qop)
	useAuth := hasQOPToken(qop, "auth")

	var nc, cnonce, usedQop string
	if algorithm.session || useAuth || useAuthInt {
		nc = "00000001"
		cnonce, err = digestRandom(8)
		if err != nil {
			return "", fmt.Errorf("digest auth: failed to generate cnonce: %w", err)
		}
	}

	ha1 := hash(username + ":" + realm + ":" + password)
	if algorithm.session {
		ha1 = hash(ha1 + ":" + nonce + ":" + cnonce)
	}

	ha2 := hash(method + ":" + uri)
	if useAuthInt {
		usedQop = "auth-int"
		ha2 = hash(method + ":" + uri + ":" + hash(string(entityBody)))
	} else if useAuth {
		usedQop = "auth"
	}

	var response string
	if usedQop != "" {
		response = hash(ha1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + usedQop + ":" + ha2)
	} else {
		response = hash(ha1 + ":" + nonce + ":" + ha2)
	}

	sentUsername := username
	userhash := digestChallengeFlag(params["userhash"])
	if userhash {
		sentUsername = hash(username + ":" + realm)
	}

	parts := []string{
		fmt.Sprintf(`Digest username="%s"`, sentUsername),
		fmt.Sprintf(`realm="%s"`, realm),
		fmt.Sprintf(`nonce="%s"`, nonce),
		fmt.Sprintf(`uri="%s"`, uri),
		fmt.Sprintf(`algorithm=%s`, algorithm.name),
		fmt.Sprintf(`response="%s"`, response),
	}
	if usedQop != "" {
		parts = append(parts,
			fmt.Sprintf(`qop=%s`, usedQop),
			fmt.Sprintf(`nc=%s`, nc),
			fmt.Sprintf(`cnonce="%s"`, cnonce),
		)
	}
	if opaque != "" {
		parts = append(parts, fmt.Sprintf(`opaque="%s"`, opaque))
	}
	if userhash {
		parts = append(parts, `userhash=true`)
	}
	return strings.Join(parts, ", "), nil
}

func digestNeedsEntityBody(qop string) bool {
	return !hasQOPToken(qop, "auth") && hasQOPToken(qop, "auth-int")
}

func hasQOPToken(qop, want string) bool {
	for _, token := range strings.Split(qop, ",") {
		if strings.EqualFold(strings.TrimSpace(token), want) {
			return true
		}
	}
	return false
}

func digestChallengeFlag(value string) bool {
	return strings.EqualFold(strings.TrimSpace(value), "true")
}

func parseDigestChallenge(challenge string) map[string]string {
	params := make(map[string]string)
	for len(challenge) > 0 {
		challenge = strings.TrimLeft(challenge, " \t\r\n,")
		if challenge == "" {
			break
		}
		eq := strings.IndexByte(challenge, '=')
		if eq < 0 {
			break
		}
		key := strings.TrimSpace(challenge[:eq])
		challenge = strings.TrimSpace(challenge[eq+1:])

		var val string
		if len(challenge) > 0 && challenge[0] == '"' {
			end := strings.IndexByte(challenge[1:], '"')
			if end < 0 {
				break
			}
			val = challenge[1 : end+1]
			challenge = challenge[end+2:]
		} else {
			end := strings.IndexByte(challenge, ',')
			if end < 0 {
				val = challenge
				challenge = ""
			} else {
				val = strings.TrimSpace(challenge[:end])
				challenge = challenge[end+1:]
			}
		}
		params[key] = val
	}
	return params
}

func digestRandom(n int) (string, error) {
	b := make([]byte, (n+1)/2)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b)[:n], nil
}
