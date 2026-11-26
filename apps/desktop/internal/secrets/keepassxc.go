package secrets

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/nacl/box"
)

const (
	KeePassXCAssociationIDEnv  = "KEEPASSXC_ASSOCIATION_ID"
	KeePassXCAssociationKeyEnv = "KEEPASSXC_ASSOCIATION_KEY"

	keepassxcProxy            = "keepassxc-proxy"
	keepassxcConfirmTimeout   = 2 * time.Minute
	keepassxcAssociateTimeout = 3 * time.Minute
	keepassxcMaxMessage       = 1 << 20
)

var keepassxcHandshakeTimeout = 5 * time.Second

const (
	keepassxcErrDatabaseNotOpened   = "1"
	keepassxcErrCancelledOrDenied   = "6"
	keepassxcErrAssociationFailed   = "8"
	keepassxcErrNoLoginsFound       = "15"
	keepassxcErrAccessToAllDenied   = "17"
	keepassxcErrClientKeyNotReceive = "3"
)

var (
	keepassxcMu        sync.Mutex
	keepassxcDownUntil time.Time
)

const keepassxcDownMemory = 5 * time.Second

type keepassxcProvider struct {
	config      ProviderConfig
	credentials Credentials
	env         Environment
}

type keepassxcAssociation struct {
	ID  string
	Key string
}

type keepassxcEntry struct {
	Login        string              `json:"login"`
	Password     string              `json:"password"`
	Name         string              `json:"name"`
	UUID         string              `json:"uuid"`
	Group        string              `json:"group"`
	TOTP         string              `json:"totp"`
	Expired      string              `json:"expired"`
	StringFields []map[string]string `json:"stringFields"`
}

type keepassxcSession struct {
	provider  string
	pipe      io.ReadWriteCloser
	clientID  string
	publicKey *[32]byte
	secretKey *[32]byte
	serverKey *[32]byte
	version   string
}

func (p *keepassxcProvider) lock() func() {
	keepassxcMu.Lock()
	return keepassxcMu.Unlock
}

func (p *keepassxcProvider) association() (keepassxcAssociation, error) {
	id, _ := p.credentials("associationId")
	key, _ := p.credentials("associationKey")
	if strings.TrimSpace(id) == "" || strings.TrimSpace(key) == "" {
		id, _ = p.env.Getenv(KeePassXCAssociationIDEnv)
		key, _ = p.env.Getenv(KeePassXCAssociationKeyEnv)
	}
	id, key = strings.TrimSpace(id), strings.TrimSpace(key)
	if id == "" || key == "" {
		return keepassxcAssociation{}, newError(KindNotAuthenticated, p.config.ID, "Kurlo is not connected to KeePassXC: click Connect to KeePassXC, or set %s and %s", KeePassXCAssociationIDEnv, KeePassXCAssociationKeyEnv)
	}
	return keepassxcAssociation{ID: id, Key: key}, nil
}

func (p *keepassxcProvider) open(ctx context.Context) (*keepassxcSession, error) {
	path, err := p.env.LookPath(keepassxcProxy)
	if err != nil {
		return nil, newError(KindToolMissing, p.config.ID, "keepassxc-proxy was not found; install KeePassXC 2.7 or later")
	}
	if ctx.Err() != nil {
		return nil, contextError(ctx, p.config.ID, ctx.Err())
	}
	if p.env.Now().Before(keepassxcDownUntil) {
		return nil, (&keepassxcSession{provider: p.config.ID}).notRunning()
	}
	pipe, err := p.env.Spawn(ctx, path, nil)
	if err != nil {
		if ctx.Err() != nil {
			return nil, contextError(ctx, p.config.ID, err)
		}
		return nil, newError(KindUnavailable, p.config.ID, "cannot start keepassxc-proxy: %v", err)
	}
	publicKey, secretKey, err := box.GenerateKey(rand.Reader)
	if err != nil {
		_ = pipe.Close()
		return nil, newError(KindUnavailable, p.config.ID, "cannot create a key pair: %v", err)
	}
	session := &keepassxcSession{provider: p.config.ID, pipe: pipe, clientID: base64.StdEncoding.EncodeToString(randomBytes(24)), publicKey: publicKey, secretKey: secretKey}
	handshake, cancel := context.WithTimeout(ctx, keepassxcHandshakeTimeout)
	defer cancel()
	stop := context.AfterFunc(handshake, func() { _ = pipe.Close() })
	defer stop()
	if err := session.exchangeKeys(); err != nil {
		_ = pipe.Close()
		if ctx.Err() == nil && handshake.Err() != nil {
			keepassxcDownUntil = p.env.Now().Add(keepassxcDownMemory)
			return nil, session.notRunning()
		}
		return nil, contextError(ctx, p.config.ID, err)
	}
	if !stop() {
		return nil, session.notRunning()
	}
	keepassxcDownUntil = time.Time{}
	return session, nil
}

