package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"aead.dev/minisign"
)

func signMessageHashed(t *testing.T, privateKey minisign.PrivateKey, message []byte) []byte {
	t.Helper()
	reader := minisign.NewReader(bytes.NewReader(message))
	if _, err := io.Copy(io.Discard, reader); err != nil {
		t.Fatal(err)
	}
	return reader.Sign(privateKey)
}

func TestUpdateMetadataRequestDoesNotUseGitHubAPIHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "" {
			t.Fatalf("expected no Authorization header, got %q", got)
		}
		if got := r.Header.Get("X-GitHub-Api-Version"); got != "" {
			t.Fatalf("expected no GitHub API version header, got %q", got)
		}
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Fatalf("expected JSON accept header, got %q", got)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	resp, err := updateMetadataRequest(context.Background(), http.MethodGet, server.URL)
	if err != nil {
		t.Fatalf("updateMetadataRequest failed: %v", err)
	}
	_ = resp.Body.Close()
}

func TestUpdateMetadataRequestTimesOut(t *testing.T) {
	previous := updateMetadataHTTPClient
	updateMetadataHTTPClient = &http.Client{Timeout: 20 * time.Millisecond}
	t.Cleanup(func() { updateMetadataHTTPClient = previous })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	start := time.Now()
	resp, err := updateMetadataRequest(context.Background(), http.MethodGet, server.URL)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err == nil {
		t.Fatal("expected update metadata request to time out")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("metadata timeout took too long: %s", elapsed)
	}
}

