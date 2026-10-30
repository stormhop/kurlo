package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	goruntime "runtime"
	"strings"
	"time"

	"aead.dev/minisign"
	"github.com/Masterminds/semver/v3"

	"github.com/minio/selfupdate"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

var githubRepo = "stormhop/kurlo"

var updatePublicKey = "RWTEfMAu7tDsMMu7Q9SCX5HgAEsBo5KZJzwvbIcP/ZKb1YyTg+Csj+9P"

const (
	updateMetadataTimeout = 15 * time.Second
	updateDownloadTimeout = 10 * time.Minute
	maxSignatureSize      = 8 * 1024
	maxUpdateDownloadSize = 512 * 1024 * 1024
)

var (
	errUpdateSignatureMissing  = errors.New("update signature missing")
	errUpdateSignatureMismatch = errors.New("update signature mismatch")
	errUpdateChecksumMismatch  = errors.New("update checksum mismatch")
	errUpdateVersionRollback   = errors.New("update version is not newer than the installed version")
	errUpdateURLNotTrusted     = errors.New("update url is not on the trusted releases host")
	errUpdateSignatureRequired = errors.New("update public key is not embedded in this build")
	errUpdateNoReleaseAsset    = errors.New("no release asset found")
)

var (
	updateMetadataHTTPClient = newUpdateHTTPClient(updateMetadataTimeout)
	updateDownloadHTTPClient = newUpdateHTTPClient(updateDownloadTimeout)
)

func newUpdateHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("stopped after 10 redirects")
			}
			if req.URL.Scheme != "https" {
				return fmt.Errorf("refusing redirect to non-https url: %s", req.URL.Redacted())
			}
			if !isTrustedReleaseURL(req.URL) {
				return fmt.Errorf("refusing redirect outside releases host: %s", req.URL.Redacted())
			}
			return nil
		},
	}
}

var trustedReleaseURLOverride func(*url.URL) bool

func isTrustedReleaseURL(u *url.URL) bool {
	if trustedReleaseURLOverride != nil {
		return trustedReleaseURLOverride(u)
	}
	if u == nil || u.Scheme != "https" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	switch host {
	case "github.com":
		prefix := "/" + strings.Trim(githubRepo, "/") + "/"
		return strings.HasPrefix(u.Path, prefix)
	case "objects.githubusercontent.com", "release-assets.githubusercontent.com":
		return true
	}
	return false
}

type updateManifest struct {
	Version     string                    `json:"version"`
	Notes       string                    `json:"notes"`
	PublishedAt string                    `json:"published_at"`
	Platforms   map[string]updatePlatform `json:"platforms"`
}

type updatePlatform struct {
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	Signature string `json:"signature,omitempty"`
}

func platformKey() string {
	os := goruntime.GOOS
	arch := goruntime.GOARCH
	if os == "darwin" {
		return "darwin-universal"
	}
	return fmt.Sprintf("%s-%s", os, arch)
}

func semverIsNewer(latest, current string) bool {
	current = strings.TrimSpace(strings.TrimPrefix(current, "v"))
	if current == "" || current == "dev" {
		return true
	}
	l, lerr := semver.NewVersion(strings.TrimPrefix(latest, "v"))
	c, cerr := semver.NewVersion(current)
	if lerr != nil || cerr != nil {
		return false
	}
	if l.Prerelease() != "" && c.Prerelease() == "" {
		return false
	}
	return l.GreaterThan(c)
}

func latestManifestURL() string {
	return fmt.Sprintf("https://github.com/%s/releases/latest/download/latest.json", githubRepo)
}

func updateMetadataRequest(ctx context.Context, method, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	return updateMetadataHTTPClient.Do(req)
}

func fetchLatestManifest(ctx context.Context) (*updateManifest, error) {
	return fetchUpdateManifest(ctx, latestManifestURL())
}

func fetchUpdateManifest(ctx context.Context, manifestURL string) (*updateManifest, error) {
	resp, err := updateMetadataRequest(ctx, http.MethodGet, manifestURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("update metadata returned %d", resp.StatusCode)
	}
	var manifest updateManifest
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&manifest); err != nil {
		return nil, err
	}
	return &manifest, nil
}

func assetNameFromURL(rawURL, fallback string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fallback
	}
	name := path.Base(parsed.Path)
	if name == "." || name == "/" || name == "" {
		return fallback
	}
	return name
}

func checkForUpdate(ctx context.Context) (*model.UpdateInfo, error) {
	manifest, err := fetchLatestManifest(ctx)
	if err != nil {
		return nil, err
	}
	return updateInfoFromManifest(manifest)
}

