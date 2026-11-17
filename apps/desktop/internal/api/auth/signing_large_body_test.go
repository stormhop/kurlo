package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"runtime"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

func TestSigV4HashesALargeReplayableBodyWithoutBufferingIt(t *testing.T) {
	const size = 64 << 20
	open := func() (io.ReadCloser, error) { return io.NopCloser(io.LimitReader(zeroReader{}, size)), nil }
	body, _ := open()
	req, _ := http.NewRequest(http.MethodPut, "https://s3.us-east-1.amazonaws.com/bucket/key", body)
	req.GetBody = open
	req.ContentLength = size
	cfg := model.AuthConfig{AWSAccessKey: "AKID", AWSSecretKey: "SECRET", AWSRegion: "us-east-1", AWSService: "s3"}

	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	if err := Sign(req, cfg); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	runtime.ReadMemStats(&after)

	want := sha256.New()
	_, _ = io.Copy(want, io.LimitReader(zeroReader{}, size))
	if got := req.Header.Get("x-amz-content-sha256"); got != hex.EncodeToString(want.Sum(nil)) {
		t.Fatalf("x-amz-content-sha256 = %q", got)
	}
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 8<<20 {
		t.Fatalf("signing allocated %d MB for a %d MB body", allocated>>20, size>>20)
	}
}

func TestOAuth1RejectsAReplayableBodyOverTheLimit(t *testing.T) {
	previous := maxSignedPayloadBytes
	maxSignedPayloadBytes = 16
	t.Cleanup(func() { maxSignedPayloadBytes = previous })

	req, _ := http.NewRequest(http.MethodPost, "https://api.example.test/upload", strings.NewReader(strings.Repeat("x", 64)))
	cfg := model.AuthConfig{OAuth1ConsumerKey: "key", OAuth1ConsumerSecret: "secret", OAuth1SignatureMethod: "HMAC-SHA1"}
	err := SignOAuth1(req, cfg)
	if err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Fatalf("err = %v, want the size limit", err)
	}
}
