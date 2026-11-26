package secrets

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/nacl/box"
)

type fakeKeePassXC struct {
	mu           sync.Mutex
	locked       bool
	silent       bool
	denyAssoc    bool
	keys         map[string]string
	entries      []keepassxcEntry
	requests     []map[string]any
	broadcast    bool
	associatedAs string
}

func (f *fakeKeePassXC) set(change func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change()
}

func (f *fakeKeePassXC) spawn(ctx context.Context, path string, args []string) (io.ReadWriteCloser, error) {
	if path != "/opt/kp/keepassxc-proxy" {
		return nil, errors.New("unexpected proxy path " + path)
	}
	clientReader, serverWriter := io.Pipe()
	serverReader, clientWriter := io.Pipe()
	go f.serve(serverReader, serverWriter)
	return &pipeConn{reader: clientReader, writer: clientWriter, closers: []io.Closer{clientReader, clientWriter, serverReader, serverWriter}}, nil
}

type pipeConn struct {
	reader  io.Reader
	writer  io.Writer
	closers []io.Closer
}

func (c *pipeConn) Read(p []byte) (int, error)  { return c.reader.Read(p) }
func (c *pipeConn) Write(p []byte) (int, error) { return c.writer.Write(p) }
func (c *pipeConn) Close() error {
	for _, closer := range c.closers {
		_ = closer.Close()
	}
	return nil
}

func (f *fakeKeePassXC) serve(in io.Reader, out io.Writer) {
	serverPublic, serverSecret, _ := box.GenerateKey(rand.Reader)
	var clientPublic [32]byte
	send := func(message map[string]any) {
		payload, _ := json.Marshal(message)
		frame := make([]byte, 4+len(payload))
		binary.LittleEndian.PutUint32(frame, uint32(len(payload)))
		copy(frame[4:], payload)
		_, _ = out.Write(frame)
	}
	reply := func(action string, nonce []byte, params map[string]any) {
		next := incrementNonce(nonce)
		body := map[string]any{"version": "2.7.10", "success": "true", "nonce": base64.StdEncoding.EncodeToString(next)}
		for key, value := range params {
			body[key] = value
		}
		plain, _ := json.Marshal(body)
		var nonceArray [24]byte
		copy(nonceArray[:], next)
		sealed := box.Seal(nil, plain, &nonceArray, &clientPublic, serverSecret)
		if f.broadcast {
			send(map[string]any{"action": "database-unlocked"})
		}
		send(map[string]any{"action": action, "message": base64.StdEncoding.EncodeToString(sealed), "nonce": base64.StdEncoding.EncodeToString(next)})
	}
	fail := func(action, code, text string) {
		send(map[string]any{"action": action, "errorCode": code, "error": text})
	}
	for {
		var header [4]byte
		if _, err := io.ReadFull(in, header[:]); err != nil {
			return
		}
		payload := make([]byte, binary.LittleEndian.Uint32(header[:]))
		if _, err := io.ReadFull(in, payload); err != nil {
			return
		}
		f.mu.Lock()
		silent := f.silent
		f.mu.Unlock()
		if silent {
			continue
		}
		var outer map[string]any
		_ = json.Unmarshal(payload, &outer)
		action := text(outer["action"])
		nonce, _ := base64.StdEncoding.DecodeString(text(outer["nonce"]))
		if action == "change-public-keys" {
			key, _ := base64.StdEncoding.DecodeString(text(outer["publicKey"]))
			copy(clientPublic[:], key)
			send(map[string]any{"action": action, "version": "2.7.10", "success": "true", "publicKey": base64.StdEncoding.EncodeToString(serverPublic[:]), "nonce": base64.StdEncoding.EncodeToString(incrementNonce(nonce))})
			continue
		}
		f.mu.Lock()
		locked := f.locked
		f.mu.Unlock()
		if locked {
			fail(action, keepassxcErrDatabaseNotOpened, "Database not opened")
			continue
		}
		sealed, _ := base64.StdEncoding.DecodeString(text(outer["message"]))
		var nonceArray [24]byte
		copy(nonceArray[:], nonce)
		plain, ok := box.Open(nil, sealed, &nonceArray, &clientPublic, serverSecret)
		if !ok {
			fail(action, "4", "Cannot decrypt message")
			continue
		}
		var inner map[string]any
		_ = json.Unmarshal(plain, &inner)
		f.mu.Lock()
		f.requests = append(f.requests, inner)
		f.mu.Unlock()
		switch action {
		case "associate":
			f.mu.Lock()
			deny := f.denyAssoc
			f.mu.Unlock()
			if deny || text(inner["key"]) != base64.StdEncoding.EncodeToString(clientPublic[:]) {
				fail(action, keepassxcErrCancelledOrDenied, "Action cancelled or denied")
				continue
			}
			f.mu.Lock()
			f.keys[f.associatedAs] = text(inner["idKey"])
			f.mu.Unlock()
			reply(action, nonce, map[string]any{"id": f.associatedAs, "hash": "h"})
		case "test-associate":
			f.mu.Lock()
			known := f.keys[text(inner["id"])]
			f.mu.Unlock()
			if known == "" || known != text(inner["key"]) {
				fail(action, keepassxcErrAssociationFailed, "KeePassXC association failed, try again")
				continue
			}
			reply(action, nonce, map[string]any{"id": text(inner["id"]), "hash": "h"})
		case "get-logins":
			var matched []keepassxcEntry
			for _, entry := range f.entries {
				if strings.Contains(text(inner["url"]), entry.Group) {
					matched = append(matched, entry)
				}
			}
			if len(matched) == 0 {
				fail(action, keepassxcErrNoLoginsFound, "No logins found")
				continue
			}
			reply(action, nonce, map[string]any{"count": len(matched), "entries": matched, "id": text(inner["id"]), "hash": "h"})
		default:
			fail(action, "12", "Incorrect action")
		}
	}
}

