package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func repoRootForTest(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repository root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "scripts", "make-latest-json.py")); err != nil {
		t.Skipf("release scripts not available from this checkout: %v", err)
	}
	return root
}

func requirePython(t *testing.T) string {
	t.Helper()
	for _, name := range []string{"python3", "python"} {
		if path, err := exec.LookPath(name); err == nil {
			return path
		}
	}
	t.Skip("python is not installed")
	return ""
}

func buildFakeRelease(t *testing.T, withSignatures bool) (dir string, checksums map[string]string) {
	t.Helper()
	dir = t.TempDir()
	checksums = map[string]string{}
	assets := map[string]string{
		"darwin-universal":     "kurlo-darwin-universal",
		"darwin-universal-app": "kurlo-darwin-universal.app.zip",
		"windows-amd64":        "kurlo-9.9.9-windows-amd64-portable.exe",
		"windows-arm64":        "kurlo-9.9.9-windows-arm64-portable.exe",
		"linux-amd64":          "kurlo-linux-amd64",
		"linux-amd64-appimage": "kurlo-9.9.9-linux-amd64.AppImage",
	}
	for platform, asset := range assets {
		body := []byte("fake binary for " + platform)
		if err := os.WriteFile(filepath.Join(dir, asset), body, 0644); err != nil {
			t.Fatalf("write asset %s: %v", asset, err)
		}
		sum := sha256.Sum256(body)
		checksums[platform] = hex.EncodeToString(sum[:])
		if withSignatures {
			if err := os.WriteFile(filepath.Join(dir, asset+".minisig"), []byte("untrusted comment: fake\n"), 0644); err != nil {
				t.Fatalf("write signature for %s: %v", asset, err)
			}
		}
	}
	return dir, checksums
}

func generateManifest(t *testing.T, releaseDir string, extraArgs ...string) *updateManifest {
	t.Helper()
	root := repoRootForTest(t)
	python := requirePython(t)

	args := append([]string{
		filepath.Join(root, "scripts", "make-latest-json.py"),
		"--release-dir", releaseDir,
		"--tag", "v9.9.9",
		"--repo", "stormhop/kurlo",
		"--platforms", "darwin-universal,darwin-universal-app,windows-amd64,windows-arm64,linux-amd64,linux-amd64-appimage",
	}, extraArgs...)

	output, err := exec.Command(python, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("make-latest-json.py failed: %v\n%s", err, output)
	}

	data, err := os.ReadFile(filepath.Join(releaseDir, "latest.json"))
	if err != nil {
		t.Fatalf("read generated manifest: %v", err)
	}
	var manifest updateManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatalf("the updater cannot decode the generated manifest: %v\n%s", err, data)
	}
	return &manifest
}

func TestGeneratedManifestDecodesWithTheUpdaterParser(t *testing.T) {
	releaseDir, checksums := buildFakeRelease(t, true)

	manifest := generateManifest(t, releaseDir, "--require-signature")

	if manifest.Version != "9.9.9" {
		t.Fatalf("expected the tag without its v prefix, got %q", manifest.Version)
	}
	if manifest.PublishedAt == "" {
		t.Fatal("expected a published_at timestamp")
	}
	if manifest.Notes == "" {
		t.Fatal("expected notes to fall back to something rather than being absent")
	}
	for platform, want := range checksums {
		entry, ok := manifest.Platforms[platform]
		if !ok {
			t.Fatalf("platform %q is missing from the manifest", platform)
		}
		if entry.SHA256 != want {
			t.Fatalf("platform %q: checksum %q does not match the asset (%q)", platform, entry.SHA256, want)
		}
		if !strings.HasPrefix(entry.URL, "https://github.com/stormhop/kurlo/releases/download/v9.9.9/") {
			t.Fatalf("platform %q: unexpected download URL %q", platform, entry.URL)
		}
		if entry.Signature == "" {
			t.Fatalf("platform %q: expected a signature URL", platform)
		}
	}
}

func TestGeneratedManifestCarriesThisPlatformsKey(t *testing.T) {
	releaseDir, checksums := buildFakeRelease(t, true)

	manifest := generateManifest(t, releaseDir, "--require-signature")

	info, err := updateInfoFromManifest(manifest)
	if err != nil {
		t.Fatalf("the updater could not find %q in a manifest the release would publish: %v", platformKey(), err)
	}
	if info.Version != "9.9.9" {
		t.Fatalf("unexpected version %q", info.Version)
	}
	if info.SHA256 != checksums[platformKey()] {
		t.Fatalf("checksum for %q does not match the built asset", platformKey())
	}
	if info.SignatureURL == "" {
		t.Fatal("expected the signature URL to survive into the update info")
	}
	if info.AssetName == "" || strings.Contains(info.AssetName, "/") {
		t.Fatalf("expected a bare asset name, got %q", info.AssetName)
	}
}

