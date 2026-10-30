package auth

import (
	"encoding/hex"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestCanonicalQueryString(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "empty",
			in:   "",
			want: "",
		},
		{
			name: "single pair already sorted",
			in:   "a=1",
			want: "a=1",
		},
		{
			name: "out of order keys",
			in:   "b=2&a=1",
			want: "a=1&b=2",
		},
		{
			name: "duplicate keys sorted by value",
			in:   "k=2&k=1",
			want: "k=1&k=2",
		},
		{
			name: "space encoded as percent20 not plus",
			in:   "q=hello+world",
			want: "q=hello%20world",
		},
		{
			name: "reserved char encoded",
			in:   "q=a/b",
			want: "q=a%2Fb",
		},
		{
			name: "unreserved chars preserved",
			in:   "q=A-Z_a-z.0-9~",
			want: "q=A-Z_a-z.0-9~",
		},
		{
			name: "empty value preserved",
			in:   "a=&b=1",
			want: "a=&b=1",
		},
		{
			name: "key only (no equals)",
			in:   "flag",
			want: "flag=",
		},
		{
			name: "uppercase hex on re-encoding",
			in:   "q=a%2fb",
			want: "q=a%2Fb",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := canonicalQueryString(tt.in)
			if got != tt.want {
				t.Fatalf("canonicalQueryString(%q):\n  got:  %q\n  want: %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestSignWithoutSessionToken(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://example.execute-api.us-east-1.amazonaws.com/prod/items", nil)
	cfg := model.AuthConfig{AWSAccessKey: "AKID", AWSSecretKey: "SECRET", AWSRegion: "us-east-1", AWSService: "execute-api"}
	if err := Sign(req, cfg); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if got := req.Header.Get("x-amz-security-token"); got != "" {
		t.Errorf("no session token was configured, but one was sent: %q", got)
	}
	if strings.Contains(req.Header.Get("Authorization"), "x-amz-security-token") {
		t.Errorf("SignedHeaders should not list the token: %s", req.Header.Get("Authorization"))
	}
}

func TestSignWithSessionToken(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://example.execute-api.us-east-1.amazonaws.com/prod/items", nil)
	cfg := model.AuthConfig{
		AWSAccessKey:    "AKID",
		AWSSecretKey:    "SECRET",
		AWSSessionToken: "FwoGZXIvYXdzEJr//////////wEaDExAMPLETOKEN",
		AWSRegion:       "us-east-1",
		AWSService:      "execute-api",
	}
	if err := Sign(req, cfg); err != nil {
		t.Fatalf("Sign: %v", err)
	}

	if got := req.Header.Get("x-amz-security-token"); got != cfg.AWSSessionToken {
		t.Errorf("x-amz-security-token = %q, want the configured token", got)
	}
	authz := req.Header.Get("Authorization")
	if !strings.Contains(authz, "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token") {
		t.Errorf("the token must be part of SignedHeaders, got: %s", authz)
	}
}

func TestSignSessionTokenChangesSignature(t *testing.T) {
	sigFor := func(cfg model.AuthConfig) string {
		req, _ := http.NewRequest(http.MethodGet, "https://s3.us-east-1.amazonaws.com/bucket/key", nil)
		if err := Sign(req, cfg); err != nil {
			t.Fatalf("Sign: %v", err)
		}
		authz := req.Header.Get("Authorization")
		idx := strings.Index(authz, "Signature=")
		if idx < 0 {
			t.Fatalf("no signature in %q", authz)
		}
		return authz[idx+len("Signature="):]
	}
	base := model.AuthConfig{AWSAccessKey: "AKID", AWSSecretKey: "SECRET", AWSRegion: "us-east-1", AWSService: "s3"}
	withToken := base
	withToken.AWSSessionToken = "SESSIONTOKEN"

	if sigFor(base) == sigFor(withToken) {
		t.Error("adding a session token must change the signature — it is signed, not just sent")
	}
}

func TestSignSessionTokenCanonicalRequest(t *testing.T) {
	const token = "SESSIONTOKEN"
	req, _ := http.NewRequest(http.MethodGet, "https://s3.us-east-1.amazonaws.com/bucket/key", nil)
	cfg := model.AuthConfig{
		AWSAccessKey: "AKID", AWSSecretKey: "SECRET", AWSSessionToken: token,
		AWSRegion: "us-east-1", AWSService: "s3",
	}
	if err := Sign(req, cfg); err != nil {
		t.Fatalf("Sign: %v", err)
	}

	dateLong := req.Header.Get("x-amz-date")
	dateShort := dateLong[:8]
	bodyHash := req.Header.Get("x-amz-content-sha256")
	signedHeadersStr := "host;x-amz-content-sha256;x-amz-date;x-amz-security-token"

	canonicalHeaders := "host:" + req.URL.Host + "\n" +
		"x-amz-content-sha256:" + bodyHash + "\n" +
		"x-amz-date:" + dateLong + "\n" +
		"x-amz-security-token:" + token + "\n"
	canonicalRequest := strings.Join([]string{
		"GET", "/bucket/key", "", canonicalHeaders, signedHeadersStr, bodyHash,
	}, "\n")

	credentialScope := dateShort + "/us-east-1/s3/aws4_request"
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256", dateLong, credentialScope,
		hex.EncodeToString(hashSHA256([]byte(canonicalRequest))),
	}, "\n")
	key := hmacSHA256(hmacSHA256(hmacSHA256(hmacSHA256([]byte("AWS4SECRET"), []byte(dateShort)), []byte("us-east-1")), []byte("s3")), []byte("aws4_request"))
	want := hex.EncodeToString(hmacSHA256(key, []byte(stringToSign)))

	if !strings.HasSuffix(req.Header.Get("Authorization"), "Signature="+want) {
		t.Errorf("signature does not match a recomputed canonical request\n got:  %s\n want signature %s", req.Header.Get("Authorization"), want)
	}
}