func randomBytes(size int) []byte {
	buf := make([]byte, size)
	_, _ = rand.Read(buf)
	return buf
}

func incrementNonce(nonce []byte) []byte {
	out := append([]byte(nil), nonce...)
	for i := range out {
		out[i]++
		if out[i] != 0 {
			break
		}
	}
	return out
}

func contextError(ctx context.Context, provider string, err error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return newError(KindTimeout, provider, "KeePassXC did not answer before the timeout; check for an open request in KeePassXC")
	}
	if ctx.Err() != nil {
		return newError(KindUnavailable, provider, "cancelled")
	}
	return err
}

func (s *keepassxcSession) Close() error {
	return s.pipe.Close()
}

func (s *keepassxcSession) write(message map[string]any) error {
	payload, err := json.Marshal(message)
	if err != nil {
		return err
	}
	frame := make([]byte, 4+len(payload))
	binary.LittleEndian.PutUint32(frame, uint32(len(payload)))
	copy(frame[4:], payload)
	_, err = s.pipe.Write(frame)
	return err
}

func (s *keepassxcSession) notRunning() error {
	return newError(KindUnavailable, s.provider, "KeePassXC is not running, or browser integration is off: open KeePassXC and turn on Settings → Browser Integration")
}

func (s *keepassxcSession) read(action string) (map[string]any, error) {
	for {
		var header [4]byte
		if _, err := io.ReadFull(s.pipe, header[:]); err != nil {
			return nil, s.notRunning()
		}
		size := binary.LittleEndian.Uint32(header[:])
		if size == 0 || size > keepassxcMaxMessage {
			return nil, newError(KindUnavailable, s.provider, "unexpected answer from keepassxc-proxy")
		}
		payload := make([]byte, size)
		if _, err := io.ReadFull(s.pipe, payload); err != nil {
			return nil, s.notRunning()
		}
		decoder := json.NewDecoder(bytes.NewReader(payload))
		for decoder.More() {
			var message map[string]any
			if err := decoder.Decode(&message); err != nil {
				return nil, newError(KindUnavailable, s.provider, "unexpected answer from keepassxc-proxy")
			}
			if text(message["action"]) == action {
				return message, nil
			}
		}
	}
}

func text(value any) string {
	out, _ := value.(string)
	return out
}

func (s *keepassxcSession) exchangeKeys() error {
	nonce := randomBytes(24)
	if err := s.write(map[string]any{
		"action":    "change-public-keys",
		"publicKey": base64.StdEncoding.EncodeToString(s.publicKey[:]),
		"nonce":     base64.StdEncoding.EncodeToString(nonce),
		"clientID":  s.clientID,
	}); err != nil {
		return s.notRunning()
	}
	reply, err := s.read("change-public-keys")
	if err != nil {
		return err
	}
	if err := s.replyError(reply); err != nil {
		return err
	}
	if text(reply["nonce"]) != base64.StdEncoding.EncodeToString(incrementNonce(nonce)) {
		return newError(KindUnavailable, s.provider, "KeePassXC answered with a wrong nonce")
	}
	serverKey, err := base64.StdEncoding.DecodeString(text(reply["publicKey"]))
	if err != nil || len(serverKey) != 32 {
		return newError(KindUnavailable, s.provider, "KeePassXC sent no public key")
	}
	s.serverKey = new([32]byte)
	copy(s.serverKey[:], serverKey)
	s.version = text(reply["version"])
	return nil
}

func (s *keepassxcSession) replyError(reply map[string]any) error {
	code := text(reply["errorCode"])
	if code == "" {
		if errorCode, ok := reply["errorCode"].(float64); ok {
			code = fmt.Sprint(int(errorCode))
		}
	}
	if code == "" && text(reply["error"]) == "" {
		return nil
	}
	message := strings.TrimSpace(text(reply["error"]))
	switch code {
	case keepassxcErrDatabaseNotOpened:
		return newError(KindUnavailable, s.provider, "the KeePassXC database is locked: unlock it in KeePassXC and try again")
	case keepassxcErrAssociationFailed:
		return newError(KindNotAuthenticated, s.provider, "KeePassXC does not know this connection: click Connect to KeePassXC again, or check that the same database is open")
	case keepassxcErrNoLoginsFound:
		return newError(KindNotFound, s.provider, "no KeePassXC entry matches this URL, or an access request is still open in KeePassXC; add the URL to the entry or answer the request")
	case keepassxcErrCancelledOrDenied:
		return newError(KindForbidden, s.provider, "the request was cancelled or denied in KeePassXC")
	case keepassxcErrAccessToAllDenied:
		return newError(KindForbidden, s.provider, "access to the matching entries was denied in KeePassXC; allow it in the entry's Browser Integration settings")
	case keepassxcErrClientKeyNotReceive:
		return newError(KindUnavailable, s.provider, "KeePassXC did not accept the connection: %s", message)
	}
	if message == "" {
		message = "error " + code
	}
	return newError(KindUnavailable, s.provider, "KeePassXC: %s", message)
}

