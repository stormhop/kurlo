package api

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	secretmgr "github.com/stormhop/kurlo/apps/desktop/internal/secrets"
)

type SecretRefInput struct {
	Provider string `json:"provider"`
	Path     string `json:"path"`
	Field    string `json:"field,omitempty"`
	Version  string `json:"version,omitempty"`
}

func (r SecretRefInput) ref() secretmgr.Ref {
	return secretmgr.Ref{Provider: strings.TrimSpace(r.Provider), Path: strings.TrimSpace(r.Path), Field: strings.TrimSpace(r.Field), Version: strings.TrimSpace(r.Version)}
}

type SecretProviderUsage struct {
	EnvironmentID   string `json:"environmentId"`
	EnvironmentName string `json:"environmentName"`
	Key             string `json:"key"`
	Path            string `json:"path"`
	Field           string `json:"field,omitempty"`
	Import          bool   `json:"import,omitempty"`
}

type SecretImportInput struct {
	Provider string `json:"provider"`
	Path     string `json:"path"`
	Version  string `json:"version,omitempty"`
}

func (i SecretImportInput) item() secretmgr.Import {
	return secretmgr.Import{Provider: strings.TrimSpace(i.Provider), Path: strings.TrimSpace(i.Path), Version: strings.TrimSpace(i.Version)}
}

type SecretImportKeys struct {
	Provider string   `json:"provider"`
	Path     string   `json:"path"`
	Version  string   `json:"version,omitempty"`
	Keys     []string `json:"keys"`
	LoadedAt int64    `json:"loadedAt"`
}

type SecretImportKeysResult struct {
	Ok         bool     `json:"ok"`
	Kind       string   `json:"kind,omitempty"`
	Message    string   `json:"message,omitempty"`
	Keys       []string `json:"keys"`
	LoadedAt   int64    `json:"loadedAt"`
	DurationMs int64    `json:"durationMs"`
}

type SecretProviderView struct {
	ID               string                `json:"id"`
	Type             string                `json:"type"`
	Name             string                `json:"name"`
	Config           map[string]any        `json:"config"`
	Valid            bool                  `json:"valid"`
	Problem          string                `json:"problem,omitempty"`
	Trusted          bool                  `json:"trusted"`
	TrustChanged     bool                  `json:"trustChanged"`
	SavedCredentials []string              `json:"savedCredentials"`
	UsedBy           []SecretProviderUsage `json:"usedBy"`
}

type SecretProvidersResult struct {
	Providers    []SecretProviderView `json:"providers"`
	CachedValues int                  `json:"cachedValues"`
	Error        string               `json:"error,omitempty"`
}

type SecretProviderStatus struct {
	ProviderID string   `json:"providerId"`
	Ok         bool     `json:"ok"`
	Kind       string   `json:"kind,omitempty"`
	Message    string   `json:"message,omitempty"`
	Detail     string   `json:"detail,omitempty"`
	ExpiresIn  int64    `json:"expiresInSeconds,omitempty"`
	Policies   []string `json:"policies,omitempty"`
	DurationMs int64    `json:"durationMs"`
}

type SecretRefTestResult struct {
	Ok         bool     `json:"ok"`
	Kind       string   `json:"kind,omitempty"`
	Message    string   `json:"message,omitempty"`
	Length     int      `json:"length"`
	Fields     []string `json:"fields"`
	DurationMs int64    `json:"durationMs"`
}

type SecretRevealResult struct {
	Value   string `json:"value"`
	Kind    string `json:"kind,omitempty"`
	Message string `json:"message,omitempty"`
}

type SecretBrowseResult struct {
	Ok         bool              `json:"ok"`
	Kind       string            `json:"kind,omitempty"`
	Message    string            `json:"message,omitempty"`
	Prefix     string            `json:"prefix"`
	Entries    []secretmgr.Entry `json:"entries"`
	DurationMs int64             `json:"durationMs"`
}

