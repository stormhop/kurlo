package api

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

func TestRequestStoreKeyCacheRetriesAfterFailure(t *testing.T) {
	t.Parallel()
	keys := &requestStoreKeyState{}
	want := bytes.Repeat([]byte{42}, requestStoreKeySize)
	calls := 0
	initialize := func(bool) ([]byte, error) {
		calls++
		if calls == 1 {
			return nil, os.ErrNotExist
		}
		return want, nil
	}
	if _, err := keys.load(false, initialize); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("load missing key: %v", err)
	}
	got, err := keys.load(true, initialize)
	if err != nil || !bytes.Equal(got, want) || calls != 2 {
		t.Fatalf("retry: key=%x error=%v calls=%d", got, err, calls)
	}
}

func TestRequestStoreKeyCacheReturnsIndependentBuffers(t *testing.T) {
	t.Parallel()
	keys := &requestStoreKeyState{}
	source := bytes.Repeat([]byte{42}, requestStoreKeySize)
	initialize := func(bool) ([]byte, error) { return source, nil }
	first, err := keys.load(true, initialize)
	if err != nil {
		t.Fatal(err)
	}
	source[0], first[1] = 0, 0
	second, err := keys.load(false, initialize)
	if err != nil || !bytes.Equal(second, bytes.Repeat([]byte{42}, requestStoreKeySize)) {
		t.Fatalf("cached key changed: %x, %v", second, err)
	}
}

func TestRequestStoreKeyCacheSeparatesDirectories(t *testing.T) {
	t.Parallel()
	keys := &requestStoreKeyState{}
	for _, value := range []byte{1, 2, 1} {
		key := bytes.Repeat([]byte{value}, requestStoreKeySize)
		got, err := keys.loadForScope(string([]byte{value}), true, func(bool) ([]byte, error) { return key, nil })
		if err != nil || !bytes.Equal(got, key) {
			t.Fatalf("wrong directory key: %x, %v", got, err)
		}
	}
}

func TestRequestStoreCodecsDoNotShareDecryptedPayloads(t *testing.T) {
	t.Parallel()
	writer := isolatedRequestStoreCodec(t)
	reader := isolatedRequestStoreCodec(t)
	path := filepath.Join(t.TempDir(), "requests.json")
	if err := writer.savePayload(path, `{"secret":"private"}`); err != nil {
		t.Fatal(err)
	}
	if payload, err := reader.loadPayload(path); err == nil || payload != "" {
		t.Fatalf("foreign codec read cached plaintext: %q, %v", payload, err)
	}
	if payload, err := writer.loadPayload(path); err != nil || payload != `{"secret":"private"}` {
		t.Fatalf("owner lost payload: %q, %v", payload, err)
	}
}

func TestHistoryStoresWithTheSameIDsRemainIndependent(t *testing.T) {
	t.Parallel()
	left, right := withHistoryStore(t), withHistoryStore(t)
	var writes sync.WaitGroup
	for _, app := range []*App{left, right} {
		writes.Go(func() {
			if result := app.SaveHistoryResponse("shared-id", app.historyResponses().dir()); !result.Stored || result.Error != "" {
				t.Errorf("save: %+v", result)
			}
		})
	}
	writes.Wait()
	for _, app := range []*App{left, right} {
		if result := app.LoadHistoryResponse("shared-id"); !result.Stored || result.Payload != app.historyResponses().dir() {
			t.Fatalf("crossed history directories: %+v", result)
		}
		if ids := app.StoredHistoryResponseIDs(); !reflect.DeepEqual(ids, []string{"shared-id"}) {
			t.Fatalf("stored IDs: %v", ids)
		}
	}
	if err := left.ClearHistoryResponses(); err != "" {
		t.Fatal(err)
	}
	if result := right.LoadHistoryResponse("shared-id"); !result.Stored {
		t.Fatalf("clearing another store removed the response: %+v", result)
	}
	if result := right.PruneHistoryResponses(nil); result != "" {
		t.Fatal(result)
	}
	if ids := right.StoredHistoryResponseIDs(); len(ids) != 0 {
		t.Fatalf("pruning retained IDs: %v", ids)
	}
}

func TestGitCredentialStoresWithTheSameHostsRemainIndependent(t *testing.T) {
	t.Parallel()
	left, right := withIsolatedStore(t), withIsolatedStore(t)
	for token, store := range map[string]*gitCredentialStore{"left-token": left, "right-token": right} {
		app := &App{credentialStore: store}
		if result := app.GitStoreToken("github.com", "user", token); !result.Ok {
			t.Fatal(result.Error)
		}
		if info := app.GitTokenInfo("github.com"); !info.HasToken || info.Username != "user" {
			t.Fatalf("token info: %+v", info)
		}
	}
	if result := (&App{credentialStore: left}).GitClearToken("github.com"); !result.Ok {
		t.Fatal(result.Error)
	}
	if cred, ok := right.lookup("github.com"); !ok || cred.Token != "right-token" {
		t.Fatalf("clearing another store changed the token: %+v, %v", cred, ok)
	}
}