func TestGeneratedManifestPointsAppImagesAtTheVersionedAppImage(t *testing.T) {
	releaseDir, checksums := buildFakeRelease(t, true)

	manifest := generateManifest(t, releaseDir, "--require-signature")

	info, err := updateInfoFromManifestFor(manifest, updatePlatformKeys("linux", "", "/home/u/Kurlo.AppImage", "linux-amd64"))
	if err != nil {
		t.Fatalf("an AppImage found no update in a manifest the release would publish: %v", err)
	}
	if info.AssetName != "kurlo-9.9.9-linux-amd64.AppImage" || !isAppImageAsset(info.AssetName) {
		t.Fatalf("expected the versioned AppImage, got %q", info.AssetName)
	}
	if info.SHA256 != checksums["linux-amd64-appimage"] {
		t.Fatal("the AppImage checksum does not match the built asset")
	}
	if !strings.HasSuffix(info.SignatureURL, "/kurlo-9.9.9-linux-amd64.AppImage.minisig") {
		t.Fatalf("expected the AppImage signature, got %q", info.SignatureURL)
	}
}

func TestGeneratedManifestPointsWindowsAtThePortableApp(t *testing.T) {
	releaseDir, checksums := buildFakeRelease(t, true)

	manifest := generateManifest(t, releaseDir, "--require-signature")

	for _, arch := range []string{"amd64", "arm64"} {
		info, err := updateInfoFromManifestFor(manifest, updatePlatformKeys("windows", "", `C:\Users\u\Kurlo.exe`, "windows-"+arch))
		if err != nil {
			t.Fatalf("windows-%s found no update: %v", arch, err)
		}
		want := "kurlo-9.9.9-windows-" + arch + "-portable.exe"
		if info.AssetName != want || !strings.HasSuffix(info.DownloadURL, "/v9.9.9/"+want) {
			t.Fatalf("windows-%s update = %q (%s), want %s", arch, info.AssetName, info.DownloadURL, want)
		}
		if info.SHA256 != checksums["windows-"+arch] || !strings.HasSuffix(info.SignatureURL, "/"+want+".minisig") {
			t.Fatalf("windows-%s checksum or signature does not match the portable app", arch)
		}
	}
}

func TestGeneratedManifestIsRejectedWhenASignatureIsMissing(t *testing.T) {
	releaseDir, _ := buildFakeRelease(t, false)
	root := repoRootForTest(t)
	python := requirePython(t)

	output, err := exec.Command(python,
		filepath.Join(root, "scripts", "make-latest-json.py"),
		"--release-dir", releaseDir,
		"--tag", "v9.9.9",
		"--repo", "stormhop/kurlo",
		"--platforms", "darwin-universal",
		"--require-signature",
	).CombinedOutput()

	if err == nil {
		t.Fatalf("expected the generator to fail without signatures, output:\n%s", output)
	}
	if !strings.Contains(string(output), "missing signature") {
		t.Fatalf("expected the reason to name the missing signature, got:\n%s", output)
	}
	if _, statErr := os.Stat(filepath.Join(releaseDir, "latest.json")); statErr == nil {
		t.Fatal("a failed run must not leave a manifest behind")
	}
}

func TestGeneratedManifestFailsOnAMissingAsset(t *testing.T) {
	releaseDir, _ := buildFakeRelease(t, true)
	if err := os.Remove(filepath.Join(releaseDir, "kurlo-linux-amd64")); err != nil {
		t.Fatalf("remove asset: %v", err)
	}
	root := repoRootForTest(t)
	python := requirePython(t)

	output, err := exec.Command(python,
		filepath.Join(root, "scripts", "make-latest-json.py"),
		"--release-dir", releaseDir,
		"--tag", "v9.9.9",
		"--repo", "stormhop/kurlo",
		"--platforms", "darwin-universal,windows-amd64,linux-amd64",
	).CombinedOutput()

	if err == nil {
		t.Fatalf("expected the generator to fail on a missing asset, output:\n%s", output)
	}
	if !strings.Contains(string(output), "missing asset") {
		t.Fatalf("expected the reason to name the missing asset, got:\n%s", output)
	}
}