func newFakeKeePassXC() *fakeKeePassXC {
	return &fakeKeePassXC{
		keys:         map[string]string{},
		associatedAs: "kurlo laptop",
		broadcast:    true,
		entries: []keepassxcEntry{
			{Login: "ci-bot", Password: "s3cret", Name: "API", UUID: "aa11", Group: "api.example.com", StringFields: []map[string]string{{"KPH: apiKey": "key-123"}}},
			{Login: "admin", Password: "one", Name: "Admin", UUID: "bb22", Group: "shared.example.com"},
			{Login: "viewer", Password: "two", Name: "Viewer", UUID: "cc33", Group: "shared.example.com"},
		},
	}
}

func keepassxcTestProvider(t *testing.T, fake *fakeKeePassXC, credentials map[string]string, env map[string]string) *keepassxcProvider {
	t.Helper()
	provider, err := NewProvider(ProviderConfig{ID: "kp", Type: TypeKeePassXC, Timeout: DefaultTimeout}, func(name string) (string, bool) {
		value, ok := credentials[name]
		return value, ok
	}, Environment{
		Getenv: func(name string) (string, bool) {
			value, ok := env[name]
			return value, ok
		},
		LookPath: func(name string) (string, error) {
			if name != keepassxcProxy {
				return "", errors.New("not found")
			}
			return "/opt/kp/keepassxc-proxy", nil
		},
		Spawn: fake.spawn,
	})
	if err != nil {
		t.Fatal(err)
	}
	return provider.(*keepassxcProvider)
}