func TestLatestManifestURLUsesReleaseAssetDownload(t *testing.T) {
	originalRepo := githubRepo
	defer func() { githubRepo = originalRepo }()
	githubRepo = "owner/project"

	got := latestManifestURL()
	want := "https://github.com/owner/project/releases/latest/download/latest.json"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestFetchUpdateManifestParsesLatestJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/latest.json" {
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{
			"version": "0.1.26",
			"notes": "Bug fixes",
			"published_at": "2026-05-14T10:00:00Z",
			"platforms": {
				"darwin-universal": {
					"url": "https://github.com/stormhop/kurlo/releases/download/v0.1.26/kurlo-darwin-universal",
					"sha256": "abc123"
				}
			}
		}`)
	}))
	defer server.Close()

	manifest, err := fetchUpdateManifest(context.Background(), server.URL+"/latest.json")
	if err != nil {
		t.Fatalf("fetchUpdateManifest failed: %v", err)
	}
	if manifest.Version != "0.1.26" || manifest.Notes != "Bug fixes" || manifest.PublishedAt == "" {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
	if got := manifest.Platforms["darwin-universal"].SHA256; got != "abc123" {
		t.Fatalf("unexpected checksum %q", got)
	}
}

func TestUpdateInfoFromManifestUsesPlatformKey(t *testing.T) {
	target := platformKey()
	manifest := &updateManifest{
		Version:     "v0.1.26",
		Notes:       "Bug fixes",
		PublishedAt: "2026-05-14T10:00:00Z",
		Platforms: map[string]updatePlatform{
			target: {
				URL:    "https://github.com/stormhop/kurlo/releases/download/v0.1.26/kurlo-binary",
				SHA256: "abc123",
			},
		},
	}
	info, err := updateInfoFromManifest(manifest)
	if err != nil {
		t.Fatalf("updateInfoFromManifest failed: %v", err)
	}
	if info.Version != "0.1.26" || info.DownloadURL != manifest.Platforms[target].URL || info.SHA256 != "abc123" {
		t.Fatalf("unexpected update info: %+v", info)
	}
	if info.AssetName != "kurlo-binary" {
		t.Fatalf("expected asset name from URL, got %q", info.AssetName)
	}
}

func TestUpdateInfoFromManifestRequiresChecksum(t *testing.T) {
	target := platformKey()
	manifest := &updateManifest{
		Version: "0.1.26",
		Platforms: map[string]updatePlatform{
			target: {URL: "https://github.com/stormhop/kurlo/releases/download/v0.1.26/kurlo-binary"},
		},
	}
	if _, err := updateInfoFromManifest(manifest); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("expected checksum error, got %v", err)
	}
}

func TestVerifySHA256(t *testing.T) {
	data := []byte("kurlo update")
	file, err := os.CreateTemp("", "kurlo-checksum-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	if err := verifySHA256(file.Name(), fmt.Sprintf("%x", sum)); err != nil {
		t.Fatalf("expected checksum to verify: %v", err)
	}
	if err := verifySHA256(file.Name(), "deadbeef"); err == nil {
		t.Fatal("expected checksum mismatch")
	}
}

func TestFriendlyUpdateErrorHidesServiceDetails(t *testing.T) {
	err := errors.New(`Get "https://github.com/stormhop/kurlo/releases/latest/download/latest.json": net/http: TLS handshake timeout`)
	got := friendlyUpdateError(err, "check for updates")
	if got == "" {
		t.Fatal("expected friendly update error")
	}
	if containsAny(got, []string{"github", "stormhop", "kurlo/releases", "latest.json"}) {
		t.Fatalf("expected service details to be hidden, got %q", got)
	}
	if !containsAny(got, []string{"timed out", "internet connection"}) {
		t.Fatalf("expected timeout guidance, got %q", got)
	}
}

func TestFriendlyUpdateErrorClasses(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "timeout", err: context.DeadlineExceeded, want: "timed out"},
		{name: "permission", err: errors.New("permission denied"), want: "permission"},
		{name: "asset", err: errors.New("no release asset found for kurlo-darwin-universal"), want: "compatible update package"},
		{name: "checksum", err: errors.New("update checksum mismatch"), want: "verified"},
		{name: "generic", err: http.ErrServerClosed, want: "try again"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := friendlyUpdateError(tt.err, "install the update")
			if !containsAny(got, []string{tt.want}) {
				t.Fatalf("expected %q to contain %q", got, tt.want)
			}
		})
	}
}

func TestSemverIsNewerTreatsDevBuildAsOutdated(t *testing.T) {
	if !semverIsNewer("0.1.16", "dev") {
		t.Fatal("expected dev builds to be treated as outdated")
	}
}

func TestVerifyUpdateSignatureEmptyPublicKeyFailsClosed(t *testing.T) {
	if err := verifyUpdateSignature(context.Background(), "/does/not/exist", "", ""); !errors.Is(err, errUpdateSignatureRequired) {
		t.Fatalf("expected errUpdateSignatureRequired, got: %v", err)
	}
	if err := verifyUpdateSignature(context.Background(), "/does/not/exist", "https://example.invalid/x.minisig", ""); !errors.Is(err, errUpdateSignatureRequired) {
		t.Fatalf("expected errUpdateSignatureRequired with sig URL, got: %v", err)
	}
}

func allowAllTrustedURLsForTest(t *testing.T) {
	t.Helper()
	prev := trustedReleaseURLOverride
	trustedReleaseURLOverride = func(*url.URL) bool { return true }
	t.Cleanup(func() { trustedReleaseURLOverride = prev })
}

func TestVerifyUpdateSignatureRequiresSignatureWhenPublicKeySet(t *testing.T) {
	publicKey, _, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rawPublicKey, err := publicKey.MarshalText()
	if err != nil {
		t.Fatal(err)
	}
	err = verifyUpdateSignature(context.Background(), "/does/not/exist", "", string(rawPublicKey))
	if err == nil || !strings.Contains(err.Error(), "signature missing") {
		t.Fatalf("expected signature missing error, got: %v", err)
	}
}

func TestVerifyUpdateSignatureAcceptsValidSignature(t *testing.T) {
	allowAllTrustedURLsForTest(t)
	publicKey, privateKey, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rawPublicKey, err := publicKey.MarshalText()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "kurlo-binary")
	payload := []byte("update payload for signature test")
	if err := os.WriteFile(binaryPath, payload, 0o644); err != nil {
		t.Fatal(err)
	}
	signature := signMessageHashed(t, privateKey, payload)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(signature)
	}))
	defer server.Close()
	if err := verifyUpdateSignature(context.Background(), binaryPath, server.URL+"/kurlo.minisig", string(rawPublicKey)); err != nil {
		t.Fatalf("expected valid signature to verify, got: %v", err)
	}
}

func TestVerifyUpdateSignatureRejectsTamperedBinary(t *testing.T) {
	allowAllTrustedURLsForTest(t)
	publicKey, privateKey, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rawPublicKey, err := publicKey.MarshalText()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "kurlo-binary")
	original := []byte("original payload")
	signature := minisign.Sign(privateKey, original)
	tampered := []byte("tampered payload")
	if err := os.WriteFile(binaryPath, tampered, 0o644); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(signature)
	}))
	defer server.Close()
	err = verifyUpdateSignature(context.Background(), binaryPath, server.URL+"/kurlo.minisig", string(rawPublicKey))
	if err == nil || !strings.Contains(err.Error(), "signature mismatch") {
		t.Fatalf("expected signature mismatch error for tampered binary, got: %v", err)
	}
}

func TestVerifyUpdateSignatureRejectsForeignKey(t *testing.T) {
	allowAllTrustedURLsForTest(t)
	_, signingKey, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	verifyingPub, _, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rawVerifyingPub, err := verifyingPub.MarshalText()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "kurlo-binary")
	payload := []byte("payload signed by attacker key")
	if err := os.WriteFile(binaryPath, payload, 0o644); err != nil {
		t.Fatal(err)
	}
	signature := minisign.Sign(signingKey, payload)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(signature)
	}))
	defer server.Close()
	err = verifyUpdateSignature(context.Background(), binaryPath, server.URL+"/kurlo.minisig", string(rawVerifyingPub))
	if err == nil || !strings.Contains(err.Error(), "signature mismatch") {
		t.Fatalf("expected signature mismatch for foreign key, got: %v", err)
	}
}

func TestUpdateInfoFromManifestCarriesSignatureURL(t *testing.T) {
	target := platformKey()
	manifest := &updateManifest{
		Version: "0.1.26",
		Platforms: map[string]updatePlatform{
			target: {
				URL:       "https://example.invalid/kurlo-binary",
				SHA256:    "abc123",
				Signature: "https://example.invalid/kurlo-binary.minisig",
			},
		},
	}
	info, err := updateInfoFromManifest(manifest)
	if err != nil {
		t.Fatalf("updateInfoFromManifest failed: %v", err)
	}
	if info.SignatureURL != "https://example.invalid/kurlo-binary.minisig" {
		t.Fatalf("expected signature URL to be carried through, got %q", info.SignatureURL)
	}
}

func containsAny(source string, needles []string) bool {
	source = strings.ToLower(source)
	for _, needle := range needles {
		if strings.Contains(source, strings.ToLower(needle)) {
			return true
		}
	}
	return false
}

func TestSemverIsNewerKeepsStableBuildsOffPrereleases(t *testing.T) {
	if semverIsNewer("2.6.0-rc1", "2.5.1") {
		t.Fatal("a stable build must not be offered a prerelease")
	}
	if !semverIsNewer("2.6.0-rc2", "2.6.0-rc1") {
		t.Fatal("a prerelease build should move to the next prerelease")
	}
	if !semverIsNewer("2.6.0", "2.6.0-rc1") {
		t.Fatal("a prerelease build should move to the final release")
	}
}

type manifestRoundTripper string

func (body manifestRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(string(body))),
		Request:    r,
	}, nil
}

func TestCheckForUpdateIsQuietWhenTheReleaseHasNoAssetForThisPlatform(t *testing.T) {
	previousVersion := appVersion
	appVersion = "2.5.1"
	previousClient := updateMetadataHTTPClient
	updateMetadataHTTPClient = &http.Client{Transport: manifestRoundTripper(`{"version":"2.5.2","platforms":{"plan9-mips":{"url":"https://github.com/x/y/releases/download/v2.5.2/k","sha256":"00"}}}`)}
	t.Cleanup(func() {
		appVersion = previousVersion
		updateMetadataHTTPClient = previousClient
	})

	result := NewApp().CheckForUpdate()
	if result.Error != "" || result.Info != nil {
		t.Fatalf("a release without this platform's asset is not an update and not an error, got %+v", result)
	}
}