func (s *keepassxcSession) call(action string, params map[string]any) (map[string]any, error) {
	inner := map[string]any{"action": action}
	for key, value := range params {
		inner[key] = value
	}
	plain, err := json.Marshal(inner)
	if err != nil {
		return nil, err
	}
	nonce := randomBytes(24)
	var nonceArray [24]byte
	copy(nonceArray[:], nonce)
	sealed := box.Seal(nil, plain, &nonceArray, s.serverKey, s.secretKey)
	if err := s.write(map[string]any{
		"action":        action,
		"message":       base64.StdEncoding.EncodeToString(sealed),
		"nonce":         base64.StdEncoding.EncodeToString(nonce),
		"clientID":      s.clientID,
		"triggerUnlock": "true",
	}); err != nil {
		return nil, s.notRunning()
	}
	reply, err := s.read(action)
	if err != nil {
		return nil, err
	}
	if err := s.replyError(reply); err != nil {
		return nil, err
	}
	expected := incrementNonce(nonce)
	replyNonce, err := base64.StdEncoding.DecodeString(text(reply["nonce"]))
	if err != nil || !bytes.Equal(replyNonce, expected) {
		return nil, newError(KindUnavailable, s.provider, "KeePassXC answered with a wrong nonce")
	}
	encrypted, err := base64.StdEncoding.DecodeString(text(reply["message"]))
	if err != nil {
		return nil, newError(KindUnavailable, s.provider, "unexpected answer from KeePassXC")
	}
	var replyNonceArray [24]byte
	copy(replyNonceArray[:], replyNonce)
	opened, ok := box.Open(nil, encrypted, &replyNonceArray, s.serverKey, s.secretKey)
	if !ok {
		return nil, newError(KindUnavailable, s.provider, "cannot decrypt the answer from KeePassXC")
	}
	var message map[string]any
	if err := json.Unmarshal(bytes.TrimRight(opened, "\x00"), &message); err != nil {
		return nil, newError(KindUnavailable, s.provider, "unexpected answer from KeePassXC")
	}
	if err := s.replyError(message); err != nil {
		return nil, err
	}
	if text(message["success"]) != "true" {
		return nil, newError(KindUnavailable, s.provider, "KeePassXC did not confirm the %s request", action)
	}
	return message, nil
}

func (s *keepassxcSession) testAssociate(association keepassxcAssociation) error {
	_, err := s.call("test-associate", map[string]any{"id": association.ID, "key": association.Key})
	return err
}

func (s *keepassxcSession) logins(association keepassxcAssociation, siteURL string) ([]keepassxcEntry, error) {
	reply, err := s.call("get-logins", map[string]any{
		"id":   association.ID,
		"url":  siteURL,
		"keys": []map[string]string{{"id": association.ID, "key": association.Key}},
	})
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(reply["entries"])
	if err != nil {
		return nil, newError(KindUnavailable, s.provider, "unexpected answer from KeePassXC")
	}
	var entries []keepassxcEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, newError(KindUnavailable, s.provider, "unexpected answer from KeePassXC")
	}
	return entries, nil
}

func KeePassXCSiteURL(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("path is empty; enter the URL saved in the KeePassXC entry")
	}
	if !strings.Contains(path, "://") {
		path = "https://" + path
	}
	parsed, err := url.Parse(path)
	if err != nil || parsed.Host == "" {
		return "", fmt.Errorf("%q is not a URL; enter the URL saved in the KeePassXC entry, like https://api.example.com", path)
	}
	return path, nil
}

func (e keepassxcEntry) fields() map[string]string {
	fields := map[string]string{
		"username": e.Login,
		"password": e.Password,
		"title":    e.Name,
		"uuid":     e.UUID,
		"group":    e.Group,
	}
	if e.TOTP != "" {
		fields["totp"] = e.TOTP
	}
	for _, item := range e.StringFields {
		for key, value := range item {
			name := strings.TrimSpace(strings.TrimPrefix(key, "KPH:"))
			if name != "" {
				fields[name] = value
			}
		}
	}
	for name, value := range fields {
		if value == "" {
			delete(fields, name)
		}
	}
	return fields
}