func TestKeePassXCAssociateThenFetch(t *testing.T) {
	fake := newFakeKeePassXC()
	ctx := context.Background()
	credentials, err := keepassxcTestProvider(t, fake, nil, nil).Associate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if credentials["associationId"] != "kurlo laptop" || credentials["associationKey"] == "" {
		t.Fatalf("credentials %#v", credentials)
	}
	fake.mu.Lock()
	stored := fake.keys["kurlo laptop"]
	fake.mu.Unlock()
	if stored != credentials["associationKey"] {
		t.Fatalf("KeePassXC stored %q, Kurlo kept %q", stored, credentials["associationKey"])
	}
	provider := keepassxcTestProvider(t, fake, credentials, nil)
	secret, err := provider.Fetch(ctx, "api.example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	for field, want := range map[string]string{"": "s3cret", "username": "ci-bot", "password": "s3cret", "title": "API", "uuid": "aa11", "apiKey": "key-123"} {
		got, err := secret.Value("kp", Ref{Provider: "kp", Path: "api.example.com", Field: field})
		if err != nil || got != want {
			t.Fatalf("field %q = %q, %v; want %q", field, got, err, want)
		}
	}
	fake.mu.Lock()
	last := fake.requests[len(fake.requests)-1]
	fake.mu.Unlock()
	if last["url"] != "https://api.example.com" {
		t.Fatalf("url sent %v", last["url"])
	}
	status, err := provider.Check(ctx)
	if err != nil || status.Detail != "Connected to KeePassXC 2.7.10 as kurlo laptop" {
		t.Fatalf("check %#v %v", status, err)
	}
}

func TestKeePassXCPicksAmongSeveralEntries(t *testing.T) {
	fake := newFakeKeePassXC()
	fake.keys["ci"] = "k"
	provider := keepassxcTestProvider(t, fake, nil, map[string]string{KeePassXCAssociationIDEnv: "ci", KeePassXCAssociationKeyEnv: "k"})
	ctx := context.Background()
	_, err := provider.Fetch(ctx, "https://shared.example.com/login", "")
	if KindOf(err) != KindInvalidRef || !strings.Contains(err.Error(), "Admin (bb22), Viewer (cc33)") {
		t.Fatalf("expected a choice, got %v", err)
	}
	for selector, want := range map[string]string{"Viewer": "two", "bb22": "one", "{BB22}": "one"} {
		secret, err := provider.Fetch(ctx, "https://shared.example.com/login", selector)
		if err != nil || secret.Raw != want {
			t.Fatalf("%s: %q %v", selector, secret.Raw, err)
		}
	}
	if _, err := provider.Fetch(ctx, "https://shared.example.com", "Nobody"); KindOf(err) != KindNotFound {
		t.Fatalf("unknown entry: %v", err)
	}
}

func TestKeePassXCErrors(t *testing.T) {
	ctx := context.Background()
	fake := newFakeKeePassXC()
	if _, err := keepassxcTestProvider(t, fake, nil, nil).Fetch(ctx, "api.example.com", ""); KindOf(err) != KindNotAuthenticated || !strings.Contains(err.Error(), "Connect to KeePassXC") {
		t.Fatalf("no association: %v", err)
	}
	stale := keepassxcTestProvider(t, fake, map[string]string{"associationId": "gone", "associationKey": "x"}, nil)
	if _, err := stale.Fetch(ctx, "api.example.com", ""); KindOf(err) != KindNotAuthenticated || !strings.Contains(err.Error(), "Connect to KeePassXC again") {
		t.Fatalf("stale association: %v", err)
	}
	fake.keys["ok"] = "k"
	provider := keepassxcTestProvider(t, fake, map[string]string{"associationId": "ok", "associationKey": "k"}, nil)
	if _, err := provider.Fetch(ctx, "https://nothing.example.com", ""); KindOf(err) != KindNotFound {
		t.Fatalf("no logins: %v", err)
	}
	expired, cancel := context.WithTimeout(ctx, -time.Second)
	defer cancel()
	if _, err := provider.Fetch(expired, "api.example.com", ""); KindOf(err) != KindTimeout || !strings.Contains(err.Error(), "open request in KeePassXC") {
		t.Fatalf("waiting past the deadline: %v", err)
	}
	if _, err := provider.Fetch(ctx, "not a url", ""); KindOf(err) != KindInvalidRef {
		t.Fatalf("bad url: %v", err)
	}
	fake.set(func() { fake.locked = true })
	if _, err := provider.Fetch(ctx, "api.example.com", ""); KindOf(err) != KindUnavailable || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("locked: %v", err)
	}
	fake.set(func() { fake.locked, fake.denyAssoc = false, true })
	if _, err := provider.Associate(ctx); KindOf(err) != KindForbidden {
		t.Fatalf("denied association: %v", err)
	}
	missing, err := NewProvider(ProviderConfig{ID: "kp", Type: TypeKeePassXC}, nil, Environment{LookPath: func(string) (string, error) { return "", errors.New("no") }})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := missing.Check(ctx); KindOf(err) != KindNotAuthenticated {
		t.Fatalf("missing association first: %v", err)
	}
	if _, err := missing.(Associator).Associate(ctx); KindOf(err) != KindToolMissing {
		t.Fatalf("missing proxy: %v", err)
	}
}

