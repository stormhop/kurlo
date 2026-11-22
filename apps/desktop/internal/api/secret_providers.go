package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	secretmgr "github.com/stormhop/kurlo/apps/desktop/internal/secrets"
)

const secretProviderStateFile = "secret-providers.json"

var secretProviderCredentialNames = map[string]bool{
	"token": true, "secretId": true, "accessKeyId": true, "secretAccessKey": true, "sessionToken": true,
	"clientSecret": true, "serviceAccountKey": true, "username": true, "password": true, "mfaCode": true,
}

type secretProviderDeviceState struct {
	Version     int                           `json:"version"`
	Trust       map[string]string             `json:"trust"`
	Credentials map[string]map[string]string  `json:"credentials"`
	ImportKeys  map[string]secretImportKeyset `json:"importKeys,omitempty"`
}

type secretImportKeyset struct {
	started  time.Time
	Keys     []string `json:"keys"`
	LoadedAt int64    `json:"loadedAt"`
}

func importKeysetKey(workspaceID string, item secretmgr.Import) string {
	return providerStateKey(workspaceID, item.Provider) + "\x00" + item.Path + "\x00" + item.Version
}

type workspaceSecretFiles struct {
	stamp     string
	configs   []secretmgr.ProviderConfig
	problems  []error
	refs      map[secretmgr.Ref]bool
	imports   []secretmgr.Import
	workspace string
}

type linkedSecretService struct {
	root      func() string
	statePath func() string
	manager   *secretmgr.Manager

	mu        sync.Mutex
	dirs      map[string]string
	files     map[string]*workspaceSecretFiles
	state     *secretProviderDeviceState
	stateLoad error
	mfaCodes  map[string]string
}

var linkedSecrets = newLinkedSecretService(fileWorkspaceStorePath, func() string {
	return filepath.Join(requestStoreDir(), secretProviderStateFile)
}, secretmgr.SystemEnvironment())

func newLinkedSecretService(root func() string, statePath func() string, env secretmgr.Environment) *linkedSecretService {
	service := &linkedSecretService{root: root, statePath: statePath, dirs: map[string]string{}, files: map[string]*workspaceSecretFiles{}}
	service.manager = secretmgr.NewManager(service, env)
	return service
}

func providerStateKey(workspaceID, providerID string) string {
	return workspaceID + "/" + providerID
}

func readWorkspaceSecretProviders(workspaceDir string) []map[string]any {
	if workspaceDir == "" {
		return nil
	}
	var doc filesystemWorkspaceFile
	if err := readYAMLFile(filepath.Join(workspaceDir, fileStoreRootFileName), &doc); err != nil {
		return nil
	}
	return doc.SecretProviders
}

func secretProviderDiagnostics(root, workspacePath, workspaceID string, rawProviders []map[string]any, environments []map[string]any) []WorkspaceDiagnostic {
	var diagnostics []WorkspaceDiagnostic
	workspaceFile := filepath.Join(workspacePath, fileStoreRootFileName)
	configs, problems := secretmgr.ParseProviders(rawProviders)
	for _, problem := range problems {
		diagnostics = append(diagnostics, workspaceDiagnostic{scope: "workspace", path: workspaceFile, root: root, message: problem.Error(), workspaceID: workspaceID}.toDiagnostic())
	}
	known := map[string]bool{}
	for _, config := range configs {
		known[config.ID] = true
	}
	for _, raw := range rawProviders {
		if id := strings.TrimSpace(fmt.Sprint(raw["id"])); id != "" {
			known[id] = true
		}
	}
	for _, environment := range environments {
		name := stringValue(environment, "name")
		path := filepath.Join(workspacePath, fileStoreEnvironmentsDir, stringValue(environment, filesystemNameField)+fileStoreYAMLExt)
		report := func(message string) {
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "environment", path: path, root: root, workspaceID: workspaceID, message: message}.toDiagnostic())
		}
		imports, invalid := secretmgr.ImportsFromAny(environment["secretSources"])
		if raw, present := environment["secretSources"]; present && raw != nil {
			if _, isList := raw.([]any); !isList {
				report(fmt.Sprintf("secretSources in environment %q must be a list.", name))
			}
		}
		for _, index := range invalid {
			report(fmt.Sprintf("secretSources[%d] in environment %q needs a provider and a path.", index, name))
		}
		owners := map[string]string{}
		for _, item := range imports {
			if !known[item.Provider] {
				report(fmt.Sprintf("Environment %q imports %s from secret provider %q, which is not in workspace.yml.", name, item.Path, item.Provider))
			}
			for _, key := range item.Keys {
				variable := item.Variable(key)
				if other, taken := owners[variable]; taken && other != item.String() {
					report(fmt.Sprintf("Environment %q imports %s from both %s and %s; rename one with prefix or remove it from keys.", name, variable, other, item.String()))
					continue
				}
				owners[variable] = item.String()
			}
		}
		rows, _ := environment["values"].([]any)
		for _, rawRow := range rows {
			row, ok := rawRow.(map[string]any)
			if !ok || row["secretRef"] == nil {
				continue
			}
			ref, valid := secretmgr.RefFromMap(row["secretRef"])
			key := stringFromAny(row["key"])
			name := stringValue(environment, "name")
			path := filepath.Join(workspacePath, fileStoreEnvironmentsDir, stringValue(environment, filesystemNameField)+fileStoreYAMLExt)
			switch {
			case !valid:
				diagnostics = append(diagnostics, workspaceDiagnostic{scope: "environment", path: path, root: root, workspaceID: workspaceID,
					message: fmt.Sprintf("Variable %q in environment %q has a secretRef without provider or path.", key, name)}.toDiagnostic())
			case !known[ref.Provider]:
				diagnostics = append(diagnostics, workspaceDiagnostic{scope: "environment", path: path, root: root, workspaceID: workspaceID,
					message: fmt.Sprintf("Variable %q in environment %q links to secret provider %q, which is not in workspace.yml.", key, name, ref.Provider)}.toDiagnostic())
			}
		}
	}
	return diagnostics
}

