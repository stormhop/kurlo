package api

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	secretmgr "github.com/stormhop/kurlo/apps/desktop/internal/secrets"
)

type cliLinkedSecrets struct {
	resolve  func(ctx context.Context, workspaceID string, refs []secretmgr.Ref) (map[secretmgr.Ref]string, error)
	fields   func(ctx context.Context, workspaceID string, item secretmgr.Import) ([]string, error)
	disabled string
	hint     string
	targets  []cliSecretTarget
	dataRows []map[string]string
	globals  map[string]string
	filtered bool
	skip     bool

	mu      sync.Mutex
	fetched map[string]string
}

type cliSecretSource struct {
	root          string
	timeout       time.Duration
	allowCommands bool

	mu      sync.Mutex
	dirs    map[string]string
	configs map[string][]secretmgr.ProviderConfig
}

func (s *cliSecretSource) Providers(workspaceID string) ([]secretmgr.ProviderConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if configs, ok := s.configs[workspaceID]; ok {
		return configs, nil
	}
	if s.dirs == nil {
		s.dirs = workspaceDirsByID(filepath.Join(s.root, fileStoreWorkspacesDir))
	}
	dir, ok := s.dirs[workspaceID]
	if !ok {
		return nil, fmt.Errorf("workspace %s is not in %s", workspaceID, s.root)
	}
	configs, _ := secretmgr.ParseProviders(readWorkspaceSecretProviders(dir))
	if s.timeout > 0 {
		for i := range configs {
			configs[i].Timeout = s.timeout
		}
	}
	if s.configs == nil {
		s.configs = map[string][]secretmgr.ProviderConfig{}
	}
	s.configs[workspaceID] = configs
	return configs, nil
}

func (s *cliSecretSource) Trusted(_ string, config secretmgr.ProviderConfig) bool {
	return config.Type != secretmgr.TypeCommand || s.allowCommands
}

func (s *cliSecretSource) Credentials(string, string) secretmgr.Credentials {
	return nil
}

func newCLILinkedSecrets(root string, timeout time.Duration, allowCommands bool) *cliLinkedSecrets {
	manager := secretmgr.NewManager(&cliSecretSource{root: root, timeout: timeout, allowCommands: allowCommands}, secretmgr.SystemEnvironment())
	return &cliLinkedSecrets{resolve: manager.Resolve, fields: managerImportFields(manager), hint: "--var"}
}

func newAppLinkedSecrets(workspaceID string) *cliLinkedSecrets {
	return &cliLinkedSecrets{
		hint: "variables",
		resolve: func(ctx context.Context, id string, refs []secretmgr.Ref) (map[secretmgr.Ref]string, error) {
			if id == "" {
				id = workspaceID
			}
			return linkedSecrets.resolve(ctx, id, refs)
		},
		fields: func(ctx context.Context, id string, item secretmgr.Import) ([]string, error) {
			if id == "" {
				id = workspaceID
			}
			return linkedSecrets.importFields(ctx, id, item)
		},
	}
}

func skippedLinkedSecrets() *cliLinkedSecrets {
	return &cliLinkedSecrets{skip: true}
}

func disabledLinkedSecrets(reason, hint string) *cliLinkedSecrets {
	return &cliLinkedSecrets{disabled: reason, hint: hint}
}

