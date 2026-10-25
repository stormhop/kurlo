package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"time"
)

const (
	bundleManifestKey   = "darwin-universal-app"
	bundleArchiveName   = "kurlo-darwin-universal.app.zip"
	bundleRepairTimeout = 5 * time.Minute
	lsregisterPath      = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
)

var (
	errUpdateBundleInvalid  = errors.New("update bundle is not a Kurlo application")
	errUpdateBundleMismatch = errors.New("update bundle carries a different version")
)

func runningAppBundle() string {
	if goruntime.GOOS != "darwin" {
		return ""
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return appBundleFromExecutable(exe)
}

func appBundleFromExecutable(exe string) string {
	idx := strings.Index(exe, ".app/Contents/MacOS/")
	if idx == -1 {
		return ""
	}
	return exe[:idx+len(".app")]
}

func isBundleArchive(assetName string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSpace(assetName)), ".app.zip")
}

func updatePlatformKeys(goos, bundlePath, appImagePath, platform string) []string {
	if goos == "darwin" && bundlePath != "" {
		return []string{bundleManifestKey, platform}
	}
	if goos == "linux" && appImagePath != "" {
		return []string{appImageManifestKey(platform)}
	}
	return []string{platform}
}

func applyBundleUpdate(archivePath, bundlePath, expectedVersion string) error {
	stage, err := os.MkdirTemp(bundlePath, ".kurlo-update-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err := extractBundleArchive(archivePath, stage); err != nil {
		return err
	}
	newContents, err := stagedBundleContents(stage)
	if err != nil {
		return err
	}
	if expected := strings.TrimPrefix(strings.TrimSpace(expectedVersion), "v"); expected != "" {
		version, err := plistShortVersion(filepath.Join(newContents, "Info.plist"))
		if err != nil {
			return err
		}
		if version != expected {
			return fmt.Errorf("%w: expected %s, got %s", errUpdateBundleMismatch, expected, version)
		}
	}
	if err := swapBundleContents(bundlePath, newContents, stage); err != nil {
		return err
	}
	refreshBundleRegistration(bundlePath)
	return nil
}

func extractBundleArchive(archivePath, dest string) error {
	out, err := exec.Command("ditto", "-x", "-k", archivePath, dest).CombinedOutput()
	if err != nil {
		return fmt.Errorf("unpack update: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func stagedBundleContents(stage string) (string, error) {
	entries, err := os.ReadDir(stage)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasSuffix(entry.Name(), ".app") {
			continue
		}
		contents := filepath.Join(stage, entry.Name(), "Contents")
		if !regularFileExists(filepath.Join(contents, "Info.plist")) {
			continue
		}
		executables, err := os.ReadDir(filepath.Join(contents, "MacOS"))
		if err != nil || len(executables) == 0 {
			continue
		}
		return contents, nil
	}
	return "", errUpdateBundleInvalid
}

func regularFileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func swapBundleContents(bundlePath, newContents, stage string) error {
	current := filepath.Join(bundlePath, "Contents")
	retired := filepath.Join(stage, "retired-Contents")
	if err := exchangePaths(newContents, current); err == nil {
		_ = os.Rename(newContents, retired)
		return nil
	}
	if err := os.Rename(current, retired); err != nil {
		return err
	}
	if err := os.Rename(newContents, current); err != nil {
		if restoreErr := os.Rename(retired, current); restoreErr != nil {
			return fmt.Errorf("%w (the previous version could not be restored: %v)", err, restoreErr)
		}
		return err
	}
	return nil
}

func refreshBundleRegistration(bundlePath string) {
	now := time.Now()
	_ = os.Chtimes(bundlePath, now, now)
	if regularFileExists(lsregisterPath) {
		_ = exec.Command(lsregisterPath, "-f", bundlePath).Run()
	}
}

func plistShortVersion(plistPath string) (string, error) {
	out, err := exec.Command("plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", plistPath).Output()
	if err != nil {
		return "", fmt.Errorf("read bundle version: %w", err)
	}
	return strings.TrimPrefix(strings.TrimSpace(string(out)), "v"), nil
}

func bundleArchiveURLs(repo, version string) (string, string) {
	archive := fmt.Sprintf("https://github.com/%s/releases/download/v%s/%s", repo, strings.TrimPrefix(version, "v"), bundleArchiveName)
	return archive, archive + ".minisig"
}

func repairStaleBundle(ctx context.Context) error {
	if isDevBuild() {
		return nil
	}
	bundle := runningAppBundle()
	if bundle == "" {
		return nil
	}
	current := strings.TrimPrefix(strings.TrimSpace(appVersion), "v")
	installed, err := plistShortVersion(filepath.Join(bundle, "Contents", "Info.plist"))
	if err != nil {
		return err
	}
	if installed == current {
		return nil
	}
	archiveURL, signatureURL := bundleArchiveURLs(githubRepo, current)
	archive, err := downloadUpdateAsset(ctx, archiveURL)
	if err != nil {
		return err
	}
	defer os.Remove(archive)
	if err := verifyUpdateSignature(ctx, archive, signatureURL, updatePublicKey); err != nil {
		return err
	}
	if err := applyBundleUpdate(archive, bundle, current); err != nil {
		return err
	}
	log.Printf("kurlo: refreshed the app bundle from %s to %s", installed, current)
	return nil
}

func repairStaleBundleInBackground(ctx context.Context) {
	if goruntime.GOOS != "darwin" || isDevBuild() {
		return
	}
	go func() {
		repairCtx, cancel := context.WithTimeout(updateBaseContext(ctx), bundleRepairTimeout)
		defer cancel()
		if err := repairStaleBundle(repairCtx); err != nil {
			log.Printf("kurlo: could not refresh the app bundle: %v", err)
		}
	}()
}
