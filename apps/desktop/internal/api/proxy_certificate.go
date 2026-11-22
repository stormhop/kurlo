package api

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/proxycapture"
)

var errTrustUnsupported = errors.New("Kurlo cannot change the trusted certificates on this system. Export the certificate and add it to your system or browser trust store")

var runTrustCommand = func(ctx context.Context, name string, args ...string) error {
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return errors.New(message)
	}
	return nil
}

func captureAuthorityDir() string {
	return filepath.Join(requestStoreDir(), "capture-ca")
}

func captureAuthorityInfo(create bool) (proxycapture.AuthorityInfo, *proxycapture.Authority, error) {
	authority, err := proxycapture.LoadAuthority(captureAuthorityDir(), create)
	if errors.Is(err, os.ErrNotExist) {
		path, _ := proxycapture.AuthorityPaths(captureAuthorityDir())
		return proxycapture.AuthorityInfo{Path: path}, nil, nil
	}
	if err != nil {
		return proxycapture.AuthorityInfo{}, nil, err
	}
	return authority.Info(), authority, nil
}

func (a *App) ProxyCertificate() (proxycapture.AuthorityInfo, error) {
	info, _, err := captureAuthorityInfo(false)
	return info, err
}

func (a *App) ProxyCertificatePEM() (string, error) {
	_, authority, err := captureAuthorityInfo(true)
	if err != nil {
		return "", err
	}
	return string(authority.PEM()), nil
}

func (a *App) TrustProxyCertificate() (proxycapture.AuthorityInfo, error) {
	info, authority, err := captureAuthorityInfo(true)
	if err != nil {
		return info, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	switch goruntime.GOOS {
	case "darwin":
		err = runTrustCommand(ctx, "security", "add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", loginKeychain(), info.Path)
	case "windows":
		err = runTrustCommand(ctx, "certutil", "-user", "-addstore", "Root", info.Path)
	default:
		err = errTrustUnsupported
	}
	if err != nil {
		return info, fmt.Errorf("could not trust the Kurlo certificate: %w", err)
	}
	return authority.Info(), nil
}

func (a *App) UntrustProxyCertificate() (proxycapture.AuthorityInfo, error) {
	info, authority, err := captureAuthorityInfo(false)
	if err != nil || authority == nil {
		return info, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	switch goruntime.GOOS {
	case "darwin":
		err = runTrustCommand(ctx, "security", "remove-trusted-cert", info.Path)
		if err == nil {
			sum := sha1.Sum(authority.Certificate().Raw)
			err = runTrustCommand(ctx, "security", "delete-certificate", "-Z", strings.ToUpper(hex.EncodeToString(sum[:])), loginKeychain())
		}
	case "windows":
		err = runTrustCommand(ctx, "certutil", "-user", "-delstore", "Root", authority.Certificate().SerialNumber.Text(16))
	default:
		err = errTrustUnsupported
	}
	if err != nil {
		return info, fmt.Errorf("could not remove the Kurlo certificate: %w", err)
	}
	return authority.Info(), nil
}

func loginKeychain() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Keychains", "login.keychain-db")
}

type ProxyPlatformSupport struct {
	SystemProxy      bool `json:"systemProxy"`
	TrustCertificate bool `json:"trustCertificate"`
	IdentifyProcess  bool `json:"identifyProcess"`
}

func (a *App) ProxyPlatformSupport() ProxyPlatformSupport {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	trust := goruntime.GOOS == "darwin" || goruntime.GOOS == "windows"
	return ProxyPlatformSupport{SystemProxy: newSystemProxy().Supported(ctx), TrustCertificate: trust, IdentifyProcess: goruntime.GOOS == "darwin"}
}

func (a *App) SetProxySSLHosts(hosts []string) (proxycapture.Status, error) {
	status, err := a.capture.SetSSLHosts(hosts)
	return a.withSystemProxy(status), err
}