func TestSignIncludesAmzHeaders(t *testing.T) {
	req, _ := http.NewRequest(http.MethodPost, "https://dynamodb.us-east-1.amazonaws.com/", strings.NewReader(`{}`))
	req.Header.Set("X-Amz-Target", "DynamoDB_20120810.ListTables")
	req.Header.Set("Content-Type", "application/x-amz-json-1.0")
	cfg := model.AuthConfig{AWSAccessKey: "AKID", AWSSecretKey: "SECRET", AWSRegion: "us-east-1", AWSService: "dynamodb"}
	if err := Sign(req, cfg); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	authz := req.Header.Get("Authorization")
	want := "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-target"
	if !strings.Contains(authz, want) {
		t.Errorf("SignedHeaders must cover x-amz-* and content-type.\ngot:  %s\nwant to contain: %s", authz, want)
	}
}

func TestSignUsesOverriddenHost(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://10.0.0.5/bucket/key", nil)
	req.Host = "s3.us-east-1.amazonaws.com"
	cfg := model.AuthConfig{AWSAccessKey: "AKID", AWSSecretKey: "SECRET", AWSRegion: "us-east-1", AWSService: "s3"}
	if err := Sign(req, cfg); err != nil {
		t.Fatalf("Sign: %v", err)
	}

	dateLong := req.Header.Get("x-amz-date")
	bodyHash := req.Header.Get("x-amz-content-sha256")
	canonicalHeaders := "host:s3.us-east-1.amazonaws.com\n" +
		"x-amz-content-sha256:" + bodyHash + "\n" +
		"x-amz-date:" + dateLong + "\n"
	canonicalRequest := strings.Join([]string{
		"GET", "/bucket/key", "", canonicalHeaders, "host;x-amz-content-sha256;x-amz-date", bodyHash,
	}, "\n")
	credentialScope := dateLong[:8] + "/us-east-1/s3/aws4_request"
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256", dateLong, credentialScope,
		hex.EncodeToString(hashSHA256([]byte(canonicalRequest))),
	}, "\n")
	key := hmacSHA256(hmacSHA256(hmacSHA256(hmacSHA256([]byte("AWS4SECRET"), []byte(dateLong[:8])), []byte("us-east-1")), []byte("s3")), []byte("aws4_request"))
	want := hex.EncodeToString(hmacSHA256(key, []byte(stringToSign)))

	if !strings.HasSuffix(req.Header.Get("Authorization"), "Signature="+want) {
		t.Errorf("the overridden Host must be the one signed, got: %s", req.Header.Get("Authorization"))
	}
}