func TestKeePassXCNotRunning(t *testing.T) {
	previous := keepassxcHandshakeTimeout
	keepassxcHandshakeTimeout = 50 * time.Millisecond
	defer func() { keepassxcHandshakeTimeout = previous }()
	fake := newFakeKeePassXC()
	fake.silent = true
	fake.keys["ok"] = "k"
	provider := keepassxcTestProvider(t, fake, map[string]string{"associationId": "ok", "associationKey": "k"}, nil)
	started := time.Now()
	_, err := provider.Fetch(context.Background(), "api.example.com", "")
	if KindOf(err) != KindUnavailable || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("silent proxy: %v", err)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatalf("took %v", time.Since(started))
	}
	fake.set(func() { fake.silent = false })
	again := time.Now()
	if _, err := provider.Fetch(context.Background(), "api.example.com", ""); KindOf(err) != KindUnavailable || time.Since(again) > 20*time.Millisecond {
		t.Fatalf("a second lookup right after should fail at once, got %v after %v", err, time.Since(again))
	}
	keepassxcDownUntil = time.Time{}
	if _, err := provider.Fetch(context.Background(), "api.example.com", ""); err != nil {
		t.Fatalf("after KeePassXC starts: %v", err)
	}
}

func TestKeePassXCConfigAndCredentials(t *testing.T) {
	config, err := ParseProvider(map[string]any{"id": "kp", "type": "keepassxc"})
	if err != nil {
		t.Fatal(err)
	}
	if config.CallTimeout() < keepassxcConfirmTimeout {
		t.Fatalf("call timeout %v leaves no time to confirm access in KeePassXC", config.CallTimeout())
	}
	names := CredentialEnvNames(config)
	if len(names) != 2 || names[0].Env != KeePassXCAssociationIDEnv || names[1].Env != KeePassXCAssociationKeyEnv {
		t.Fatalf("env names %#v", names)
	}
	if problem := CredentialProblem("associationId", "kurlo laptop"); problem != "" {
		t.Fatalf("a connection name with a space: %s", problem)
	}
	if problem := CredentialProblem("associationKey", "a b"); problem == "" {
		t.Fatal("a key with a space was accepted")
	}
	found := false
	for _, candidate := range toolCandidatesFor("darwin", func(string) string { return "" }, keepassxcProxy) {
		found = found || candidate == "/Applications/KeePassXC.app/Contents/MacOS/keepassxc-proxy"
	}
	if !found {
		t.Fatal("the macOS app bundle is not searched for keepassxc-proxy")
	}
	windows := toolCandidatesFor("windows", func(name string) string {
		if name == "ProgramFiles" {
			return `C:\Program Files`
		}
		return ""
	}, keepassxcProxy)
	if !strings.Contains(strings.Join(windows, "|"), `KeePassXC`) {
		t.Fatalf("windows candidates %q", windows)
	}
}

func TestSecretRawWinsOverFieldsWithoutField(t *testing.T) {
	secret := Secret{Raw: "pw", Fields: map[string]string{"username": "u", "password": "pw"}}
	if got, err := secret.Value("kp", Ref{Path: "x"}); err != nil || got != "pw" {
		t.Fatalf("%q %v", got, err)
	}
	if got, err := (Secret{Fields: map[string]string{"a": "1", "b": "2"}}).Value("vault", Ref{Path: "x"}); err == nil {
		t.Fatalf("fields without raw must still ask for a field, got %q", got)
	}
}
