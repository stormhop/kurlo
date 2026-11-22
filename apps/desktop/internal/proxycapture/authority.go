package proxycapture

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	authorityCertFile = "kurlo-capture-ca.pem"
	authorityKeyFile  = "kurlo-capture-ca-key.pem"
	leafLifetime      = 30 * 24 * time.Hour
)

type AuthorityInfo struct {
	Exists      bool   `json:"exists"`
	Trusted     bool   `json:"trusted"`
	Path        string `json:"path"`
	Subject     string `json:"subject"`
	Fingerprint string `json:"fingerprint"`
	NotAfter    string `json:"notAfter"`
}

type Authority struct {
	cert    *x509.Certificate
	key     crypto.Signer
	leafKey *ecdsa.PrivateKey
	pem     []byte
	path    string
	mu      sync.Mutex
	leaves  map[string]*tls.Certificate
}

func AuthorityPaths(dir string) (string, string) {
	return filepath.Join(dir, authorityCertFile), filepath.Join(dir, authorityKeyFile)
}

func LoadAuthority(dir string, create bool) (*Authority, error) {
	if dir == "" {
		return nil, errors.New("certificate folder is not configured")
	}
	certPath, keyPath := AuthorityPaths(dir)
	certPEM, certErr := os.ReadFile(certPath)
	keyPEM, keyErr := os.ReadFile(keyPath)
	if errors.Is(certErr, os.ErrNotExist) && errors.Is(keyErr, os.ErrNotExist) {
		if !create {
			return nil, os.ErrNotExist
		}
		return createAuthority(dir)
	}
	if certErr != nil {
		return nil, certErr
	}
	if keyErr != nil {
		return nil, keyErr
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("Kurlo capture certificate is damaged: %w", err)
	}
	cert, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, err
	}
	if !cert.IsCA {
		return nil, errors.New("Kurlo capture certificate is not a certificate authority")
	}
	signer, ok := pair.PrivateKey.(crypto.Signer)
	if !ok {
		return nil, errors.New("Kurlo capture key cannot sign certificates")
	}
	return newAuthority(cert, signer, certPEM, certPath)
}

func createAuthority(dir string) (*Authority, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "Kurlo Capture CA " + strings.ToUpper(hex.EncodeToString(serial.Bytes())[:8]), Organization: []string{"Kurlo"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	certPath, keyPath := AuthorityPaths(dir)
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := writeExclusive(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		return nil, err
	}
	if err := writeExclusive(certPath, certPEM, 0o644); err != nil {
		os.Remove(keyPath)
		return nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return newAuthority(cert, key, certPEM, certPath)
}

func writeExclusive(path string, data []byte, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		os.Remove(path)
		return err
	}
	return file.Close()
}

func newAuthority(cert *x509.Certificate, key crypto.Signer, certPEM []byte, path string) (*Authority, error) {
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	return &Authority{cert: cert, key: key, leafKey: leafKey, pem: certPEM, path: path, leaves: map[string]*tls.Certificate{}}, nil
}

func randomSerial() (*big.Int, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, err
	}
	return serial.Add(serial, big.NewInt(1<<32)), nil
}

func (a *Authority) PEM() []byte { return append([]byte(nil), a.pem...) }

func (a *Authority) Certificate() *x509.Certificate { return a.cert }

func (a *Authority) Info() AuthorityInfo {
	sum := sha256.Sum256(a.cert.Raw)
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	return AuthorityInfo{Exists: true, Trusted: a.Trusted(), Path: a.path, Subject: a.cert.Subject.CommonName, Fingerprint: strings.Join(parts, ":"), NotAfter: a.cert.NotAfter.UTC().Format(time.RFC3339)}
}

func (a *Authority) Trusted() bool {
	leaf, err := a.issue("kurlo-trust-check.invalid")
	if err != nil {
		return false
	}
	parsed, err := x509.ParseCertificate(leaf.Certificate[0])
	if err != nil {
		return false
	}
	_, err = parsed.Verify(x509.VerifyOptions{DNSName: "kurlo-trust-check.invalid", KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
	return err == nil
}

func (a *Authority) leaf(host string) (*tls.Certificate, error) {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "" {
		return nil, errors.New("missing server name")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if cert, ok := a.leaves[host]; ok && time.Until(cert.Leaf.NotAfter) > 24*time.Hour {
		return cert, nil
	}
	cert, err := a.issue(host)
	if err != nil {
		return nil, err
	}
	a.leaves[host] = cert
	return cert, nil
}

func (a *Authority) issue(host string) (*tls.Certificate, error) {
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	notAfter := now.Add(leafLifetime)
	if notAfter.After(a.cert.NotAfter) {
		notAfter = a.cert.NotAfter
	}
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: host, Organization: []string{"Kurlo capture"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	if ip := net.ParseIP(host); ip != nil {
		template.IPAddresses = []net.IP{ip}
	} else {
		template.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, a.cert, &a.leafKey.PublicKey, a.key)
	if err != nil {
		return nil, err
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return &tls.Certificate{Certificate: [][]byte{der, a.cert.Raw}, PrivateKey: a.leafKey, Leaf: parsed}, nil
}

func NormalizeSSLHosts(hosts []string) ([]string, error) {
	seen := map[string]bool{}
	result := []string{}
	for _, raw := range hosts {
		host := strings.ToLower(strings.TrimSpace(raw))
		if host == "" {
			continue
		}
		if strings.Contains(host, "://") || strings.ContainsAny(host, "/ ") {
			return nil, fmt.Errorf("enter %q as a host name or host:port", raw)
		}
		name, port := host, ""
		if h, p, err := net.SplitHostPort(host); err == nil {
			name, port = h, p
		}
		if port != "" && port != "*" {
			if n, err := net.LookupPort("tcp", port); err != nil || n < 1 || n > 65535 {
				return nil, fmt.Errorf("enter a valid port in %q", raw)
			}
		}
		pattern := strings.TrimPrefix(name, "*.")
		if name != "*" && (pattern == "" || strings.Contains(pattern, "*")) {
			return nil, fmt.Errorf("use a wildcard only as *.example.com in %q", raw)
		}
		if !seen[host] {
			seen[host] = true
			result = append(result, host)
		}
	}
	return result, nil
}

func matchSSLHost(patterns []string, authority string) bool {
	host, port, err := net.SplitHostPort(strings.ToLower(authority))
	if err != nil {
		host, port = strings.ToLower(authority), "443"
	}
	host = strings.TrimSuffix(host, ".")
	for _, pattern := range patterns {
		name, want := pattern, "443"
		if h, p, err := net.SplitHostPort(pattern); err == nil {
			name, want = h, p
		}
		if want != "*" && want != port {
			continue
		}
		switch {
		case name == "*":
			return true
		case strings.HasPrefix(name, "*."):
			if strings.HasSuffix(host, name[1:]) {
				return true
			}
		case name == host:
			return true
		}
	}
	return false
}