func (s *linkedSecretService) workspaceDir(workspaceID string) (string, bool) {
	root := s.root()
	if dir, ok := s.dirs[workspaceID]; ok && strings.HasPrefix(dir, root) {
		if _, err := os.Stat(filepath.Join(dir, fileStoreRootFileName)); err == nil {
			return dir, true
		}
	}
	s.dirs = workspaceDirsByID(filepath.Join(root, fileStoreWorkspacesDir))
	dir, ok := s.dirs[workspaceID]
	return dir, ok
}

func workspaceSecretStamp(dir string) string {
	var parts []string
	if info, err := os.Stat(filepath.Join(dir, fileStoreRootFileName)); err == nil {
		parts = append(parts, fmt.Sprintf("w:%d:%d", info.ModTime().UnixNano(), info.Size()))
	}
	envDir := filepath.Join(dir, fileStoreEnvironmentsDir)
	if entries, err := os.ReadDir(envDir); err == nil {
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), fileStoreYAMLExt) {
				continue
			}
			if info, err := entry.Info(); err == nil {
				parts = append(parts, fmt.Sprintf("%s:%d:%d", entry.Name(), info.ModTime().UnixNano(), info.Size()))
			}
		}
	}
	return strings.Join(parts, "|")
}

func (s *linkedSecretService) workspaceFiles(workspaceID string) (*workspaceSecretFiles, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, ok := s.workspaceDir(workspaceID)
	if !ok {
		return nil, fmt.Errorf("workspace %s is not on disk", workspaceID)
	}
	stamp := workspaceSecretStamp(dir)
	if cached, ok := s.files[workspaceID]; ok && cached.stamp == stamp && cached.workspace == dir {
		return cached, nil
	}
	configs, problems := secretmgr.ParseProviders(readWorkspaceSecretProviders(dir))
	refs := map[secretmgr.Ref]bool{}
	var imports []secretmgr.Import
	envDir := filepath.Join(dir, fileStoreEnvironmentsDir)
	if entries, err := os.ReadDir(envDir); err == nil {
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), fileStoreYAMLExt) {
				continue
			}
			var doc filesystemEnvironmentFile
			if err := readYAMLFile(filepath.Join(envDir, entry.Name()), &doc); err != nil {
				continue
			}
			environment, _ := doc.Environment.(map[string]any)
			rows, _ := environment["values"].([]any)
			for _, rawRow := range rows {
				if row, ok := rawRow.(map[string]any); ok {
					if ref, valid := secretmgr.RefFromMap(row["secretRef"]); valid {
						refs[ref] = true
					}
				}
			}
			found, _ := secretmgr.ImportsFromAny(environment["secretSources"])
			imports = append(imports, found...)
		}
	}
	files := &workspaceSecretFiles{stamp: stamp, configs: configs, problems: problems, refs: refs, imports: imports, workspace: dir}
	s.files[workspaceID] = files
	return files, nil
}

func (s *linkedSecretService) Providers(workspaceID string) ([]secretmgr.ProviderConfig, error) {
	files, err := s.workspaceFiles(workspaceID)
	if err != nil {
		return nil, err
	}
	return files.configs, nil
}