type SecretActionResult struct {
	Ok    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func secretActionResult(err error) SecretActionResult {
	if err != nil {
		return SecretActionResult{Error: err.Error()}
	}
	return SecretActionResult{Ok: true}
}

func secretErrorFields(err error) (string, string) {
	var typed *secretmgr.Error
	if errors.As(err, &typed) {
		return string(typed.Kind), typed.Message
	}
	return string(secretmgr.KindUnavailable), err.Error()
}

func (a *App) secretContext() context.Context {
	if a.ctx != nil {
		return a.ctx
	}
	return context.Background()
}

func (a *App) ListSecretProviders(workspaceID string) SecretProvidersResult {
	result := SecretProvidersResult{Providers: []SecretProviderView{}, CachedValues: linkedSecrets.manager.CachedCount()}
	linkedSecrets.mu.Lock()
	dir, ok := linkedSecrets.workspaceDir(workspaceID)
	linkedSecrets.mu.Unlock()
	if !ok {
		result.Error = "workspace is not on disk"
		return result
	}
	usage := secretProviderUsage(dir)
	for _, raw := range readWorkspaceSecretProviders(dir) {
		view := SecretProviderView{
			ID:               strings.TrimSpace(fmt.Sprint(raw["id"])),
			Type:             strings.TrimSpace(fmt.Sprint(raw["type"])),
			Name:             strings.TrimSpace(stringFromAny(raw["name"])),
			Config:           raw,
			SavedCredentials: []string{},
			UsedBy:           []SecretProviderUsage{},
		}
		config, err := secretmgr.ParseProvider(raw)
		if err != nil {
			view.Problem = err.Error()
		} else {
			view.Valid = true
			view.Name = config.DisplayName()
			view.Trusted = linkedSecrets.Trusted(workspaceID, config)
			view.TrustChanged = !view.Trusted && linkedSecrets.trustChanged(workspaceID, config)
		}
		if names := linkedSecrets.savedCredentialNames(workspaceID, view.ID); len(names) > 0 {
			view.SavedCredentials = names
		}
		if used := usage[view.ID]; len(used) > 0 {
			view.UsedBy = used
		}
		result.Providers = append(result.Providers, view)
	}
	return result
}

func secretProviderUsage(dir string) map[string][]SecretProviderUsage {
	usage := map[string][]SecretProviderUsage{}
	envDir := filepath.Join(dir, fileStoreEnvironmentsDir)
	entries, err := os.ReadDir(envDir)
	if err != nil {
		return usage
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), fileStoreYAMLExt) {
			continue
		}
		var doc filesystemEnvironmentFile
		if err := readYAMLFile(filepath.Join(envDir, entry.Name()), &doc); err != nil {
			continue
		}
		environment, _ := doc.Environment.(map[string]any)
		imports, _ := secretmgr.ImportsFromAny(environment["secretSources"])
		for _, item := range imports {
			usage[item.Provider] = append(usage[item.Provider], SecretProviderUsage{
				EnvironmentID:   stringValue(environment, "id"),
				EnvironmentName: stringValue(environment, "name"),
				Key:             item.Prefix + "*",
				Path:            item.Path,
				Import:          true,
			})
		}
		rows, _ := environment["values"].([]any)
		for _, rawRow := range rows {
			row, ok := rawRow.(map[string]any)
			if !ok {
				continue
			}
			ref, linked := secretmgr.RefFromMap(row["secretRef"])
			if !linked {
				continue
			}
			usage[ref.Provider] = append(usage[ref.Provider], SecretProviderUsage{
				EnvironmentID:   stringValue(environment, "id"),
				EnvironmentName: stringValue(environment, "name"),
				Key:             stringFromAny(row["key"]),
				Path:            ref.Path,
				Field:           ref.Field,
			})
		}
	}
	for id := range usage {
		sort.Slice(usage[id], func(i, j int) bool {
			if usage[id][i].EnvironmentName != usage[id][j].EnvironmentName {
				return usage[id][i].EnvironmentName < usage[id][j].EnvironmentName
			}
			return usage[id][i].Key < usage[id][j].Key
		})
	}
	return usage
}

func updateWorkspaceSecretProviders(workspaceID string, update func([]map[string]any) ([]map[string]any, error)) error {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := linkedSecrets.root()
	linkedSecrets.mu.Lock()
	dir, ok := linkedSecrets.workspaceDir(workspaceID)
	linkedSecrets.mu.Unlock()
	if !ok {
		return errors.New("workspace is not on disk")
	}
	path := filepath.Join(dir, fileStoreRootFileName)
	var doc filesystemWorkspaceFile
	if err := readYAMLFile(path, &doc); err != nil {
		return err
	}
	next, err := update(append([]map[string]any(nil), doc.SecretProviders...))
	if err != nil {
		return err
	}
	doc.SecretProviders = next
	if err := writeYAMLFile(path, doc); err != nil {
		return err
	}
	if rel, err := filepath.Rel(root, path); err == nil {
		if err := workspaceDisk.noteDeltaWrites(root, []string{filepath.ToSlash(rel)}, nil); err != nil {
			workspaceDisk.forgetSavedShape()
		}
	}
	return nil
}