func updateInfoFromManifest(manifest *updateManifest) (*model.UpdateInfo, error) {
	info, err := updateInfoFromManifestFor(manifest, updatePlatformKeys(goruntime.GOOS, runningAppBundle(), runningAppImage(), platformKey()))
	if err != nil {
		return nil, err
	}
	return withPackagedInstall(info, runningAsPackagedApp(), goruntime.GOARCH), nil
}

func updateInfoFromManifestFor(manifest *updateManifest, keys []string) (*model.UpdateInfo, error) {
	target := keys[len(keys)-1]
	var platform updatePlatform
	found := false
	for _, key := range keys {
		candidate, ok := manifest.Platforms[key]
		if ok && strings.TrimSpace(candidate.URL) != "" {
			target, platform, found = key, candidate, true
			break
		}
	}
	downloadURL := strings.TrimSpace(platform.URL)
	if !found {
		return nil, fmt.Errorf("%w for %s", errUpdateNoReleaseAsset, target)
	}
	checksum := strings.TrimSpace(platform.SHA256)
	if checksum == "" {
		return nil, fmt.Errorf("update checksum missing for %s", target)
	}
	signatureURL := strings.TrimSpace(platform.Signature)
	version := strings.TrimPrefix(manifest.Version, "v")
	if version == "" {
		return nil, errors.New("update metadata missing version")
	}
	return &model.UpdateInfo{
		Version:      version,
		ReleaseNotes: manifest.Notes,
		PublishedAt:  manifest.PublishedAt,
		DownloadURL:  downloadURL,
		AssetName:    assetNameFromURL(downloadURL, target),
		SHA256:       checksum,
		SignatureURL: signatureURL,
	}, nil
}