func (s *linkedSecretService) loadStateLocked() *secretProviderDeviceState {
	if s.state != nil {
		return s.state
	}
	state := &secretProviderDeviceState{Version: 1, Trust: map[string]string{}, Credentials: map[string]map[string]string{}}
	s.stateLoad = nil
	if data, err := os.ReadFile(s.statePath()); err == nil {
		plaintext, err := decryptRequestStorePayload(data)
		if err == nil {
			err = json.Unmarshal(plaintext, state)
		}
		if err != nil {
			s.stateLoad = err
			state = &secretProviderDeviceState{Version: 1}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		s.stateLoad = err
	}
	if state.Trust == nil {
		state.Trust = map[string]string{}
	}
	if state.Credentials == nil {
		state.Credentials = map[string]map[string]string{}
	}
	s.state = state
	return state
}

func (s *linkedSecretService) saveStateLocked() error {
	state := s.loadStateLocked()
	plaintext, err := json.Marshal(state)
	if err != nil {
		return err
	}
	encrypted, err := encryptRequestStorePayload(plaintext)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.statePath()), 0o700); err != nil {
		return err
	}
	if err := writeFileAtomicMode(s.statePath(), encrypted, 0o600); err != nil {
		return err
	}
	s.stateLoad = nil
	return nil
}

func (s *linkedSecretService) Trusted(workspaceID string, config secretmgr.ProviderConfig) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadStateLocked().Trust[providerStateKey(workspaceID, config.ID)] == config.Hash()
}

func (s *linkedSecretService) trustChanged(workspaceID string, config secretmgr.ProviderConfig) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	hash, ok := s.loadStateLocked().Trust[providerStateKey(workspaceID, config.ID)]
	return ok && hash != config.Hash()
}

func (s *linkedSecretService) Credentials(workspaceID, providerID string) secretmgr.Credentials {
	key := providerStateKey(workspaceID, providerID)
	return func(name string) (string, bool) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if name == "mfaCode" {
			code, ok := s.mfaCodes[key]
			delete(s.mfaCodes, key)
			return code, ok && code != ""
		}
		value, ok := s.loadStateLocked().Credentials[key][name]
		return value, ok && value != ""
	}
}

