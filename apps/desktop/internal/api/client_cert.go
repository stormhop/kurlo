package api

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type clientCertConfig struct {
	certPath string
	keyPath  string
	password string
}

func clientCertConfigFor(req model.HttpRequest) clientCertConfig {
	return clientCertConfig{
		certPath: strings.TrimSpace(req.ClientCertPath),
		keyPath:  strings.TrimSpace(req.ClientKeyPath),
		password: req.ClientKeyPassword,
	}
}

func (c clientCertConfig) enabled() bool {
	return c.certPath != ""
}

func (c clientCertConfig) cacheKey() string {
	if !c.enabled() {
		return ""
	}
	return c.certPath + "\x00" + c.keyPath + "\x00" + c.password + "\x00" + clientCertFileStamp(c.certPath) + "\x00" + clientCertFileStamp(c.keyPath)
}

func clientCertFileStamp(path string) string {
	if path == "" {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil {
		return "missing"
	}
	return strconv.FormatInt(info.ModTime().UnixNano(), 10) + ":" + strconv.FormatInt(info.Size(), 10)
}

type cachedClientCert struct {
	cert tls.Certificate
	err  error
}

type clientCertCache struct {
	mu      sync.Mutex
	entries map[string]cachedClientCert
}

func newClientCertCache() *clientCertCache {
	return &clientCertCache{entries: make(map[string]cachedClientCert)}
}

var clientCerts = newClientCertCache()

func (c *clientCertCache) load(config clientCertConfig) (tls.Certificate, error) {
	key := config.cacheKey()

	c.mu.Lock()
	if entry, ok := c.entries[key]; ok {
		c.mu.Unlock()
		return entry.cert, entry.err
	}
	c.mu.Unlock()

	cert, err := loadClientCertificate(config)

	c.mu.Lock()
	c.entries[key] = cachedClientCert{cert: cert, err: err}
	c.mu.Unlock()
	return cert, err
}

func (c *clientCertCache) forget(config clientCertConfig) {
	c.mu.Lock()
	delete(c.entries, config.cacheKey())
	c.mu.Unlock()
}

func loadClientCertificate(config clientCertConfig) (tls.Certificate, error) {
	certPEM, err := os.ReadFile(config.certPath)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("client certificate: %w", err)
	}
	keyPath := config.keyPath
	if keyPath == "" {
		keyPath = config.certPath
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("client key: %w", err)
	}

	if config.password != "" {
		decrypted, decErr := decryptPEMPrivateKey(keyPEM, config.password)
		if decErr != nil {
			return tls.Certificate{}, decErr
		}
		keyPEM = decrypted
	}

	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		if config.password == "" && pemHasEncryptedBlock(keyPEM) {
			return tls.Certificate{}, fmt.Errorf("client key is encrypted — enter its password")
		}
		return tls.Certificate{}, fmt.Errorf("client certificate/key pair is invalid: %w", err)
	}
	return cert, nil
}

func decryptPEMPrivateKey(keyPEM []byte, password string) ([]byte, error) {
	block, _ := pem.Decode(keyPEM)
	if block == nil {
		return nil, fmt.Errorf("client key is not valid PEM")
	}
	//nolint:staticcheck
	if !x509.IsEncryptedPEMBlock(block) {
		if pemLooksPKCS8Encrypted(block) {
			return nil, fmt.Errorf("this key uses PKCS#8 encryption, which Kurlo cannot decrypt — convert it with: openssl pkcs8 -in key.pem -out key.dec.pem")
		}
		return keyPEM, nil
	}
	//nolint:staticcheck
	decrypted, err := x509.DecryptPEMBlock(block, []byte(password))
	if err != nil {
		return nil, fmt.Errorf("could not decrypt client key — check the password")
	}
	return pem.EncodeToMemory(&pem.Block{Type: block.Type, Bytes: decrypted}), nil
}

func pemHasEncryptedBlock(keyPEM []byte) bool {
	block, _ := pem.Decode(keyPEM)
	if block == nil {
		return false
	}
	//nolint:staticcheck
	return x509.IsEncryptedPEMBlock(block) || pemLooksPKCS8Encrypted(block)
}

func pemLooksPKCS8Encrypted(block *pem.Block) bool {
	return block != nil && strings.Contains(block.Type, "ENCRYPTED PRIVATE KEY")
}