func verifySHA256(path string, expected string) error {
	expected = strings.TrimSpace(expected)
	if expected == "" {
		return errUpdateChecksumMismatch
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if !strings.EqualFold(actual, expected) {
		return errUpdateChecksumMismatch
	}
	return nil
}

func fetchUpdateSignature(ctx context.Context, signatureURL string) ([]byte, error) {
	parsed, err := url.Parse(signatureURL)
	if err != nil {
		return nil, fmt.Errorf("invalid signature url: %w", err)
	}
	if !isTrustedReleaseURL(parsed) {
		return nil, errUpdateURLNotTrusted
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, signatureURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/plain, application/octet-stream")
	resp, err := updateMetadataHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("signature download returned %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, maxSignatureSize))
}

func verifyUpdateSignature(ctx context.Context, binaryPath, signatureURL, rawPublicKey string) error {
	rawPublicKey = strings.TrimSpace(rawPublicKey)
	if rawPublicKey == "" {
		return errUpdateSignatureRequired
	}
	if strings.TrimSpace(signatureURL) == "" {
		return errUpdateSignatureMissing
	}
	var publicKey minisign.PublicKey
	if err := publicKey.UnmarshalText([]byte(rawPublicKey)); err != nil {
		return fmt.Errorf("invalid embedded update public key: %w", err)
	}
	signature, err := fetchUpdateSignature(ctx, signatureURL)
	if err != nil {
		return err
	}
	file, err := os.Open(binaryPath)
	if err != nil {
		return err
	}
	defer file.Close()
	reader := minisign.NewReader(file)
	if _, err := io.Copy(io.Discard, reader); err != nil {
		return err
	}
	if !reader.Verify(publicKey, signature) {
		return errUpdateSignatureMismatch
	}
	return nil
}

func resolveTrustedUpdateInfo(ctx context.Context) (*model.UpdateInfo, error) {
	info, err := checkForUpdate(ctx)
	if err != nil {
		return nil, err
	}
	return info, nil
}

func downloadAndApply(ctx context.Context, info *model.UpdateInfo) error {
	if runningAsPackagedApp() {
		return errUpdateManagedByPackage
	}
	if !isDevBuild() && !semverIsNewer(info.Version, appVersion) {
		return errUpdateVersionRollback
	}
	tmpPath, err := downloadUpdateAsset(ctx, info.DownloadURL)
	if err != nil {
		return err
	}
	defer os.Remove(tmpPath)

	if err := verifySHA256(tmpPath, info.SHA256); err != nil {
		return err
	}
	if err := verifyUpdateSignature(ctx, tmpPath, info.SignatureURL, updatePublicKey); err != nil {
		return err
	}
	if isBundleArchive(info.AssetName) {
		bundle := runningAppBundle()
		if bundle == "" {
			return errUpdateBundleInvalid
		}
		return applyBundleUpdate(tmpPath, bundle, info.Version)
	}
	if isAppImageAsset(info.AssetName) {
		return applyAppImageUpdate(tmpPath, runningAppImage())
	}
	file, err := os.Open(tmpPath)
	if err != nil {
		return err
	}
	defer file.Close()
	checksum, decodeErr := hex.DecodeString(strings.TrimSpace(info.SHA256))
	opts := selfupdate.Options{}
	if decodeErr == nil {
		opts.Checksum = checksum
	}
	return selfupdate.Apply(file, opts)
}

func downloadUpdateAsset(ctx context.Context, downloadURL string) (string, error) {
	parsed, err := url.Parse(downloadURL)
	if err != nil {
		return "", fmt.Errorf("invalid download url: %w", err)
	}
	if !isTrustedReleaseURL(parsed) {
		return "", errUpdateURLNotTrusted
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/octet-stream")

	resp, err := updateDownloadHTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download returned %d", resp.StatusCode)
	}

	tmp, err := os.CreateTemp("", "kurlo-update-*")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	if _, err := io.Copy(tmp, io.LimitReader(resp.Body, maxUpdateDownloadSize+1)); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return "", err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return "", err
	}
	if fi, statErr := os.Stat(tmpPath); statErr == nil && fi.Size() > maxUpdateDownloadSize {
		_ = os.Remove(tmpPath)
		return "", fmt.Errorf("update download exceeds %d bytes", maxUpdateDownloadSize)
	}
	return tmpPath, nil
}

func relaunchSelf() {
	exe := relaunchExecutable(launchExecutable, currentExecutable())
	if exe == "" {
		os.Exit(0)
	}
	if goruntime.GOOS == "darwin" {
		if idx := strings.Index(exe, ".app/Contents/MacOS/"); idx != -1 {
			appPath := exe[:idx+4]
			cmd := exec.Command("open", "-n", appPath)
			hideCmdWindow(cmd)
			_ = cmd.Start()
			os.Exit(0)
		}
	}
	_ = relaunchCommand(relaunchTarget(goruntime.GOOS, exe, runningAppImage()), os.Getpid()).Start()
	os.Exit(0)
}

func friendlyUpdateError(err error, action string) string {
	if err == nil {
		return ""
	}
	base := "Could not " + action + "."
	if errors.Is(err, context.DeadlineExceeded) {
		return base + " The request timed out. Check your internet connection and try again."
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return base + " Kurlo could not reach the update service. Check your internet connection and try again."
	}
	switch {
	case errors.Is(err, errUpdateSignatureMissing),
		errors.Is(err, errUpdateSignatureMismatch),
		errors.Is(err, errUpdateChecksumMismatch),
		errors.Is(err, errUpdateSignatureRequired):
		return base + " The downloaded update could not be verified. Please try again later."
	case errors.Is(err, errUpdateURLNotTrusted):
		return base + " The update server returned an unexpected location. Please try again later."
	case errors.Is(err, errUpdateVersionRollback):
		return base + " The available update is not newer than the installed version."
	case errors.Is(err, errUpdateAppImageNotWritable):
		return base + " Kurlo cannot replace its AppImage file in this folder. Download the new AppImage from kurlo.dev and replace the old one."
	case errors.Is(err, errUpdateManagedByPackage):
		return base + " Kurlo is installed from the Windows app package, which Windows keeps read-only. Download the new package and open it to update."
	}
	lower := strings.ToLower(err.Error())
	switch {
	case strings.Contains(lower, "timeout"), strings.Contains(lower, "deadline exceeded"):
		return base + " The request timed out. Check your internet connection and try again."
	case strings.Contains(lower, "no such host"), strings.Contains(lower, "network is unreachable"):
		return base + " Kurlo could not reach the update service. Check your internet connection and try again."
	case strings.Contains(lower, "certificate"), strings.Contains(lower, "tls"):
		return base + " A secure connection could not be established. Check your network settings and try again."
	case strings.Contains(lower, "permission"), strings.Contains(lower, "access denied"):
		return base + " Kurlo does not have permission to replace the app. Try again after restarting the app."
	case strings.Contains(lower, "no release asset"):
		return base + " No compatible update package is available for this device yet."
	case strings.Contains(lower, "checksum"), strings.Contains(lower, "signature"):
		return base + " The downloaded update could not be verified. Please try again later."
	}
	return base + " Please try again in a moment."
}