func cleanProviderMap(provider map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range provider {
		switch typed := value.(type) {
		case string:
			if strings.TrimSpace(typed) != "" {
				out[key] = strings.TrimSpace(typed)
			}
		case bool:
			if typed {
				out[key] = true
			}
		case map[string]any:
			if nested := cleanProviderMap(typed); len(nested) > 0 {
				out[key] = nested
			}
		case nil:
		default:
			out[key] = typed
		}
	}
	return out
}

func (a *App) SaveSecretProvider(workspaceID string, provider map[string]any) SecretActionResult {
	clean := cleanProviderMap(provider)
	config, err := secretmgr.ParseProvider(clean)
	if err != nil {
		return secretActionResult(err)
	}
	err = updateWorkspaceSecretProviders(workspaceID, func(existing []map[string]any) ([]map[string]any, error) {
		for index, item := range existing {
			if strings.TrimSpace(fmt.Sprint(item["id"])) == config.ID {
				existing[index] = clean
				return existing, nil
			}
		}
		return append(existing, clean), nil
	})
	if err != nil {
		return secretActionResult(err)
	}
	linkedSecrets.manager.ForgetProvider(workspaceID, config.ID)
	return secretActionResult(linkedSecrets.trust(workspaceID, config.ID))
}

func (a *App) DeleteSecretProvider(workspaceID, providerID string) SecretActionResult {
	err := updateWorkspaceSecretProviders(workspaceID, func(existing []map[string]any) ([]map[string]any, error) {
		next := existing[:0]
		found := false
		for _, item := range existing {
			if strings.TrimSpace(fmt.Sprint(item["id"])) == providerID {
				found = true
				continue
			}
			next = append(next, item)
		}
		if !found {
			return nil, fmt.Errorf("no secret provider %q", providerID)
		}
		return next, nil
	})
	if err != nil {
		return secretActionResult(err)
	}
	_ = linkedSecrets.revokeTrust(workspaceID, providerID)
	return secretActionResult(linkedSecrets.forgetCredentials(workspaceID, providerID))
}

func (a *App) TestSecretProvider(workspaceID, providerID string) SecretProviderStatus {
	started := time.Now()
	status, err := linkedSecrets.manager.Check(a.secretContext(), workspaceID, providerID)
	out := SecretProviderStatus{ProviderID: providerID, DurationMs: time.Since(started).Milliseconds()}
	if err != nil {
		out.Kind, out.Message = secretErrorFields(err)
		return out
	}
	out.Ok = true
	out.Detail = status.Detail
	out.ExpiresIn = status.ExpiresIn
	out.Policies = status.Policies
	return out
}

func (a *App) TestSecretRef(workspaceID string, input SecretRefInput) SecretRefTestResult {
	started := time.Now()
	ref := input.ref()
	out := SecretRefTestResult{Fields: []string{}}
	if !ref.Valid() {
		out.Kind, out.Message = string(secretmgr.KindInvalidRef), "choose a provider and a path"
		return out
	}
	secret, config, err := linkedSecrets.manager.Fetch(a.secretContext(), workspaceID, ref)
	out.DurationMs = time.Since(started).Milliseconds()
	if err != nil {
		out.Kind, out.Message = secretErrorFields(err)
		return out
	}
	out.Fields = secret.FieldNames()
	value, err := secret.Value(config.ID, ref)
	if err != nil {
		out.Kind, out.Message = secretErrorFields(err)
		return out
	}
	out.Ok = true
	out.Length = len([]rune(value))
	return out
}

func (a *App) RevealSecretRef(workspaceID string, input SecretRefInput) SecretRevealResult {
	ref := input.ref()
	if !ref.Valid() {
		return SecretRevealResult{Kind: string(secretmgr.KindInvalidRef), Message: "choose a provider and a path"}
	}
	value, err := linkedSecrets.manager.Value(a.secretContext(), workspaceID, ref)
	if err != nil {
		kind, message := secretErrorFields(err)
		return SecretRevealResult{Kind: kind, Message: message}
	}
	return SecretRevealResult{Value: value}
}