func (l *cliLinkedSecrets) fetch(workspaceID string, rows map[string]secretmgr.Ref, known map[string]string) (map[string]string, error) {
	keys := make([]string, 0, len(rows))
	for key := range rows {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	hint := "--var"
	if l != nil && l.hint != "" {
		hint = l.hint
	}
	if l != nil && l.skip {
		return map[string]string{}, nil
	}
	if l != nil && l.filtered {
		used := l.needed(known, rows)
		needed := keys[:0]
		for _, key := range keys {
			if used[key] {
				needed = append(needed, key)
			}
		}
		keys = needed
	}
	if len(keys) == 0 {
		return map[string]string{}, nil
	}
	if l == nil || l.disabled != "" {
		reason := "this command does not read secret managers"
		if l != nil {
			reason = l.disabled
		}
		return nil, fmt.Errorf("%s %s linked to a secret manager and %s. %s", strings.Join(keys, ", "), linkedVerb(len(keys)), reason, linkedOverrideHint(hint, keys[0]))
	}
	refs := make([]secretmgr.Ref, 0, len(keys))
	for _, key := range keys {
		refs = append(refs, rows[key])
	}
	values, err := l.resolve(context.Background(), workspaceID, refs)
	if err != nil {
		return nil, linkedResolveError(err, keys, rows, hint)
	}
	out := make(map[string]string, len(keys))
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.fetched == nil {
		l.fetched = map[string]string{}
	}
	for _, key := range keys {
		value := values[rows[key]]
		out[key] = value
		l.fetched[key] = value
	}
	return out, nil
}

func linkedOverrideHint(hint, key string) string {
	if hint == "app" {
		return "Check the link and the provider in Secret providers, then run again."
	}
	if hint == "variables" {
		return fmt.Sprintf("Pass a value for %s in variables, or ask the user to send the request in Kurlo.", key)
	}
	return fmt.Sprintf("Pass a value with --var %s=… or --env-file.", key)
}

func linkedResolveError(err error, keys []string, rows map[string]secretmgr.Ref, hint string) error {
	var resolveErr *secretmgr.ResolveError
	if !errors.As(err, &resolveErr) {
		return fmt.Errorf("cannot get linked secrets: %v. %s", err, linkedOverrideHint(hint, keys[0]))
	}
	lines := make([]string, 0, len(resolveErr.Failures))
	first := ""
	for _, failure := range resolveErr.Failures {
		var names []string
		for _, key := range keys {
			if rows[key] == failure.Ref {
				names = append(names, key)
			}
		}
		if first == "" && len(names) > 0 {
			first = names[0]
		}
		message := failure.Err.Error()
		var typed *secretmgr.Error
		if errors.As(failure.Err, &typed) {
			message = typed.Message
		}
		lines = append(lines, fmt.Sprintf("  %s ← %s: %s", strings.Join(names, ", "), failure.Ref.String(), message))
	}
	if first == "" {
		first = keys[0]
	}
	return fmt.Errorf("cannot get linked secrets:\n%s\n%s", strings.Join(lines, "\n"), linkedOverrideHint(hint, first))
}

func (l *cliLinkedSecrets) withoutFetched(values map[string]string) map[string]string {
	if l == nil {
		return values
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.fetched) == 0 {
		return values
	}
	out := make(map[string]string, len(values))
	for key, value := range values {
		if fetched, ok := l.fetched[key]; ok && fetched == value {
			continue
		}
		out[key] = value
	}
	return out
}

func managerImportFields(manager *secretmgr.Manager) func(context.Context, string, secretmgr.Import) ([]string, error) {
	return func(ctx context.Context, workspaceID string, item secretmgr.Import) ([]string, error) {
		secret, _, err := manager.Fetch(ctx, workspaceID, item.Ref(""))
		if err != nil {
			return nil, err
		}
		return secret.FieldNames(), nil
	}
}

func (l *cliLinkedSecrets) expandImports(workspaceID string, imports []secretmgr.Import, defined map[string]string, linked map[string]secretmgr.Ref) (map[string]secretmgr.Ref, error) {
	out := map[string]secretmgr.Ref{}
	if len(imports) == 0 || l == nil || l.skip {
		return out, nil
	}
	var needed []string
	if l.filtered {
		needed = slices.Sorted(maps.Keys(l.needed(defined, linked)))
	}
	for _, item := range imports {
		keys := item.Keys
		if !item.Filtered() {
			if l.filtered {
				var candidate string
				for _, name := range needed {
					if _, explicit := linked[name]; !explicit && strings.HasPrefix(name, item.Prefix) {
						candidate = name
						break
					}
				}
				if candidate == "" {
					continue
				}
				if l.disabled != "" {
					return nil, fmt.Errorf("%s may come from %s and %s. %s", candidate, item.String(), l.disabled, linkedOverrideHint(l.hint, candidate))
				}
			}
			if l.disabled != "" || l.fields == nil {
				continue
			}
			fields, err := l.fields(context.Background(), workspaceID, item)
			if err != nil {
				return nil, fmt.Errorf("cannot list the keys of %s: %s. Add keys to the source in the environment, or pass the values with %s", item.String(), linkedErrorText(err), overrideNoun(l.hint))
			}
			keys = fields
		}
		for _, key := range keys {
			variable := item.Variable(key)
			if _, explicit := defined[variable]; explicit {
				continue
			}
			if _, explicit := linked[variable]; explicit {
				continue
			}
			out[variable] = item.Ref(key)
		}
	}
	return out, nil
}

func linkedErrorText(err error) string {
	var typed *secretmgr.Error
	if errors.As(err, &typed) {
		return typed.Message
	}
	return err.Error()
}

func overrideNoun(hint string) string {
	switch hint {
	case "variables":
		return "variables"
	case "app":
		return "the environment"
	default:
		return "--var or --env-file"
	}
}