func TestSignSmallStreamingBodyIsStillHashed(t *testing.T) {
	pr, pw := io.Pipe()
	go func() {
		_, _ = pw.Write([]byte("streamed payload"))
		_ = pw.Close()
	}()
	req, _ := http.NewRequest(http.MethodPost, "https://execute-api.us-east-1.amazonaws.com/prod", pr)
	if req.GetBody != nil {
		t.Fatal("test premise: a pipe body must not be replayable")
	}
	cfg := model.AuthConfig{AWSAccessKey: "AKID", AWSSecretKey: "SECRET", AWSRegion: "us-east-1", AWSService: "execute-api"}
	if err := Sign(req, cfg); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	want := hex.EncodeToString(hashSHA256([]byte("streamed payload")))
	if got := req.Header.Get("x-amz-content-sha256"); got != want {
		t.Errorf("x-amz-content-sha256 = %q, want the body hash %q", got, want)
	}
	body, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != "streamed payload" {
		t.Errorf("body = %q, want it restored after signing", body)
	}
}

func TestSignLargeStreamingBodyStaysUnbuffered(t *testing.T) {
	previous := maxSignedPayloadBytes
	maxSignedPayloadBytes = 16
	t.Cleanup(func() { maxSignedPayloadBytes = previous })

	const payload = "this payload is longer than the signing threshold"
	pr, pw := io.Pipe()
	go func() {
		_, _ = pw.Write([]byte(payload))
		_ = pw.Close()
	}()
	req, _ := http.NewRequest(http.MethodPut, "https://s3.us-east-1.amazonaws.com/bucket/key", pr)
	cfg := model.AuthConfig{AWSAccessKey: "AKID", AWSSecretKey: "SECRET", AWSRegion: "us-east-1", AWSService: "s3"}
	if err := Sign(req, cfg); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if got := req.Header.Get("x-amz-content-sha256"); got != unsignedPayload {
		t.Errorf("x-amz-content-sha256 = %q, want %q", got, unsignedPayload)
	}
	if !strings.Contains(req.Header.Get("Authorization"), "SignedHeaders=host;x-amz-content-sha256;x-amz-date") {
		t.Errorf("unexpected SignedHeaders: %s", req.Header.Get("Authorization"))
	}
	body, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != payload {
		t.Errorf("body = %q, want every byte to survive signing (%q)", body, payload)
	}
}

func TestSignHashesReplayableBody(t *testing.T) {
	req, _ := http.NewRequest(http.MethodPost, "https://execute-api.us-east-1.amazonaws.com/prod", strings.NewReader(`{"a":1}`))
	cfg := model.AuthConfig{AWSAccessKey: "AKID", AWSSecretKey: "SECRET", AWSRegion: "us-east-1", AWSService: "execute-api"}
	if err := Sign(req, cfg); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	want := hex.EncodeToString(hashSHA256([]byte(`{"a":1}`)))
	if got := req.Header.Get("x-amz-content-sha256"); got != want {
		t.Errorf("x-amz-content-sha256 = %q, want the body hash %q", got, want)
	}
	body, _ := io.ReadAll(req.Body)
	if string(body) != `{"a":1}` {
		t.Errorf("body = %q, want it still readable after signing", body)
	}
}