func (a *App) TrustSecretProvider(workspaceID, providerID string) SecretActionResult {
	return secretActionResult(linkedSecrets.trust(workspaceID, providerID))
}

func (a *App) RevokeSecretProviderTrust(workspaceID, providerID string) SecretActionResult {
	return secretActionResult(linkedSecrets.revokeTrust(workspaceID, providerID))
}

func (a *App) SetSecretProviderCredential(workspaceID, providerID, name, value string) SecretActionResult {
	return secretActionResult(linkedSecrets.setCredential(workspaceID, providerID, name, value))
}

func (a *App) ConnectSecretProvider(workspaceID, providerID string) SecretProviderStatus {
	started := time.Now()
	out := SecretProviderStatus{ProviderID: providerID}
	credentials, err := linkedSecrets.manager.Associate(a.secretContext(), workspaceID, providerID)
	if err == nil {
		for _, name := range []string{"associationId", "associationKey"} {
			if err = linkedSecrets.setCredential(workspaceID, providerID, name, credentials[name]); err != nil {
				break
			}
		}
	}
	out.DurationMs = time.Since(started).Milliseconds()
	if err != nil {
		out.Kind, out.Message = secretErrorFields(err)
		return out
	}
	out.Ok = true
	out.Detail = "Connected to KeePassXC as " + credentials["associationId"]
	return out
}

func (a *App) ForgetSecretProviderCredentials(workspaceID, providerID string) SecretActionResult {
	return secretActionResult(linkedSecrets.forgetCredentials(workspaceID, providerID))
}

func (a *App) ClearSecretCache() int {
	return linkedSecrets.clearCache()
}

func (a *App) ListSecretImportKeys(workspaceID string) []SecretImportKeys {
	out := []SecretImportKeys{}
	for key, keyset := range linkedSecrets.importKeys(workspaceID) {
		head, rest, _ := strings.Cut(strings.TrimPrefix(key, workspaceID+"/"), "\x00")
		path, version, _ := strings.Cut(rest, "\x00")
		keys := keyset.Keys
		if keys == nil {
			keys = []string{}
		}
		out = append(out, SecretImportKeys{Provider: head, Path: path, Version: version, Keys: keys, LoadedAt: keyset.LoadedAt})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Provider != out[j].Provider {
			return out[i].Provider < out[j].Provider
		}
		return out[i].Path < out[j].Path
	})
	return out
}

func (a *App) LoadSecretImportKeys(workspaceID string, input SecretImportInput) SecretImportKeysResult {
	started := time.Now()
	item := input.item()
	out := SecretImportKeysResult{Keys: []string{}}
	if item.Provider == "" || item.Path == "" {
		out.Kind, out.Message = string(secretmgr.KindInvalidRef), "choose a provider and a path"
		return out
	}
	secret, _, err := linkedSecrets.manager.Refresh(a.secretContext(), workspaceID, item.Ref(""))
	out.DurationMs = time.Since(started).Milliseconds()
	if err != nil {
		out.Kind, out.Message = secretErrorFields(err)
		return out
	}
	keys := secret.FieldNames()
	if len(keys) == 0 {
		out.Kind, out.Message = string(secretmgr.KindInvalidRef), item.Path+" holds a single value, not a set of keys; link it to one variable instead"
		return out
	}
	keyset, err := linkedSecrets.rememberImportKeys(workspaceID, item, keys, started)
	if err != nil {
		out.Kind, out.Message = string(secretmgr.KindUnavailable), "cannot save the key names on this device: "+err.Error()
		return out
	}
	out.Ok = true
	out.LoadedAt = keyset.LoadedAt
	out.Keys = keyset.Keys
	return out
}

func (a *App) BrowseSecretProvider(workspaceID, providerID, prefix string) SecretBrowseResult {
	started := time.Now()
	out := SecretBrowseResult{Prefix: prefix, Entries: []secretmgr.Entry{}}
	entries, err := linkedSecrets.manager.List(a.secretContext(), workspaceID, providerID, prefix)
	out.DurationMs = time.Since(started).Milliseconds()
	if err != nil {
		out.Kind, out.Message = secretErrorFields(err)
		return out
	}
	out.Ok = true
	out.Entries = entries
	return out
}
