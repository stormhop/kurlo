package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

func TestRequestStorePayloadRoundTrip(t *testing.T) {
	t.Parallel()
	codec := isolatedRequestStoreCodec(t)

	plaintext := `{"hello":"world","n":42}`
	enc, err := codec.encrypt([]byte(plaintext))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if !isEncryptedRequestStore(enc) {
		t.Fatal("encrypted payload should be recognized as an encrypted envelope")
	}
	dec, err := codec.decrypt(enc)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if string(dec) != plaintext {
		t.Fatalf("round trip mismatch: got %q want %q", dec, plaintext)
	}
}

func TestRequestStorePayloadRandomNonce(t *testing.T) {
	t.Parallel()
	codec := isolatedRequestStoreCodec(t)
	e1, err := codec.encrypt([]byte("same"))
	if err != nil {
		t.Fatalf("encrypt 1: %v", err)
	}
	e2, err := codec.encrypt([]byte("same"))
	if err != nil {
		t.Fatalf("encrypt 2: %v", err)
	}
	if bytes.Equal(e1, e2) {
		t.Fatal("encrypting the same plaintext twice should differ (random nonce)")
	}
}

func TestRequestStorePayloadTamperDetected(t *testing.T) {
	t.Parallel()
	codec := isolatedRequestStoreCodec(t)
	enc, err := codec.encrypt([]byte("secret data"))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	tampered := bytes.Replace(enc, []byte(`"ciphertext": "`), []byte(`"ciphertext": "A`), 1)
	if _, err := codec.decrypt(tampered); err == nil {
		t.Fatal("expected decrypt of tampered payload to fail authentication")
	}
}

func TestDecryptDoesNotCreateReplacementKeyWhenExistingKeyIsMissing(t *testing.T) {
	t.Parallel()
	codec, keys, keyPath := fileRequestStoreCodec(t)

	key := bytes.Repeat([]byte{9}, requestStoreKeySize)
	gcm, err := requestStoreCipher(key)
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	enc, err := json.MarshalIndent(requestStoreEnvelope{
		Version:    requestStoreEnvelopeVersion,
		Algorithm:  requestStoreAlgorithm,
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
		Ciphertext: base64.StdEncoding.EncodeToString(gcm.Seal(nil, nonce, []byte("secret data"), nil)),
	}, "", "  ")
	if err != nil {
		t.Fatalf("marshal encrypted envelope: %v", err)
	}
	if err := os.Remove(keyPath); err != nil && !os.IsNotExist(err) {
		t.Fatalf("remove key file: %v", err)
	}
	keys.remember(nil)

	if _, err := codec.decrypt(enc); err == nil {
		t.Fatal("expected decrypt to fail when the existing key is missing")
	}
	if _, err := os.Stat(keyPath); !os.IsNotExist(err) {
		t.Fatalf("decrypt should not create a replacement key, stat err=%v", err)
	}
}

func TestCachedRequestStoreKeyMemoizes(t *testing.T) {
	t.Parallel()
	codec, _, keyPath := fileRequestStoreCodec(t)

	k1, err := codec.provideKey()
	if err != nil {
		t.Fatalf("first load: %v", err)
	}
	k2, err := codec.provideKey()
	if err != nil {
		t.Fatalf("second load: %v", err)
	}
	if !bytes.Equal(k1, k2) {
		t.Fatal("cached key changed between calls")
	}

	if err := os.Remove(keyPath); err != nil {
		t.Fatalf("remove key file: %v", err)
	}
	k3, err := codec.provideKey()
	if err != nil {
		t.Fatalf("third load: %v", err)
	}
	if !bytes.Equal(k1, k3) {
		t.Fatal("expected the cached key after the key file was removed, got a different key")
	}
}

func TestCachedRequestStoreKeyInitializesOnce(t *testing.T) {
	t.Parallel()
	keys := &requestStoreKeyState{}

	key := bytes.Repeat([]byte{7}, requestStoreKeySize)
	var calls atomic.Int32
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	initialize := func(createIfMissing bool) ([]byte, error) {
		calls.Add(1)
		entered <- struct{}{}
		<-release
		return append([]byte(nil), key...), nil
	}

	results := make(chan []byte, 2)
	start := func() {
		result, err := keys.load(true, initialize)
		if err != nil {
			t.Errorf("load key: %v", err)
			results <- nil
			return
		}
		results <- result
	}

	go start()
	<-entered
	secondStarted := make(chan struct{})
	go func() {
		close(secondStarted)
		start()
	}()
	<-secondStarted

	concurrentInitialization := false
	select {
	case <-entered:
		concurrentInitialization = true
	case <-time.After(100 * time.Millisecond):
	}
	close(release)

	first := <-results
	second := <-results
	if concurrentInitialization {
		t.Fatal("request-store key initializer ran concurrently")
	}
	if calls.Load() != 1 {
		t.Fatalf("initializer called %d times, want 1", calls.Load())
	}
	if !bytes.Equal(first, key) || !bytes.Equal(second, key) {
		t.Fatalf("callers received different keys: %x %x", first, second)
	}
}
