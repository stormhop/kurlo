package api

import (
	"crypto/rand"
	"path/filepath"
	"testing"
)

func isolatedRequestStoreCodec(t *testing.T) *requestStoreCodec {
	t.Helper()
	key := make([]byte, requestStoreKeySize)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("generate test store key: %v", err)
	}
	load := func() ([]byte, error) { return append([]byte(nil), key...), nil }
	return &requestStoreCodec{provideKey: load, loadKey: load}
}

func fileRequestStoreCodec(t *testing.T) (*requestStoreCodec, *requestStoreKeyState, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), requestStoreKeyFileName)
	keys := &requestStoreKeyState{}
	load := func() ([]byte, error) {
		material, err := loadRequestStoreFileKeyMaterialAt(path)
		if err != nil {
			return nil, err
		}
		return decodeRequestStoreKey(material)
	}
	initialize := func(create bool) ([]byte, error) {
		if !create {
			return load()
		}
		return loadOrCreateRequestStoreKeyUsing(load, func(material string) error {
			return writeFileAtomic(path, []byte(material))
		})
	}
	codec := &requestStoreCodec{
		provideKey: func() ([]byte, error) { return keys.load(true, initialize) },
		loadKey:    func() ([]byte, error) { return keys.load(false, initialize) },
	}
	codec.fallback = func(nonce, ciphertext []byte) ([]byte, error) {
		return decryptRequestStorePayloadWithFallbackKey(nonce, ciphertext, func() (string, error) { return loadRequestStoreFileKeyMaterialAt(path) }, keys.remember)
	}
	return codec, keys, path
}
