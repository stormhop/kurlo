package secrets

import (
	"context"
	"sort"
	"sync"
	"time"
)

const maxConcurrentFetches = 4

type Source interface {
	Providers(workspaceID string) ([]ProviderConfig, error)
	Trusted(workspaceID string, config ProviderConfig) bool
	Credentials(workspaceID, providerID string) Credentials
}

type cacheKey struct {
	workspaceID string
	configHash  string
	providerID  string
	path        string
	version     string
}

type cacheEntry struct {
	secret  Secret
	expires time.Time
}

type pendingFetch struct {
	done   chan struct{}
	secret Secret
	err    error
}

type instanceKey struct {
	workspaceID string
	providerID  string
	configHash  string
}

type Manager struct {
	source Source
	env    Environment

	mu        sync.Mutex
	cache     map[cacheKey]cacheEntry
	instances map[instanceKey]Provider
	limits    map[instanceKey]chan struct{}
	pending   map[cacheKey]*pendingFetch
}

func NewManager(source Source, env Environment) *Manager {
	return &Manager{
		source:    source,
		env:       env.withDefaults(),
		cache:     map[cacheKey]cacheEntry{},
		instances: map[instanceKey]Provider{},
		limits:    map[instanceKey]chan struct{}{},
		pending:   map[cacheKey]*pendingFetch{},
	}
}

func (m *Manager) SetBrowser(open func(string) error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.env.OpenBrowser = open
	m.instances = map[instanceKey]Provider{}
}

func (m *Manager) ClearCache() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := len(m.cache)
	m.pending = map[cacheKey]*pendingFetch{}
	m.cache = map[cacheKey]cacheEntry{}
	m.instances = map[instanceKey]Provider{}
	return count
}

func (m *Manager) CachedCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.env.Now()
	count := 0
	for _, entry := range m.cache {
		if entry.expires.IsZero() || now.Before(entry.expires) {
			count++
		}
	}
	return count
}

func (m *Manager) Config(workspaceID, providerID string) (ProviderConfig, error) {
	configs, err := m.source.Providers(workspaceID)
	if err != nil {
		return ProviderConfig{}, newError(KindUnavailable, providerID, "cannot read secret providers: %v", err)
	}
	for _, config := range configs {
		if config.ID == providerID {
			return config, nil
		}
	}
	return ProviderConfig{}, newError(KindInvalidRef, providerID, "no secret provider with this id in workspace.yml")
}

func (m *Manager) provider(workspaceID string, config ProviderConfig) (Provider, chan struct{}, error) {
	key := instanceKey{workspaceID: workspaceID, providerID: config.ID, configHash: config.Hash()}
	m.mu.Lock()
	defer m.mu.Unlock()
	if instance, ok := m.instances[key]; ok {
		return instance, m.limits[key], nil
	}
	instance, err := NewProvider(config, m.source.Credentials(workspaceID, config.ID), m.env)
	if err != nil {
		return nil, nil, err
	}
	m.instances[key] = instance
	if _, ok := m.limits[key]; !ok {
		m.limits[key] = make(chan struct{}, maxConcurrentFetches)
	}
	return instance, m.limits[key], nil
}

func (m *Manager) ForgetProvider(workspaceID, providerID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key := range m.instances {
		if key.workspaceID == workspaceID && key.providerID == providerID {
			delete(m.instances, key)
		}
	}
	for key := range m.pending {
		if key.workspaceID == workspaceID && key.providerID == providerID {
			delete(m.pending, key)
		}
	}
	for key := range m.cache {
		if key.workspaceID == workspaceID && key.providerID == providerID {
			delete(m.cache, key)
		}
	}
}