func (p *keepassxcProvider) pick(entries []keepassxcEntry, siteURL, selector string) (keepassxcEntry, error) {
	selector = strings.TrimSpace(selector)
	if selector != "" {
		var matched []keepassxcEntry
		for _, entry := range entries {
			if strings.EqualFold(entry.UUID, strings.ReplaceAll(strings.Trim(selector, "{}"), "-", "")) || entry.Name == selector {
				matched = append(matched, entry)
			}
		}
		switch len(matched) {
		case 0:
			return keepassxcEntry{}, newError(KindNotFound, p.config.ID, "no entry named %q matches %s", selector, siteURL)
		case 1:
			return matched[0], nil
		default:
			return keepassxcEntry{}, newError(KindInvalidRef, p.config.ID, "%d entries named %q match %s; use the entry UUID instead", len(matched), selector, siteURL)
		}
	}
	if len(entries) == 1 {
		return entries[0], nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, fmt.Sprintf("%s (%s)", entry.Name, entry.UUID))
	}
	sort.Strings(names)
	return keepassxcEntry{}, newError(KindInvalidRef, p.config.ID, "%d entries match %s; put the entry title or UUID in Entry: %s", len(entries), siteURL, strings.Join(names, ", "))
}

func (p *keepassxcProvider) Fetch(ctx context.Context, path, version string) (Secret, error) {
	siteURL, err := KeePassXCSiteURL(path)
	if err != nil {
		return Secret{}, newError(KindInvalidRef, p.config.ID, "%v", err)
	}
	association, err := p.association()
	if err != nil {
		return Secret{}, err
	}
	unlock := p.lock()
	defer unlock()
	session, err := p.open(ctx)
	if err != nil {
		return Secret{}, err
	}
	defer session.Close()
	stop := context.AfterFunc(ctx, func() { _ = session.Close() })
	defer stop()
	if err := session.testAssociate(association); err != nil {
		return Secret{}, contextError(ctx, p.config.ID, err)
	}
	entries, err := session.logins(association, siteURL)
	if err != nil {
		return Secret{}, contextError(ctx, p.config.ID, err)
	}
	if len(entries) == 0 {
		return Secret{}, newError(KindNotFound, p.config.ID, "no KeePassXC entry matches %s", siteURL)
	}
	entry, err := p.pick(entries, siteURL, version)
	if err != nil {
		return Secret{}, err
	}
	return Secret{Raw: entry.Password, Fields: entry.fields()}, nil
}

func (p *keepassxcProvider) Check(ctx context.Context) (Status, error) {
	association, err := p.association()
	if err != nil {
		return Status{}, err
	}
	unlock := p.lock()
	defer unlock()
	session, err := p.open(ctx)
	if err != nil {
		return Status{}, err
	}
	defer session.Close()
	stop := context.AfterFunc(ctx, func() { _ = session.Close() })
	defer stop()
	if err := session.testAssociate(association); err != nil {
		return Status{}, contextError(ctx, p.config.ID, err)
	}
	detail := "Connected to KeePassXC as " + association.ID
	if session.version != "" {
		detail = "Connected to KeePassXC " + session.version + " as " + association.ID
	}
	return Status{Detail: detail}, nil
}

func (p *keepassxcProvider) Associate(ctx context.Context) (map[string]string, error) {
	unlock := p.lock()
	defer unlock()
	session, err := p.open(ctx)
	if err != nil {
		return nil, err
	}
	defer session.Close()
	stop := context.AfterFunc(ctx, func() { _ = session.Close() })
	defer stop()
	idPublic, _, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return nil, newError(KindUnavailable, p.config.ID, "cannot create a key pair: %v", err)
	}
	idKey := base64.StdEncoding.EncodeToString(idPublic[:])
	reply, err := session.call("associate", map[string]any{
		"key":   base64.StdEncoding.EncodeToString(session.publicKey[:]),
		"idKey": idKey,
	})
	if err != nil {
		if KindOf(err) == KindForbidden {
			return nil, newError(KindForbidden, p.config.ID, "the connection was not approved in KeePassXC")
		}
		return nil, contextError(ctx, p.config.ID, err)
	}
	id := strings.TrimSpace(text(reply["id"]))
	if id == "" {
		return nil, newError(KindUnavailable, p.config.ID, "KeePassXC did not name the connection")
	}
	return map[string]string{"associationId": id, "associationKey": idKey}, nil
}