func (s *linkedSecretService) trust(workspaceID, providerID string) error {
	config, err := s.manager.Config(workspaceID, providerID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadStateLocked().Trust[providerStateKey(workspaceID, providerID)] = config.Hash()
	return s.saveStateLocked()
}

func (s *linkedSecretService) revokeTrust(workspaceID, providerID string) error {
	s.mu.Lock()
	delete(s.loadStateLocked().Trust, providerStateKey(workspaceID, providerID))
	err := s.saveStateLocked()
	s.mu.Unlock()
	s.manager.ForgetProvider(workspaceID, providerID)
	return err
}

func (s *linkedSecretService) setCredential(workspaceID, providerID, name, value string) error {
	if !secretProviderCredentialNames[name] {
		return fmt.Errorf("unknown credential %q", name)
	}
	if problem := secretmgr.CredentialProblem(name, value); problem != "" {
		return fmt.Errorf("%s %s", credentialLabel(name), problem)
	}
	if name == "mfaCode" {
		s.mu.Lock()
		if s.mfaCodes == nil {
			s.mfaCodes = map[string]string{}
		}
		s.mfaCodes[providerStateKey(workspaceID, providerID)] = strings.TrimSpace(value)
		s.mu.Unlock()
		s.manager.ForgetProvider(workspaceID, providerID)
		return nil
	}
	s.mu.Lock()
	state := s.loadStateLocked()
	key := providerStateKey(workspaceID, providerID)
	if strings.TrimSpace(value) == "" {
		delete(state.Credentials[key], name)
	} else {
		if state.Credentials[key] == nil {
			state.Credentials[key] = map[string]string{}
		}
		if name == "password" {
			state.Credentials[key][name] = value
		} else {
			state.Credentials[key][name] = strings.TrimSpace(value)
		}
	}
	err := s.saveStateLocked()
	s.mu.Unlock()
	s.manager.ForgetProvider(workspaceID, providerID)
	return err
}

func (s *linkedSecretService) forgetCredentials(workspaceID, providerID string) error {
	s.mu.Lock()
	delete(s.loadStateLocked().Credentials, providerStateKey(workspaceID, providerID))
	err := s.saveStateLocked()
	s.mu.Unlock()
	s.manager.ForgetProvider(workspaceID, providerID)
	return err
}

func (s *linkedSecretService) savedCredentialNames(workspaceID, providerID string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var names []string
	for name, value := range s.loadStateLocked().Credentials[providerStateKey(workspaceID, providerID)] {
		if value != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

func (s *linkedSecretService) authorize(workspaceID string, refs []secretmgr.Ref) ([]secretmgr.Failure, error) {
	if workspaceID == "" {
		return nil, errors.New("linked secrets need the workspace of the request")
	}
	files, err := s.workspaceFiles(workspaceID)
	if err != nil {
		return nil, err
	}
	var failures []secretmgr.Failure
	for _, ref := range refs {
		if !files.refs[ref] && !importsAllow(files.imports, ref) {
			failures = append(failures, secretmgr.Failure{Ref: ref, Err: &secretmgr.Error{Kind: secretmgr.KindInvalidRef, Provider: ref.Provider,
				Message: "this link is not in any saved environment of the workspace; save the environment and send again"}})
		}
	}
	return failures, nil
}

func importsAllow(imports []secretmgr.Import, ref secretmgr.Ref) bool {
	for _, item := range imports {
		if item.Matches(ref) {
			return true
		}
	}
	return false
}

func (s *linkedSecretService) importFields(ctx context.Context, workspaceID string, item secretmgr.Import) ([]string, error) {
	files, err := s.workspaceFiles(workspaceID)
	if err != nil {
		return nil, err
	}
	saved := false
	for _, candidate := range files.imports {
		saved = saved || (candidate.Provider == item.Provider && candidate.Path == item.Path && candidate.Version == item.Version)
	}
	if !saved {
		return nil, &secretmgr.Error{Kind: secretmgr.KindInvalidRef, Provider: item.Provider, Message: "this source is not in any saved environment of the workspace"}
	}
	secret, _, err := s.manager.Fetch(ctx, workspaceID, item.Ref(""))
	if err != nil {
		return nil, err
	}
	return secret.FieldNames(), nil
}

func (s *linkedSecretService) importKeys(workspaceID string) map[string]secretImportKeyset {
	s.mu.Lock()
	defer s.mu.Unlock()
	prefix := workspaceID + "/"
	out := map[string]secretImportKeyset{}
	for key, keyset := range s.loadStateLocked().ImportKeys {
		if strings.HasPrefix(key, prefix) {
			out[key] = keyset
		}
	}
	return out
}

func (s *linkedSecretService) rememberImportKeys(workspaceID string, item secretmgr.Import, keys []string, started time.Time) (secretImportKeyset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.loadStateLocked()
	if state.ImportKeys == nil {
		state.ImportKeys = map[string]secretImportKeyset{}
	}
	key := importKeysetKey(workspaceID, item)
	previous, exists := state.ImportKeys[key]
	if previous.started.After(started) {
		return previous, nil
	}
	updated := secretImportKeyset{Keys: keys, LoadedAt: time.Now().UnixMilli(), started: started}
	state.ImportKeys[key] = updated
	if err := s.saveStateLocked(); err != nil {
		if exists {
			state.ImportKeys[key] = previous
		} else {
			delete(state.ImportKeys, key)
		}
		return secretImportKeyset{}, err
	}
	return updated, nil
}

func (s *linkedSecretService) resolve(ctx context.Context, workspaceID string, refs []secretmgr.Ref) (map[secretmgr.Ref]string, error) {
	if len(refs) == 0 {
		return map[secretmgr.Ref]string{}, nil
	}
	failures, err := s.authorize(workspaceID, refs)
	if err != nil {
		return nil, err
	}
	if len(failures) > 0 {
		return nil, &secretmgr.ResolveError{Failures: failures}
	}
	return s.manager.Resolve(ctx, workspaceID, refs)
}

func (s *linkedSecretService) clearCache() int {
	return s.manager.ClearCache()
}

func (s *linkedSecretService) resetForTests() {
	s.mu.Lock()
	s.dirs = map[string]string{}
	s.files = map[string]*workspaceSecretFiles{}
	s.state = nil
	s.mu.Unlock()
	s.manager.ClearCache()
}

func credentialLabel(name string) string {
	switch name {
	case "serviceAccountKey":
		return "The service account key"
	case "accessKeyId":
		return "The access key ID"
	case "secretAccessKey":
		return "The secret access key"
	case "sessionToken":
		return "The session token"
	case "secretId":
		return "The secret_id"
	case "clientSecret":
		return "The client secret"
	case "username":
		return "The user name"
	case "password":
		return "The password"
	case "mfaCode":
		return "The MFA code"
	default:
		return "The token"
	}
}