func (m *Manager) Check(ctx context.Context, workspaceID, providerID string) (Status, error) {
	config, err := m.Config(workspaceID, providerID)
	if err != nil {
		return Status{}, err
	}
	if !m.source.Trusted(workspaceID, config) {
		return Status{}, untrusted(config)
	}
	instance, _, err := m.provider(workspaceID, config)
	if err != nil {
		return Status{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, config.CallTimeout())
	defer cancel()
	return instance.Check(ctx)
}

type Associator interface {
	Associate(ctx context.Context) (map[string]string, error)
}

func (m *Manager) Associate(ctx context.Context, workspaceID, providerID string) (map[string]string, error) {
	config, err := m.Config(workspaceID, providerID)
	if err != nil {
		return nil, err
	}
	if !m.source.Trusted(workspaceID, config) {
		return nil, untrusted(config)
	}
	instance, _, err := m.provider(workspaceID, config)
	if err != nil {
		return nil, err
	}
	associator, ok := instance.(Associator)
	if !ok {
		return nil, newError(KindInvalidRef, config.ID, "%s does not connect this way", config.DisplayName())
	}
	ctx, cancel := context.WithTimeout(ctx, config.Timeout+keepassxcAssociateTimeout)
	defer cancel()
	return associator.Associate(ctx)
}

func (m *Manager) List(ctx context.Context, workspaceID, providerID, prefix string) ([]Entry, error) {
	config, err := m.Config(workspaceID, providerID)
	if err != nil {
		return nil, err
	}
	if !m.source.Trusted(workspaceID, config) {
		return nil, untrusted(config)
	}
	instance, _, err := m.provider(workspaceID, config)
	if err != nil {
		return nil, err
	}
	lister, ok := instance.(Lister)
	if !ok {
		return nil, newError(KindInvalidRef, config.ID, "%s cannot list its secrets; type the path", config.DisplayName())
	}
	ctx, cancel := context.WithTimeout(ctx, config.CallTimeout())
	defer cancel()
	entries, err := lister.List(ctx, prefix)
	if err != nil {
		return nil, err
	}
	if entries == nil {
		entries = []Entry{}
	}
	return entries, nil
}

func untrusted(config ProviderConfig) *Error {
	if config.Type == TypeCommand {
		return newError(KindUntrusted, config.ID, "%s runs a command on this computer; trust it in the Kurlo app, or pass --allow-secret-commands to the CLI", config.DisplayName())
	}
	return newError(KindUntrusted, config.ID, "%s is not trusted on this device; review its settings and trust it first", config.DisplayName())
}

func (m *Manager) Fetch(ctx context.Context, workspaceID string, ref Ref) (Secret, ProviderConfig, error) {
	return m.fetch(ctx, workspaceID, ref, false)
}

func (m *Manager) Refresh(ctx context.Context, workspaceID string, ref Ref) (Secret, ProviderConfig, error) {
	return m.fetch(ctx, workspaceID, ref, true)
}

func (m *Manager) fetch(ctx context.Context, workspaceID string, ref Ref, refresh bool) (Secret, ProviderConfig, error) {
	config, err := m.Config(workspaceID, ref.Provider)
	if err != nil {
		return Secret{}, config, err
	}
	if !m.source.Trusted(workspaceID, config) {
		return Secret{}, config, untrusted(config)
	}
	key := cacheKey{workspaceID: workspaceID, configHash: config.Hash(), providerID: config.ID, path: ref.Path, version: ref.Version}
	m.mu.Lock()
	if !refresh {
		if entry, ok := m.cache[key]; ok && (entry.expires.IsZero() || m.env.Now().Before(entry.expires)) {
			m.mu.Unlock()
			return entry.secret, config, nil
		}
		if pending := m.pending[key]; pending != nil {
			m.mu.Unlock()
			select {
			case <-pending.done:
				return pending.secret, config, pending.err
			case <-ctx.Done():
				return Secret{}, config, transportError(config.ID, ctx.Err())
			}
		}
	}
	delete(m.cache, key)
	pending := &pendingFetch{done: make(chan struct{})}
	m.pending[key] = pending
	m.mu.Unlock()

	pending.secret, pending.err = m.read(ctx, workspaceID, config, ref)
	m.mu.Lock()
	if m.pending[key] == pending {
		delete(m.pending, key)
		if pending.err == nil {
			m.store(key, config, pending.secret)
		}
	}
	close(pending.done)
	m.mu.Unlock()
	return pending.secret, config, pending.err
}

func (m *Manager) read(ctx context.Context, workspaceID string, config ProviderConfig, ref Ref) (Secret, error) {
	instance, limit, err := m.provider(workspaceID, config)
	if err != nil {
		return Secret{}, err
	}
	select {
	case limit <- struct{}{}:
	case <-ctx.Done():
		return Secret{}, transportError(config.ID, ctx.Err())
	}
	defer func() { <-limit }()
	fetchCtx, cancel := context.WithTimeout(ctx, config.CallTimeout())
	defer cancel()
	return instance.Fetch(fetchCtx, ref.Path, ref.Version)
}

func (m *Manager) store(key cacheKey, config ProviderConfig, secret Secret) {
	if config.CacheTTL == 0 {
		return
	}
	entry := cacheEntry{secret: secret}
	if config.CacheTTL > 0 {
		entry.expires = m.env.Now().Add(config.CacheTTL)
	}
	if !secret.ExpiresAt.IsZero() && (entry.expires.IsZero() || secret.ExpiresAt.Before(entry.expires)) {
		entry.expires = secret.ExpiresAt
	}
	m.cache[key] = entry
}

func (m *Manager) Value(ctx context.Context, workspaceID string, ref Ref) (string, error) {
	secret, config, err := m.Fetch(ctx, workspaceID, ref)
	if err != nil {
		return "", err
	}
	return secret.Value(config.ID, ref)
}

func (m *Manager) Resolve(ctx context.Context, workspaceID string, refs []Ref) (map[Ref]string, error) {
	unique := make([]Ref, 0, len(refs))
	seen := map[Ref]bool{}
	for _, ref := range refs {
		if !seen[ref] {
			seen[ref] = true
			unique = append(unique, ref)
		}
	}
	values := make(map[Ref]string, len(unique))
	if len(unique) == 0 {
		return values, nil
	}
	var mu sync.Mutex
	var failures []Failure
	var wg sync.WaitGroup
	for _, ref := range unique {
		wg.Add(1)
		go func(ref Ref) {
			defer wg.Done()
			value, err := m.Value(ctx, workspaceID, ref)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				failures = append(failures, Failure{Ref: ref, Err: err})
				return
			}
			values[ref] = value
		}(ref)
	}
	wg.Wait()
	if len(failures) > 0 {
		sort.Slice(failures, func(i, j int) bool { return failures[i].Ref.String() < failures[j].Ref.String() })
		return values, &ResolveError{Failures: failures}
	}
	return values, nil
}