func TestCanonicalHeaderValueCollapsesWhitespace(t *testing.T) {
	if got := canonicalHeaderValue("  a   b  "); got != "a b" {
		t.Errorf("canonicalHeaderValue = %q, want %q", got, "a b")
	}
}

func TestSignJoinsRepeatedAmzHeaders(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://s3.us-east-1.amazonaws.com/bucket", nil)
	req.Header.Add("X-Amz-Meta-Tag", "one")
	req.Header.Add("X-Amz-Meta-Tag", "two")
	cfg := model.AuthConfig{AWSAccessKey: "AKID", AWSSecretKey: "SECRET", AWSRegion: "us-east-1", AWSService: "s3"}
	if err := Sign(req, cfg); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	block := canonicalHeaderBlock(req.Header, signedHeaderNames(req.Header), "s3.us-east-1.amazonaws.com")
	if !strings.Contains(block, "x-amz-meta-tag:one,two\n") {
		t.Errorf("repeated header must be comma-joined, got:\n%s", block)
	}
}

func TestCanonicalURIForNonS3DoubleEncodes(t *testing.T) {
	cases := []struct {
		name    string
		service string
		raw     string
		want    string
	}{
		{"root", "execute-api", "https://api.test/", "/"},
		{"no path at all", "execute-api", "https://api.test", "/"},
		{"plain segments", "execute-api", "https://api.test/v1/items", "/v1/items"},
		{
			name:    "lambda arn in the path",
			service: "lambda",
			raw:     "https://lambda.test/2015-03-31/functions/arn:aws:lambda:us-east-1:1:function:fn/invocations",
			want:    "/2015-03-31/functions/arn%253Aaws%253Alambda%253Aus-east-1%253A1%253Afunction%253Afn/invocations",
		},
		{"space in a segment", "execute-api", "https://api.test/my%20item", "/my%2520item"},
		{"unreserved characters stay put", "execute-api", "https://api.test/a-b_c.d~e", "/a-b_c.d~e"},
		{"relative components are removed", "execute-api", "https://api.test/a/./b/../c", "/a/c"},
		{"duplicate slashes collapse", "execute-api", "https://api.test/a//b", "/a/b"},
		{"a trailing slash is kept", "execute-api", "https://api.test/a/b/", "/a/b/"},
		{"climbing past the root stops there", "execute-api", "https://api.test/../..", "/"},
		{"s3 encodes once", "s3", "https://bucket.test/my%20key", "/my%20key"},
		{"s3 keeps relative components", "s3", "https://bucket.test/a/./b", "/a/./b"},
		{"s3 is matched case-insensitively", "S3", "https://bucket.test/my%20key", "/my%20key"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			u, err := url.Parse(tc.raw)
			if err != nil {
				t.Fatalf("parse %q: %v", tc.raw, err)
			}
			if got := canonicalURIFor(tc.service, u); got != tc.want {
				t.Errorf("canonicalURIFor(%q, %q) = %q, want %q", tc.service, tc.raw, got, tc.want)
			}
		})
	}
}

func TestSignSendsQuerySpacesTheWayTheyAreSigned(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://s3.us-east-1.amazonaws.com/bucket?name=My+Org&tag=a%2Bb", nil)
	cfg := model.AuthConfig{AWSAccessKey: "AKID", AWSSecretKey: "SECRET", AWSRegion: "us-east-1", AWSService: "s3"}
	if err := Sign(req, cfg); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if req.URL.RawQuery != "name=My%20Org&tag=a%2Bb" {
		t.Fatalf("the wire query must match the canonical one, got %q", req.URL.RawQuery)
	}
	if canonicalQueryString(req.URL.RawQuery) != "name=My%20Org&tag=a%2Bb" {
		t.Fatalf("canonical query drifted: %q", canonicalQueryString(req.URL.RawQuery))
	}
}
