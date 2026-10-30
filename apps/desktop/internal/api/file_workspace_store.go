package api

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	goruntime "runtime"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

const (
	fileStoreVersion          = 1
	localStoreVersion         = 4
	workspaceStoreKind        = "workspace-yaml"
	workspaceStoreFormat      = "kurlo.workspace.yaml.v1"
	workspacePathLayout       = "yaml-filesystem-names.v1"
	workspaceStorageModeGit   = "git"
	workspaceStorageModeLocal = "local"
	filesystemNameField       = "filesystemName"
	fileStoreRootIndex        = "kurlo.yml"
	fileStoreWorkspacesDir    = "workspaces"
	fileStoreRootFileName     = "workspace.yml"
	fileStoreCollectionsDir   = "collections"
	fileStoreCollection       = "collection.yml"
	fileStoreRequestsDir      = "requests"
	fileStoreEnvironmentsDir  = "environments"
	fileStoreYAMLExt          = ".yml"
	kurloSecretPrefix         = "{{kurloSecret:"
	kurloSecretSuffix         = "}}"
)

var requestAuthSecretFields = []string{
	"bearerToken",
	"basicPass",
	"apiKeyValue",
	"oauth2Secret",
	"oauth2Token",
	"oauth2RefreshToken",
	"oauth2Password",
	"oauth2AssertionPrivateKey",
	"awsAccessKey",
	"awsSecretKey",
	"awsSessionToken",
	"oauth1ConsumerSecret",
	"oauth1Token",
	"oauth1TokenSecret",
	"oauth1PrivateKey",
}

var requestSettingSecretFields = []string{
	"clientKeyPassword",
}

var requestSecretRowFields = []string{
	"params",
	"pathParams",
	"headers",
	"formRows",
	"sioEvents",
	"grpcMetadata",
}

var collectionSecretRowFields = []string{
	"headers",
	"variables",
}

var yamlLineColumnRe = regexp.MustCompile(`line\s+(\d+)(?::(\d+))?`)

func syncDir(path string) error {
	if goruntime.GOOS == "windows" || path == "" {
		return nil
	}
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	err = d.Sync()
	if cerr := d.Close(); err == nil {
		err = cerr
	}
	return err
}

type filesystemWorkspaceFile struct {
	Version         int              `json:"version" yaml:"version"`
	Workspace       any              `json:"workspace" yaml:"workspace"`
	CollectionOrder []string         `json:"collectionOrder,omitempty" yaml:"collectionOrder,omitempty"`
	Cookies         []map[string]any `json:"cookies,omitempty" yaml:"cookies,omitempty"`
}

type filesystemStoreRootFile struct {
	Version        int      `json:"version" yaml:"version"`
	Format         string   `json:"format,omitempty" yaml:"format,omitempty"`
	WorkspaceOrder []string `json:"workspaceOrder,omitempty" yaml:"workspaceOrder,omitempty"`
}

type filesystemCollectionFile struct {
	Version      int      `json:"version" yaml:"version"`
	Collection   any      `json:"collection" yaml:"collection"`
	RequestOrder []string `json:"requestOrder,omitempty" yaml:"requestOrder,omitempty"`
}

type filesystemRequestFile struct {
	Version int `json:"version" yaml:"version"`
	Order   int `json:"order,omitempty" yaml:"order,omitempty"`
	Request any `json:"request" yaml:"request"`
}

type filesystemEnvironmentFile struct {
	Version     int `json:"version" yaml:"version"`
	Order       int `json:"order,omitempty" yaml:"order,omitempty"`
	Environment any `json:"environment" yaml:"environment"`
}

type requestFileEntry struct {
	order   int
	path    string
	request map[string]any
}

type environmentFileEntry struct {
	order       int
	path        string
	environment map[string]any
}

type collectionFileEntry struct {
	order        int
	path         string
	collection   map[string]any
	requestOrder []string
}

type workspaceFileEntry struct {
	order           int
	path            string
	workspace       map[string]any
	collectionOrder []string
	cookies         []map[string]any
}

type invalidWorkspaceFolder struct {
	path        string
	workspaceID string
}

type invalidCollectionFolder struct {
	path         string
	workspaceID  string
	collectionID string
}

type WorkspaceDiagnostic struct {
	Scope        string `json:"scope"`
	Severity     string `json:"severity"`
	Path         string `json:"path"`
	Message      string `json:"message"`
	WorkspaceID  string `json:"workspaceId,omitempty"`
	CollectionID string `json:"collectionId,omitempty"`
	RequestID    string `json:"requestId,omitempty"`
	Line         int    `json:"line,omitempty"`
	Column       int    `json:"column,omitempty"`
	Blocking     bool   `json:"blocking"`
}

type kurloSharedStore struct {
	PathLayout       string                      `json:"pathLayout"`
	Workspaces       []map[string]any            `json:"workspaces"`
	Collections      []map[string]any            `json:"collections"`
	Requests         []map[string]any            `json:"requests"`
	Environments     []map[string]any            `json:"environments"`
	WorkspaceCookies map[string][]map[string]any `json:"workspaceCookies,omitempty"`
}

func loadKurloStorePayload(localStorePath, workspaceRoot string) (string, error) {
	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(localStorePath, workspaceRoot)
	if err != nil {
		return "", err
	}
	if len(diagnostics) > 0 {
		return "", workspaceDiagnosticsError(diagnostics)
	}
	return payload, nil
}

func loadKurloStorePayloadWithDiagnostics(localStorePath, workspaceRoot string) (string, []WorkspaceDiagnostic, error) {
	localStore, diagnostics, err := loadKurloStoreWithDiagnostics(localStorePath, workspaceRoot)
	if err != nil {
		return "", diagnostics, err
	}
	payload, err := json.MarshalIndent(localStore, "", "  ")
	if err != nil {
		return "", diagnostics, err
	}
	return string(payload), diagnostics, nil
}

func loadKurloStoreWithDiagnostics(localStorePath, workspaceRoot string) (map[string]any, []WorkspaceDiagnostic, error) {
	localStore, _, localErr := loadLocalRequestStore(localStorePath)
	localStoreAuthFailed := false
	if localErr != nil && !errors.Is(localErr, os.ErrNotExist) {
		if !isRequestStoreAuthenticationError(localErr) {
			return nil, nil, localErr
		}
		localStoreAuthFailed = true
		localStore = nil
	}

	if workspaceRootUnavailable(workspaceRoot) {
		return nil, nil, fmt.Errorf("%s", missingWorkspaceRootMessage())
	}
	if !hasYAMLWorkspaceStore(workspaceRoot) && !workspaceChildrenRemain(workspaceRoot, fileStoreWorkspacesDir) {
		if localStoreAuthFailed {
			return nil, nil, localErr
		}
		return nil, nil, fmt.Errorf("workspace does not contain a Kurlo YAML workspace")
	}

	if localStore == nil {
		localStore = map[string]any{}
	}
	applyRequestStoreView(localStorePath, localStore)
	if err := recoverInterruptedSaveLocked(workspaceRoot); err != nil {
		return nil, nil, err
	}
	secrets := stringMap(localStore["secrets"])
	workspaces, collections, requests, environments, workspaceCookies, diagnostics, err := loadFilesystemWorkspaceStoreRepairing(workspaceRoot, secrets)
	if err != nil {
		return nil, diagnostics, err
	}

	localStore["version"] = localStoreVersion
	delete(localStore, "cookies")
	localStore["workspaces"] = workspaces
	localStore["collections"] = collections
	localStore["requests"] = requests
	localStore["environments"] = environments
	if len(workspaceCookies) > 0 {
		localStore["workspaceCookies"] = workspaceCookies
	} else {
		delete(localStore, "workspaceCookies")
	}

	workspaceIDs := entityIDSet(workspaces)
	if id, _ := localStore["activeWorkspaceId"].(string); id == "" || !workspaceIDs[id] {
		if len(workspaces) > 0 {
			localStore["activeWorkspaceId"] = stringValue(workspaces[0], "id")
		} else {
			delete(localStore, "activeWorkspaceId")
		}
	}
	if _, ok := localStore["activeId"]; !ok && len(requests) > 0 {
		localStore["activeId"] = stringValue(requests[0], "id")
	}
	if _, ok := localStore["openIds"]; !ok && len(requests) > 0 {
		localStore["openIds"] = []string{stringValue(requests[0], "id")}
	}

	return localStore, diagnostics, nil
}

func saveKurloStorePayload(localStorePath, workspaceRoot, payload string) error {
	return saveKurloStorePayloadPreserving(localStorePath, workspaceRoot, payload, nil)
}

func saveKurloStorePayloadPreserving(localStorePath, workspaceRoot, payload string, preserveDirs []string) error {
	store, err := decodeJSONMap(payload)
	if err != nil {
		return err
	}

	if err := validateWorkspaceStorePayload(store); err != nil {
		return err
	}
	disk, err := inspectWorkspaceStoreOnDisk(workspaceRoot)
	if err != nil {
		return err
	}

	existingSecrets := map[string]string{}
	existingSharedHash := ""
	existingStorageMode := inferWorkspaceStorageMode(workspaceRoot)
	if existingStore, _, err := loadLocalRequestStore(localStorePath); err == nil {
		if workspaceRootUnavailable(workspaceRoot) && sameWorkspaceRoot(resolvedStoredWorkspaceRoot(stringValue(localStoreStorage(existingStore), "root")), workspaceRoot) {
			return fmt.Errorf("%s", missingWorkspaceRootMessage())
		}
		for key, value := range stringMap(existingStore["secrets"]) {
			existingSecrets[key] = value
		}
		existingSharedHash = localStoreSharedHash(existingStore)
		if mode := stringValue(localStoreStorage(existingStore), "mode"); mode == workspaceStorageModeGit || mode == workspaceStorageModeLocal {
			existingStorageMode = mode
		}
	}

	secrets := map[string]string{}
	workspaces := mapSlice(store["workspaces"])
	collections := mapSlice(store["collections"])
	requests := mapSlice(store["requests"])
	environments := mapSlice(store["environments"])
	workspaceCookies := workspaceCookiesFromStore(store["workspaceCookies"])
	ensureStoreFilesystemNames(workspaces, collections, requests, environments, disk, len(preserveDirs) > 0)

	sanitizedRequests := sanitizeRequestsForFilesystem(requests, existingSecrets, secrets)
	sanitizedEnvironments := sanitizeEnvironmentsForFilesystem(environments, existingSecrets, secrets)
	sanitizedWorkspaces := sanitizeWorkspacesForFilesystem(workspaces)
	sanitizedCollections := sanitizeCollectionsForFilesystem(collections, existingSecrets, secrets)
	sanitizedWorkspaceCookies := sanitizeWorkspaceCookiesForFilesystem(workspaceCookies, entityIDSet(workspaces), existingSecrets, secrets)
	sharedHash, err := sharedStoreHash(sanitizedWorkspaces, sanitizedCollections, sanitizedRequests, sanitizedEnvironments, sanitizedWorkspaceCookies)
	if err != nil {
		return err
	}

	filesystemStoreExists := hasYAMLWorkspaceStore(workspaceRoot)
	sharedChanged := !filesystemStoreExists || existingSharedHash != sharedHash

	if sharedChanged {
		if staged, changed := secretsAhead(existingSecrets, secrets); changed {
			if err := os.MkdirAll(workspaceRoot, 0755); err != nil {
				return err
			}
			if err := saveLocalKurloStore(localStorePath, buildLocalKurloStore(store, workspaceRoot, staged, existingSharedHash, existingStorageMode)); err != nil {
				return err
			}
		}
		if err := writeFilesystemWorkspaceStore(workspaceRoot, sanitizedWorkspaces, sanitizedCollections, sanitizedRequests, sanitizedEnvironments, sanitizedWorkspaceCookies, preserveDirs); err != nil {
			return err
		}
	}

	localStore := buildLocalKurloStore(store, workspaceRoot, secrets, sharedHash, existingStorageMode)
	return saveLocalKurloStore(localStorePath, localStore)
}

func secretsAhead(existing, next map[string]string) (map[string]string, bool) {
	merged := cloneStringMap(existing)
	changed := false
	for key, value := range next {
		if current, ok := merged[key]; !ok || current != value {
			merged[key] = value
			changed = true
		}
	}
	return merged, changed
}

func buildLocalKurloStore(store map[string]any, workspaceRoot string, secrets map[string]string, sharedHash string, storageMode string) map[string]any {
	localStore := make(map[string]any, len(store))
	for key, value := range store {
		switch key {
		case "workspaces", "collections", "requests", "environments", "cookies", "workspaceCookies":
		default:
			localStore[key] = value
		}
	}
	localStore["version"] = localStoreVersion
	if storageMode != workspaceStorageModeGit && storageMode != workspaceStorageModeLocal {
		storageMode = inferWorkspaceStorageMode(workspaceRoot)
	}
	storage := map[string]any{
		"kind":       workspaceStoreKind,
		"format":     workspaceStoreFormat,
		"root":       persistedWorkspaceRoot(workspaceRoot),
		"mode":       storageMode,
		"sharedHash": sharedHash,
	}
	localStore["storage"] = storage
	localStore["secrets"] = cloneStringMap(secrets)
	return localStore
}

func saveLocalKurloStore(path string, store map[string]any) error {
	payload, err := json.Marshal(store)
	if err != nil {
		return err
	}
	if err := saveRequestStorePayload(path, string(payload)); err != nil {
		return err
	}
	return clearRequestStoreView(path)
}

type requestStoreView struct {
	ActiveID          string   `json:"activeId"`
	ActiveWorkspaceID string   `json:"activeWorkspaceId"`
	OpenIDs           []string `json:"openIds"`
}

func requestStoreViewPath(localStorePath string) string {
	return filepath.Join(filepath.Dir(localStorePath), "request-view.json")
}

func saveRequestStoreView(localStorePath, payload string) error {
	var view requestStoreView
	if err := json.Unmarshal([]byte(payload), &view); err != nil {
		return err
	}
	if view.OpenIDs == nil {
		view.OpenIDs = []string{}
	}
	data, err := json.Marshal(view)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(localStorePath), 0755); err != nil {
		return err
	}
	return writeFileAtomic(requestStoreViewPath(localStorePath), data)
}

func applyRequestStoreView(localStorePath string, store map[string]any) {
	data, err := os.ReadFile(requestStoreViewPath(localStorePath))
	if err != nil {
		return
	}
	var view requestStoreView
	if err := json.Unmarshal(data, &view); err != nil {
		return
	}
	if view.OpenIDs == nil {
		view.OpenIDs = []string{}
	}
	store["activeId"] = view.ActiveID
	store["activeWorkspaceId"] = view.ActiveWorkspaceID
	store["openIds"] = view.OpenIDs
}

func clearRequestStoreView(localStorePath string) error {
	if err := os.Remove(requestStoreViewPath(localStorePath)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func loadLocalRequestStore(path string) (map[string]any, string, error) {
	payload, err := loadRequestStorePayload(path)
	if err != nil {
		return nil, "", err
	}
	store, err := decodeJSONMap(payload)
	if err != nil {
		return nil, "", err
	}
	return store, payload, nil
}

func hasYAMLWorkspaceStore(root string) bool {
	if _, err := os.Stat(filepath.Join(root, fileStoreRootIndex)); err == nil {
		return true
	}
	return false
}

func isDefaultWorkspaceRoot(root string) bool {
	return filepath.Clean(strings.TrimSpace(root)) == filepath.Clean(defaultFileWorkspaceStorePath())
}

func sameWorkspaceRoot(left, right string) bool {
	return filepath.Clean(strings.TrimSpace(left)) == filepath.Clean(strings.TrimSpace(right))
}

func writeFilesystemWorkspaceStore(root string, workspaces, collections, requests, environments []map[string]any, workspaceCookies map[string][]map[string]any, preserveDirs []string) error {
	return writeYAMLWorkspaceStore(root, workspaces, collections, requests, environments, workspaceCookies, preserveDirs)
}

func writeYAMLWorkspaceStore(root string, workspaces, collections, requests, environments []map[string]any, workspaceCookies map[string][]map[string]any, preserveDirs []string) error {
	yamlStoreWriteMu.Lock()
	defer yamlStoreWriteMu.Unlock()
	if err := os.MkdirAll(root, 0755); err != nil {
		return err
	}
	if err := recoverInterruptedSave(root); err != nil {
		return err
	}
	journal := &saveJournal{root: root}
	defer journal.close()
	if err := ensureManagedWorkspaceDirIfExists(root, fileStoreWorkspacesDir); err != nil {
		return err
	}
	collectionsByWorkspace := groupByString(collections, "workspaceId")
	requestsByCollection := groupByString(requests, "collectionId")
	environmentsByWorkspace := groupByString(environments, "workspaceId")
	workspaceDirs := filesystemSegmentsForItems(workspaces)
	desiredFiles := map[string]struct{}{}

	rootIndexPath := filepath.Join(root, fileStoreRootIndex)
	desiredFiles[rootIndexPath] = struct{}{}

	workspaceOrder := idsFor(workspaces)
	if len(preserveDirs) > 0 {
		workspaceOrder = mergePreservedWorkspaceOrder(root, workspaceOrder)
	}
	if err := writeJournaledYAMLFile(rootIndexPath, filesystemStoreRootFile{
		Version:        fileStoreVersion,
		Format:         workspaceStoreFormat,
		WorkspaceOrder: workspaceOrder,
	}, journal); err != nil {
		return err
	}

	for _, workspace := range workspaces {
		workspaceID := stringValue(workspace, "id")
		if workspaceID == "" {
			continue
		}
		workspaceDir, err := ensureManagedWorkspaceDir(root, fileStoreWorkspacesDir, workspaceDirs[workspaceID])
		if err != nil {
			return err
		}
		if _, err := ensureManagedWorkspaceDir(root, fileStoreWorkspacesDir, workspaceDirs[workspaceID], fileStoreCollectionsDir); err != nil {
			return err
		}
		workspacePath := filepath.Join(workspaceDir, fileStoreRootFileName)
		desiredFiles[workspacePath] = struct{}{}
		delete(workspace, filesystemNameField)
		if err := writeJournaledYAMLFile(workspacePath, filesystemWorkspaceFile{
			Version:         fileStoreVersion,
			Workspace:       workspace,
			CollectionOrder: idsFor(collectionsByWorkspace[workspaceID]),
			Cookies:         workspaceCookies[workspaceID],
		}, journal); err != nil {
			return err
		}

		workspaceCollections := collectionsByWorkspace[workspaceID]
		collectionDirs := filesystemSegmentsForItems(workspaceCollections)
		for _, collection := range workspaceCollections {
			collectionID := stringValue(collection, "id")
			if collectionID == "" {
				continue
			}
			collectionDir, err := ensureManagedWorkspaceDir(root, fileStoreWorkspacesDir, workspaceDirs[workspaceID], fileStoreCollectionsDir, collectionDirs[collectionID])
			if err != nil {
				return err
			}
			requestsDir, err := ensureManagedWorkspaceDir(root, fileStoreWorkspacesDir, workspaceDirs[workspaceID], fileStoreCollectionsDir, collectionDirs[collectionID], fileStoreRequestsDir)
			if err != nil {
				return err
			}
			collectionPath := filepath.Join(collectionDir, fileStoreCollection)
			loadTests := collectionLoadTestMaps(collection)
			delete(collection, filesystemNameField)
			if err := writeJournaledYAMLFile(collectionPath, filesystemCollectionFile{
				Version:      fileStoreVersion,
				Collection:   collection,
				RequestOrder: idsFor(requestsByCollection[collectionID]),
			}, journal); err != nil {
				return err
			}
			desiredFiles[collectionPath] = struct{}{}
			if err := writeCollectionLoadTests(collectionDir, loadTests, desiredFiles, journal); err != nil {
				return err
			}
			requestFiles := filesystemSegmentsForItems(requestsByCollection[collectionID])
			for _, request := range requestsByCollection[collectionID] {
				requestID := stringValue(request, "id")
				if requestID == "" {
					return fmt.Errorf("request is missing id")
				}
				requestPath := filepath.Join(requestsDir, requestFiles[requestID]+fileStoreYAMLExt)
				examples := requestExampleMaps(request)
				delete(request, filesystemNameField)
				dropInferableSettingsOverrides(request, collection)
				if err := writeCanonicalYAMLFile(requestPath, filesystemRequestFile{Version: fileStoreVersion, Request: request}, journal, canonicalRequestFile(collection)); err != nil {
					return err
				}
				desiredFiles[requestPath] = struct{}{}
				if err := writeRequestExamples(collectionDir, requestFiles[requestID], examples, desiredFiles, journal); err != nil {
					return err
				}
			}
		}

		workspaceEnvironments := environmentsByWorkspace[workspaceID]
		if len(workspaceEnvironments) > 0 {
			envDir, err := ensureManagedWorkspaceDir(root, fileStoreWorkspacesDir, workspaceDirs[workspaceID], fileStoreEnvironmentsDir)
			if err != nil {
				return err
			}
			environmentFiles := filesystemSegmentsForItems(workspaceEnvironments)
			for _, environment := range workspaceEnvironments {
				environmentID := stringValue(environment, "id")
				if environmentID == "" {
					continue
				}
				envPath := filepath.Join(envDir, environmentFiles[environmentID]+fileStoreYAMLExt)
				delete(environment, filesystemNameField)
				if err := writeJournaledYAMLFile(envPath, filesystemEnvironmentFile{Version: fileStoreVersion, Environment: environment}, journal); err != nil {
					return err
				}
				desiredFiles[envPath] = struct{}{}
			}
		}

	}

	if err := pruneYAMLWorkspaceStore(root, desiredFiles, preserveDirs); err != nil {
		return err
	}
	if err := journal.finish(); err != nil {
		return err
	}
	return ensureWorkspaceGitignore(root)
}

func mergePreservedWorkspaceOrder(root string, desired []string) []string {
	var existing filesystemStoreRootFile
	if err := readYAMLFile(filepath.Join(root, fileStoreRootIndex), &existing); err != nil {
		return desired
	}
	seen := map[string]bool{}
	merged := make([]string, 0, len(existing.WorkspaceOrder)+len(desired))
	for _, id := range existing.WorkspaceOrder {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		merged = append(merged, id)
	}
	for _, id := range desired {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		merged = append(merged, id)
	}
	return merged
}

func pruneYAMLWorkspaceStore(root string, desiredFiles map[string]struct{}, preserveDirs []string) error {
	managedRoot := filepath.Join(root, fileStoreWorkspacesDir)
	if _, err := readDirNoSymlink(managedRoot); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var stale []string
	if err := filepath.WalkDir(managedRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		isExampleBody := isExampleBodyPath(path)
		if !isExampleBody && filepath.Ext(path) != fileStoreYAMLExt {
			return nil
		}
		if _, ok := desiredFiles[path]; ok {
			return nil
		}
		if pathInsideAnyDir(path, preserveDirs) {
			return nil
		}
		if info, err := os.Lstat(path); err != nil || info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if !isExampleBody && !isKurloManagedYAMLFile(path) {
			return nil
		}
		stale = append(stale, path)
		return nil
	}); err != nil {
		return err
	}
	sort.SliceStable(stale, func(i, j int) bool {
		return pruneRank(stale[i]) < pruneRank(stale[j])
	})
	for _, path := range stale {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return removeEmptyDirs(managedRoot)
}

func pruneRank(path string) int {
	switch filepath.Base(path) {
	case fileStoreRootFileName:
		return 2
	case fileStoreCollection:
		return 1
	}
	return 0
}

func pathInsideAnyDir(path string, dirs []string) bool {
	cleanPath := filepath.Clean(path)
	for _, dir := range dirs {
		cleanDir := filepath.Clean(dir)
		if cleanDir == "." || cleanDir == "" {
			continue
		}
		if cleanPath == cleanDir {
			return true
		}
		if rel, err := filepath.Rel(cleanDir, cleanPath); err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
			return true
		}
	}
	return false
}

func diagnosticPreserveDirs(root string, diagnostics []WorkspaceDiagnostic) []string {
	seen := map[string]bool{}
	var dirs []string
	for _, diagnostic := range diagnostics {
		path := filepath.FromSlash(diagnostic.Path)
		if path == "" {
			continue
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(root, path)
		}
		if workspaceDirForPath(root, path) == "" {
			continue
		}
		if base := filepath.Base(path); base == fileStoreRootFileName || base == fileStoreCollection {
			path = filepath.Dir(path)
		}
		if seen[path] {
			continue
		}
		seen[path] = true
		dirs = append(dirs, path)
	}
	return dirs
}

func workspaceDirForPath(root, path string) string {
	workspaceRoot := filepath.Join(root, fileStoreWorkspacesDir)
	rel, err := filepath.Rel(workspaceRoot, path)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return ""
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) == 0 || parts[0] == "" || parts[0] == "." || parts[0] == ".." {
		return ""
	}
	return filepath.Join(workspaceRoot, filepath.FromSlash(parts[0]))
}

func isKurloManagedYAMLFile(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var doc map[string]any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return false
	}
	if _, hasVersion := doc["version"]; !hasVersion {
		return false
	}
	for _, key := range []string{"workspace", "collection", "request", "environment", "example", "loadTest"} {
		if _, ok := doc[key]; ok {
			return true
		}
	}
	return false
}

func removeEmptyDirs(root string) error {
	var dirs []string
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			dirs = append(dirs, path)
		}
		return nil
	}); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	sort.Slice(dirs, func(i, j int) bool {
		return len(dirs[i]) > len(dirs[j])
	})
	for _, dir := range dirs {
		if dir == root {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return err
		}
		if len(entries) == 0 {
			if err := os.Remove(dir); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	return nil
}

var kurloGitignoreEntries = []string{".kurlo-local/", ".env", ".env.*", "*-????-??-??T??-??-??.html", ".DS_Store", "Thumbs.db", "Desktop.ini"}

func ensureWorkspaceGitignore(root string) error {
	workspaceGitignoreMu.Lock()
	defer workspaceGitignoreMu.Unlock()
	path := filepath.Join(root, ".gitignore")
	info, err := os.Lstat(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		content := strings.Join(append(append([]string{}, kurloGitignoreEntries...), "!.env.example", "*.tmp", ""), "\n")
		return os.WriteFile(path, []byte(content), 0644)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to update symlink: %s", path)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("refusing to update non-file .gitignore: %s", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	existing := string(data)
	lineSet := make(map[string]struct{})
	for _, line := range strings.Split(strings.ReplaceAll(existing, "\r\n", "\n"), "\n") {
		lineSet[strings.TrimSpace(line)] = struct{}{}
	}
	var missing []string
	for _, entry := range kurloGitignoreEntries {
		if _, found := lineSet[entry]; !found {
			missing = append(missing, entry)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	newline := "\n"
	if strings.Contains(existing, "\r\n") {
		newline = "\r\n"
	}
	prefix := ""
	if existing != "" && !strings.HasSuffix(existing, "\n") {
		prefix = newline
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(prefix + strings.Join(missing, newline) + newline)
	return err
}

func ensureManagedWorkspaceDir(root string, elems ...string) (string, error) {
	current := root
	for _, elem := range elems {
		if elem == "" || strings.ContainsAny(elem, `/\`) {
			return "", fmt.Errorf("invalid workspace path segment")
		}
		current = filepath.Join(current, elem)
		info, err := os.Lstat(current)
		if err == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return "", fmt.Errorf("refusing to use symlink directory: %s", current)
			}
			if !info.IsDir() {
				return "", fmt.Errorf("workspace path is not a directory: %s", current)
			}
			continue
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		if err := os.Mkdir(current, 0755); err != nil {
			if !errors.Is(err, os.ErrExist) {
				return "", err
			}
			info, statErr := os.Lstat(current)
			if statErr != nil {
				return "", statErr
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return "", fmt.Errorf("refusing to use symlink directory: %s", current)
			}
			if !info.IsDir() {
				return "", fmt.Errorf("workspace path is not a directory: %s", current)
			}
		}
	}
	return current, nil
}

func ensureManagedWorkspaceDirIfExists(root string, elems ...string) error {
	path := filepath.Join(append([]string{root}, elems...)...)
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to use symlink directory: %s", path)
	}
	if !info.IsDir() {
		return fmt.Errorf("workspace path is not a directory: %s", path)
	}
	return nil
}

func readDirNoSymlink(path string) ([]os.DirEntry, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("read %s: refusing to read symlink", path)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("read %s: not a directory", path)
	}
	return os.ReadDir(path)
}

func loadFilesystemWorkspaceStoreWithDiagnostics(root string, secrets map[string]string) ([]map[string]any, []map[string]any, []map[string]any, []map[string]any, map[string][]map[string]any, []WorkspaceDiagnostic, error) {
	return loadYAMLWorkspaceStoreWithDiagnostics(root, secrets)
}

func loadFilesystemWorkspaceStoreRepairing(root string, secrets map[string]string) ([]map[string]any, []map[string]any, []map[string]any, []map[string]any, map[string][]map[string]any, []WorkspaceDiagnostic, error) {
	workspaces, collections, requests, environments, cookies, diagnostics, fixes, err := loadYAMLWorkspaceStoreWithFixes(root, secrets)
	if err != nil || len(fixes) == 0 || workspaceIntegrityError(diagnostics) != nil {
		return workspaces, collections, requests, environments, cookies, diagnostics, err
	}
	if applyWorkspaceReferenceFixes(fixes) != nil {
		return workspaces, collections, requests, environments, cookies, diagnostics, nil
	}
	workspaces, collections, requests, environments, cookies, diagnostics, _, err = loadYAMLWorkspaceStoreWithFixes(root, secrets)
	return workspaces, collections, requests, environments, cookies, diagnostics, err
}

func loadYAMLWorkspaceStoreWithDiagnostics(root string, secrets map[string]string) ([]map[string]any, []map[string]any, []map[string]any, []map[string]any, map[string][]map[string]any, []WorkspaceDiagnostic, error) {
	workspaces, collections, requests, environments, cookies, diagnostics, _, err := loadYAMLWorkspaceStoreWithFixes(root, secrets)
	return workspaces, collections, requests, environments, cookies, diagnostics, err
}

func loadYAMLWorkspaceStoreWithFixes(root string, secrets map[string]string) ([]map[string]any, []map[string]any, []map[string]any, []map[string]any, map[string][]map[string]any, []WorkspaceDiagnostic, []workspaceReferenceFix, error) {
	workspaceEntries, invalidWorkspaceFolders, diagnostics, err := readYAMLWorkspaceEntriesWithDiagnostics(root, secrets)
	if err != nil {
		return nil, nil, nil, nil, nil, diagnostics, nil, err
	}
	workspaces := make([]map[string]any, 0, len(workspaceEntries))
	collections := make([]map[string]any, 0)
	requests := make([]map[string]any, 0)
	environments := make([]map[string]any, 0)
	workspaceCookies := map[string][]map[string]any{}

	validator := newWorkspaceIntegrityValidator(root)
	for _, workspaceEntry := range workspaceEntries {
		validator.item("workspace", filepath.Join(workspaceEntry.path, fileStoreRootFileName), workspaceEntry.workspace)
		workspaceID := stringValue(workspaceEntry.workspace, "id")
		workspaces = append(workspaces, workspaceEntry.workspace)
		if workspaceID != "" && len(workspaceEntry.cookies) > 0 {
			workspaceCookies[workspaceID] = workspaceEntry.cookies
		}
		childCollections, childRequests, childEnvironments, childDiagnostics := collectWorkspaceFolderChildren(workspaceEntry.path, root, workspaceID, workspaceEntry.collectionOrder, secrets, validator)
		collections = append(collections, childCollections...)
		requests = append(requests, childRequests...)
		environments = append(environments, childEnvironments...)
		diagnostics = append(diagnostics, childDiagnostics...)
	}

	for _, folder := range invalidWorkspaceFolders {
		_, _, _, childDiagnostics := collectWorkspaceFolderChildren(folder.path, root, folder.workspaceID, nil, secrets, nil)
		diagnostics = append(diagnostics, childDiagnostics...)
	}
	if len(invalidWorkspaceFolders) == 0 {
		var rootFile filesystemStoreRootFile
		rootIndexPath := filepath.Join(root, fileStoreRootIndex)
		if readYAMLFile(rootIndexPath, &rootFile) == nil {
			validator.order(rootIndexPath, "workspaceOrder", rootFile.WorkspaceOrder, workspaces)
		}
	}

	diagnostics = append(diagnostics, validator.diagnostics...)
	workspaces = validator.usableItems("workspace", workspaces)
	collections = validator.usableItems("collection", collections)
	requests = validator.usableItems("request", requests)
	environments = validator.usableItems("environment", environments)
	for _, request := range requests {
		if examples, exists := request["examples"]; exists {
			request["examples"] = validator.usableItems("example", mapSlice(examples))
		}
	}
	for _, collection := range collections {
		if loadTests, exists := collection["loadTests"]; exists {
			collection["loadTests"] = validator.usableItems("load test", mapSlice(loadTests))
		}
	}
	hydrateRequestCollectionNames(requests, collections)
	return workspaces, collections, requests, environments, workspaceCookies, diagnostics, validator.fixes, nil
}

func collectWorkspaceFolderChildren(workspacePath, root, workspaceID string, collectionOrder []string, secrets map[string]string, validator *workspaceIntegrityValidator) ([]map[string]any, []map[string]any, []map[string]any, []WorkspaceDiagnostic) {
	collections := make([]map[string]any, 0)
	requests := make([]map[string]any, 0)
	environments := make([]map[string]any, 0)
	var diagnostics []WorkspaceDiagnostic

	collectionEntries, invalidCollectionFolders, collectionDiagnostics := readYAMLCollectionEntriesWithDiagnostics(filepath.Join(workspacePath, fileStoreCollectionsDir), collectionOrder, root, workspaceID, secrets)
	diagnostics = append(diagnostics, collectionDiagnostics...)
	for _, collectionEntry := range collectionEntries {
		collectionPath := filepath.Join(collectionEntry.path, fileStoreCollection)
		validator.item("collection", collectionPath, collectionEntry.collection)
		validator.reference(collectionPath, "collection", collectionEntry.collection, "workspaceId", workspaceID)
		collectionID := stringValue(collectionEntry.collection, "id")
		delete(collectionEntry.collection, "loadTests")
		loadTests, loadTestDiagnostics := readCollectionLoadTests(collectionEntry.path, root, workspaceID, collectionID, validator)
		diagnostics = append(diagnostics, loadTestDiagnostics...)
		if len(loadTests) > 0 {
			collectionEntry.collection["loadTests"] = loadTests
		}
		collections = append(collections, collectionEntry.collection)
		requestEntries, requestDiagnostics := readYAMLRequestEntriesWithDiagnostics(filepath.Join(collectionEntry.path, fileStoreRequestsDir), collectionEntry.requestOrder, secrets, root, workspaceID, collectionID)
		diagnostics = append(diagnostics, requestDiagnostics...)
		if len(requestDiagnostics) == 0 {
			validator.orphanExamples(collectionEntry.path, requestEntries)
			requestItems := make([]map[string]any, 0, len(requestEntries))
			for _, requestEntry := range requestEntries {
				requestItems = append(requestItems, requestEntry.request)
			}
			validator.order(collectionPath, "requestOrder", collectionEntry.requestOrder, requestItems)
		}
		for _, requestEntry := range requestEntries {
			validator.item("request", requestEntry.path, requestEntry.request)
			validator.reference(requestEntry.path, "request", requestEntry.request, "collectionId", collectionID)
			requestID := stringValue(requestEntry.request, "id")
			examples, exampleDiagnostics := readRequestExamples(
				collectionEntry.path,
				stringValue(requestEntry.request, filesystemNameField),
				root, workspaceID, collectionID, requestID, validator,
			)
			diagnostics = append(diagnostics, exampleDiagnostics...)
			if len(examples) > 0 {
				requestEntry.request["examples"] = examples
			}
			requests = append(requests, requestEntry.request)
		}
	}

	if len(collectionDiagnostics) == 0 {
		validator.order(filepath.Join(workspacePath, fileStoreRootFileName), "collectionOrder", collectionOrder, collections)
	}

	for _, folder := range invalidCollectionFolders {
		_, requestDiagnostics := readYAMLRequestEntriesWithDiagnostics(filepath.Join(folder.path, fileStoreRequestsDir), nil, secrets, root, folder.workspaceID, folder.collectionID)
		diagnostics = append(diagnostics, requestDiagnostics...)
	}

	environmentEntries, environmentDiagnostics := readYAMLEnvironmentEntriesWithDiagnostics(filepath.Join(workspacePath, fileStoreEnvironmentsDir), secrets, root, workspaceID)
	diagnostics = append(diagnostics, environmentDiagnostics...)
	for _, environmentEntry := range environmentEntries {
		validator.item("environment", environmentEntry.path, environmentEntry.environment)
		validator.reference(environmentEntry.path, "environment", environmentEntry.environment, "workspaceId", workspaceID)
		environments = append(environments, environmentEntry.environment)
	}
	return collections, requests, environments, diagnostics
}

type workspaceDiagnostic struct {
	scope        string
	path         string
	root         string
	message      string
	err          error
	workspaceID  string
	collectionID string
	requestID    string
	blocking     bool
}

func (d workspaceDiagnostic) toDiagnostic() WorkspaceDiagnostic {
	message := d.message
	if message == "" && d.err != nil {
		message = workspaceDiagnosticErrorMessage(d.path, d.err)
	}
	line, column := workspaceDiagnosticLineColumn(message)
	if line > 0 {
		message = friendlyYAMLMessage(message)
	}
	return WorkspaceDiagnostic{
		Scope:        d.scope,
		Severity:     "error",
		Path:         workspaceDiagnosticPath(d.root, d.path),
		Message:      message,
		WorkspaceID:  d.workspaceID,
		CollectionID: d.collectionID,
		RequestID:    d.requestID,
		Line:         line,
		Column:       column,
		Blocking:     d.blocking,
	}
}

func readYAMLWorkspaceEntriesWithDiagnostics(root string, secrets map[string]string) ([]workspaceFileEntry, []invalidWorkspaceFolder, []WorkspaceDiagnostic, error) {
	workspaceRoot := filepath.Join(root, fileStoreWorkspacesDir)
	entries, err := readDirNoSymlink(workspaceRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, nil, nil
		}
		diagnostics := []WorkspaceDiagnostic{workspaceDiagnostic{scope: "workspace", path: workspaceRoot, root: root, err: err, blocking: true}.toDiagnostic()}
		return nil, nil, diagnostics, workspaceDiagnosticsError(diagnostics)
	}
	var diagnostics []WorkspaceDiagnostic
	var rootFile filesystemStoreRootFile
	rootIndexPath := filepath.Join(root, fileStoreRootIndex)
	if err := readYAMLFile(rootIndexPath, &rootFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		diagnostics = append(diagnostics, workspaceDiagnostic{scope: "workspace", path: rootIndexPath, root: root, err: err, blocking: true}.toDiagnostic())
		return nil, nil, diagnostics, workspaceDiagnosticsError(diagnostics)
	}
	if rootIndexMissingWithChildren(root) {
		diagnostics = append(diagnostics, workspaceDiagnostic{
			scope: workspaceIntegrityScope, path: rootIndexPath, root: root, blocking: true,
			message: "kurlo.yml is missing but workspace files remain. Restore kurlo.yml before saving.",
		}.toDiagnostic())
	}
	orderIndex := indexByID(rootFile.WorkspaceOrder)
	var workspaces []workspaceFileEntry
	var invalidFolders []invalidWorkspaceFolder
	for index, entry := range entries {
		path := filepath.Join(workspaceRoot, entry.Name())
		if entry.Type()&os.ModeSymlink != 0 {
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "workspace", path: path, root: root, err: fmt.Errorf("read %s: refusing to read symlink", path), workspaceID: invalidDiagnosticID("workspace", path), blocking: true}.toDiagnostic())
			continue
		}
		if !entry.IsDir() {
			continue
		}
		filePath := filepath.Join(path, fileStoreRootFileName)
		var doc filesystemWorkspaceFile
		if err := readYAMLFile(filePath, &doc); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				if workspaceChildrenRemain(path, fileStoreCollectionsDir, fileStoreEnvironmentsDir) {
					diagnostics = append(diagnostics, workspaceDiagnostic{
						scope: workspaceIntegrityScope, path: filePath, root: root, blocking: true,
						message: "workspace.yml is missing but its child files remain. Restore the workspace file before saving.",
					}.toDiagnostic())
				}
				continue
			}
			workspaceID := invalidDiagnosticID("workspace", filePath)
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "workspace", path: filePath, root: root, err: err, workspaceID: workspaceID, blocking: true}.toDiagnostic())
			invalidFolders = append(invalidFolders, invalidWorkspaceFolder{path: path, workspaceID: workspaceID})
			continue
		}
		workspace, ok := doc.Workspace.(map[string]any)
		if !ok {
			workspaceID := invalidDiagnosticID("workspace", filePath)
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "workspace", path: filePath, root: root, message: "workspace file does not contain a workspace object", workspaceID: workspaceID, blocking: true}.toDiagnostic())
			invalidFolders = append(invalidFolders, invalidWorkspaceFolder{path: path, workspaceID: workspaceID})
			continue
		}
		id := stringValue(workspace, "id")
		if id == "" {
			id = invalidDiagnosticID("workspace", filePath)
		}
		if err := requireItemFilesystemName(workspace, filePath); err != nil {
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "workspace", path: filePath, root: root, err: err, workspaceID: id, blocking: true}.toDiagnostic())
			invalidFolders = append(invalidFolders, invalidWorkspaceFolder{path: path, workspaceID: id})
			continue
		}
		mergeWorkspaceCookieSecrets(doc.Cookies, secrets)
		sortOrder, ok := orderIndex[id]
		if !ok {
			sortOrder = len(orderIndex) + index
		}
		workspaces = append(workspaces, workspaceFileEntry{order: sortOrder, path: path, workspace: workspace, collectionOrder: doc.CollectionOrder, cookies: doc.Cookies})
	}
	sort.SliceStable(workspaces, func(i, j int) bool {
		if workspaces[i].order == workspaces[j].order {
			return workspaces[i].path < workspaces[j].path
		}
		return workspaces[i].order < workspaces[j].order
	})
	return workspaces, invalidFolders, diagnostics, nil
}

func readYAMLCollectionEntriesWithDiagnostics(root string, order []string, workspaceRoot string, workspaceID string, secrets map[string]string) ([]collectionFileEntry, []invalidCollectionFolder, []WorkspaceDiagnostic) {
	entries, err := readDirNoSymlink(root)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, nil
		}
		return nil, nil, []WorkspaceDiagnostic{workspaceDiagnostic{scope: "collection", path: root, root: workspaceRoot, err: err, workspaceID: workspaceID}.toDiagnostic()}
	}
	orderIndex := indexByID(order)
	var diagnostics []WorkspaceDiagnostic
	var collections []collectionFileEntry
	var invalidFolders []invalidCollectionFolder
	for index, entry := range entries {
		path := filepath.Join(root, entry.Name())
		if entry.Type()&os.ModeSymlink != 0 {
			collectionID := invalidDiagnosticID("collection", path)
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "collection", path: path, root: workspaceRoot, err: fmt.Errorf("read %s: refusing to read symlink", path), workspaceID: workspaceID, collectionID: collectionID}.toDiagnostic())
			continue
		}
		if !entry.IsDir() {
			continue
		}
		filePath := filepath.Join(path, fileStoreCollection)
		var doc filesystemCollectionFile
		if err := readYAMLFile(filePath, &doc); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				if workspaceChildrenRemain(path, fileStoreRequestsDir, fileStoreExamplesDir, fileStoreLoadTestsDir) {
					diagnostics = append(diagnostics, workspaceDiagnostic{
						scope: workspaceIntegrityScope, path: filePath, root: workspaceRoot, blocking: true,
						message: "collection.yml is missing but its child files remain. Restore the collection file before saving.",
					}.toDiagnostic())
				}
				continue
			}
			collectionID := invalidDiagnosticID("collection", filePath)
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "collection", path: filePath, root: workspaceRoot, err: err, workspaceID: workspaceID, collectionID: collectionID}.toDiagnostic())
			invalidFolders = append(invalidFolders, invalidCollectionFolder{path: path, workspaceID: workspaceID, collectionID: collectionID})
			continue
		}
		collection, ok := doc.Collection.(map[string]any)
		if !ok {
			collectionID := invalidDiagnosticID("collection", filePath)
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "collection", path: filePath, root: workspaceRoot, message: "collection file does not contain a collection object", workspaceID: workspaceID, collectionID: collectionID}.toDiagnostic())
			invalidFolders = append(invalidFolders, invalidCollectionFolder{path: path, workspaceID: workspaceID, collectionID: collectionID})
			continue
		}
		collectionID := stringValue(collection, "id")
		if collectionID == "" {
			collectionID = invalidDiagnosticID("collection", filePath)
		}
		if err := requireItemFilesystemName(collection, filePath); err != nil {
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "collection", path: filePath, root: workspaceRoot, err: err, workspaceID: workspaceID, collectionID: collectionID}.toDiagnostic())
			invalidFolders = append(invalidFolders, invalidCollectionFolder{path: path, workspaceID: workspaceID, collectionID: collectionID})
			continue
		}
		mergeCollectionSecrets(collection, secrets)
		sortOrder, ok := orderIndex[collectionID]
		if !ok {
			sortOrder = len(orderIndex) + index
		}
		collections = append(collections, collectionFileEntry{order: sortOrder, path: path, collection: collection, requestOrder: doc.RequestOrder})
	}
	sort.SliceStable(collections, func(i, j int) bool {
		if collections[i].order == collections[j].order {
			return collections[i].path < collections[j].path
		}
		return collections[i].order < collections[j].order
	})
	return collections, invalidFolders, diagnostics
}

func readYAMLRequestEntriesWithDiagnostics(root string, order []string, secrets map[string]string, workspaceRoot string, workspaceID string, collectionID string) ([]requestFileEntry, []WorkspaceDiagnostic) {
	if _, err := readDirNoSymlink(root); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, []WorkspaceDiagnostic{workspaceDiagnostic{scope: "request", path: root, root: workspaceRoot, err: err, workspaceID: workspaceID, collectionID: collectionID, requestID: invalidDiagnosticID("request", root)}.toDiagnostic()}
	}
	orderIndex := indexByID(order)
	var diagnostics []WorkspaceDiagnostic
	var requests []requestFileEntry
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "request", path: path, root: workspaceRoot, err: err, workspaceID: workspaceID, collectionID: collectionID, requestID: invalidDiagnosticID("request", path)}.toDiagnostic())
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "request", path: path, root: workspaceRoot, err: fmt.Errorf("read %s: refusing to read symlink", path), workspaceID: workspaceID, collectionID: collectionID, requestID: invalidDiagnosticID("request", path)}.toDiagnostic())
			return nil
		}
		if entry.IsDir() || filepath.Ext(path) != fileStoreYAMLExt {
			return nil
		}
		var doc filesystemRequestFile
		if err := readYAMLFile(path, &doc); err != nil {
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "request", path: path, root: workspaceRoot, err: err, workspaceID: workspaceID, collectionID: collectionID, requestID: invalidDiagnosticID("request", path)}.toDiagnostic())
			return nil
		}
		request, ok := doc.Request.(map[string]any)
		if !ok {
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "request", path: path, root: workspaceRoot, message: "request file does not contain a request object", workspaceID: workspaceID, collectionID: collectionID, requestID: invalidDiagnosticID("request", path)}.toDiagnostic())
			return nil
		}
		requestID := stringValue(request, "id")
		if requestID == "" {
			requestID = invalidDiagnosticID("request", path)
		}
		if err := requireItemFilesystemName(request, path); err != nil {
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "request", path: path, root: workspaceRoot, err: err, workspaceID: workspaceID, collectionID: collectionID, requestID: requestID}.toDiagnostic())
			return nil
		}
		mergeRequestSecrets(request, secrets)
		normalizeLoadedBodyType(request)
		sortOrder := doc.Order
		if ordered, ok := orderIndex[requestID]; ok {
			sortOrder = ordered
		}
		requests = append(requests, requestFileEntry{order: sortOrder, path: path, request: request})
		return nil
	})
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		diagnostics = append(diagnostics, workspaceDiagnostic{scope: "request", path: root, root: workspaceRoot, err: err, workspaceID: workspaceID, collectionID: collectionID, requestID: invalidDiagnosticID("request", root)}.toDiagnostic())
	}
	sort.SliceStable(requests, func(i, j int) bool {
		if requests[i].order == requests[j].order {
			return requests[i].path < requests[j].path
		}
		return requests[i].order < requests[j].order
	})
	return requests, diagnostics
}

var loadedBodyTypes = map[string]bool{"none": true, "json": true, "text": true, "xml": true, "html": true, "form": true, "urlencoded": true, "binary": true, "graphql": true}

var loadedRawBodyTypes = map[string]bool{"json": true, "text": true, "xml": true, "html": true}

func normalizeLoadedBodyType(request map[string]any) {
	bodyType, ok := request["bodyType"].(string)
	if !ok || bodyType == "" || loadedBodyTypes[bodyType] {
		return
	}
	if bodyType == "raw" {
		if rawType := stringValue(request, "rawBodyType"); loadedRawBodyTypes[rawType] {
			request["bodyType"] = rawType
			return
		}
	}
	if stringValue(request, "bodyContent") == "" {
		return
	}
	request["bodyType"] = "text"
}

func readYAMLEnvironmentEntriesWithDiagnostics(root string, secrets map[string]string, workspaceRoot string, workspaceID string) ([]environmentFileEntry, []WorkspaceDiagnostic) {
	entries, err := readDirNoSymlink(root)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, []WorkspaceDiagnostic{workspaceDiagnostic{scope: "environment", path: root, root: workspaceRoot, err: err, workspaceID: workspaceID}.toDiagnostic()}
	}
	var diagnostics []WorkspaceDiagnostic
	var environments []environmentFileEntry
	for index, entry := range entries {
		path := filepath.Join(root, entry.Name())
		if entry.Type()&os.ModeSymlink != 0 {
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "environment", path: path, root: workspaceRoot, err: fmt.Errorf("read %s: refusing to read symlink", path), workspaceID: workspaceID}.toDiagnostic())
			continue
		}
		if entry.IsDir() || filepath.Ext(entry.Name()) != fileStoreYAMLExt {
			continue
		}
		var doc filesystemEnvironmentFile
		if err := readYAMLFile(path, &doc); err != nil {
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "environment", path: path, root: workspaceRoot, err: err, workspaceID: workspaceID}.toDiagnostic())
			continue
		}
		environment, ok := doc.Environment.(map[string]any)
		if !ok {
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "environment", path: path, root: workspaceRoot, message: "environment file does not contain an environment object", workspaceID: workspaceID}.toDiagnostic())
			continue
		}
		if err := requireItemFilesystemName(environment, path); err != nil {
			diagnostics = append(diagnostics, workspaceDiagnostic{scope: "environment", path: path, root: workspaceRoot, err: err, workspaceID: workspaceID}.toDiagnostic())
			continue
		}
		mergeEnvironmentSecrets(environment, secrets)
		order := doc.Order
		if order == 0 {
			order = index
		}
		environments = append(environments, environmentFileEntry{order: order, path: path, environment: environment})
	}
	sort.SliceStable(environments, func(i, j int) bool {
		if environments[i].order == environments[j].order {
			return environments[i].path < environments[j].path
		}
		return environments[i].order < environments[j].order
	})
	return environments, diagnostics
}

func invalidDiagnosticID(prefix, path string) string {
	return "invalid-" + prefix + "-" + shortHash(filepath.ToSlash(path))
}

func workspaceDiagnosticPath(root, path string) string {
	if root != "" {
		if rel, err := filepath.Rel(root, path); err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
			return filepath.ToSlash(rel)
		}
	}
	return filepath.ToSlash(path)
}

func workspaceDiagnosticErrorMessage(path string, err error) string {
	if err == nil {
		return "Unknown workspace YAML error"
	}
	message := err.Error()
	prefix := "read " + path + ": "
	message = strings.TrimPrefix(message, prefix)
	message = strings.TrimPrefix(message, "yaml: ")
	return message
}

func workspaceDiagnosticLineColumn(message string) (int, int) {
	matches := yamlLineColumnRe.FindStringSubmatch(message)
	if len(matches) == 0 {
		return 0, 0
	}
	line := parsePositiveInt(matches[1])
	column := 0
	if len(matches) > 2 {
		column = parsePositiveInt(matches[2])
	}
	return line, column
}

func parsePositiveInt(value string) int {
	n := 0
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return 0
		}
		n = n*10 + int(ch-'0')
	}
	return n
}

func workspaceDiagnosticsError(diagnostics []WorkspaceDiagnostic) error {
	if len(diagnostics) == 0 {
		return nil
	}
	first := diagnostics[0]
	location := first.Path
	if first.Line > 0 {
		location = fmt.Sprintf("%s:%d", location, first.Line)
		if first.Column > 0 {
			location = fmt.Sprintf("%s:%d", location, first.Column)
		}
	}
	if len(diagnostics) == 1 {
		return fmt.Errorf("%s: %s", location, first.Message)
	}
	return fmt.Errorf("%s: %s (+%d more workspace issues)", location, first.Message, len(diagnostics)-1)
}

func sanitizeRequestsForFilesystem(requests []map[string]any, existingSecrets, secrets map[string]string) []map[string]any {
	sanitized := make([]map[string]any, 0, len(requests))
	for _, request := range requests {
		next := cloneMap(request)
		delete(next, "collection")
		id := stringValue(next, "id")
		if auth := nestedMap(next, "auth"); auth != nil && id != "" {
			for _, field := range requestAuthSecretFields {
				value := stringFromAny(auth[field])
				key := requestSecretKey(id, field)
				if placeholderKey, ok := kurloSecretKeyFromPlaceholder(value); ok {
					if existingValue, exists := existingSecrets[placeholderKey]; exists {
						secrets[placeholderKey] = existingValue
					}
				} else if secretFieldNeedsVault(value) {
					secrets[key] = value
					auth[field] = kurloSecretPlaceholder(key)
				}
			}
		}
		if settings := nestedMap(next, "settings"); settings != nil && id != "" {
			for _, field := range requestSettingSecretFields {
				value := stringFromAny(settings[field])
				key := requestSettingSecretKey(id, field)
				if placeholderKey, ok := kurloSecretKeyFromPlaceholder(value); ok {
					if existingValue, exists := existingSecrets[placeholderKey]; exists {
						secrets[placeholderKey] = existingValue
					}
				} else if secretFieldNeedsVault(value) {
					secrets[key] = value
					settings[field] = kurloSecretPlaceholder(key)
				}
			}
		}
		if id != "" {
			sanitizeRequestSecretRows(next, id, existingSecrets, secrets)
		}
		stripRequestForFilesystem(next)
		sanitized = append(sanitized, next)
	}
	return sanitized
}

func sanitizeCollectionSecrets(collection map[string]any, existingSecrets, secrets map[string]string) {
	collectionID := stringValue(collection, "id")
	defaults := nestedMap(collection, "defaults")
	if collectionID == "" || defaults == nil {
		return
	}
	if auth := nestedMap(defaults, "auth"); auth != nil {
		for _, field := range requestAuthSecretFields {
			value := stringFromAny(auth[field])
			key := collectionSecretKey(collectionID, field)
			if placeholderKey, ok := kurloSecretKeyFromPlaceholder(value); ok {
				if existingValue, exists := existingSecrets[placeholderKey]; exists {
					secrets[placeholderKey] = existingValue
				}
			} else if secretFieldNeedsVault(value) {
				secrets[key] = value
				auth[field] = kurloSecretPlaceholder(key)
			}
		}
	}
	if settings := nestedMap(defaults, "settings"); settings != nil {
		for _, field := range requestSettingSecretFields {
			value := stringFromAny(settings[field])
			key := collectionSettingSecretKey(collectionID, field)
			if placeholderKey, ok := kurloSecretKeyFromPlaceholder(value); ok {
				if existingValue, exists := existingSecrets[placeholderKey]; exists {
					secrets[placeholderKey] = existingValue
				}
			} else if secretFieldNeedsVault(value) {
				secrets[key] = value
				settings[field] = kurloSecretPlaceholder(key)
			}
		}
	}
	sanitizeCollectionSecretRows(defaults, collectionID, existingSecrets, secrets)
}

func sanitizeCollectionSecretRows(defaults map[string]any, collectionID string, existingSecrets, secrets map[string]string) {
	for _, field := range collectionSecretRowFields {
		rows, ok := defaults[field].([]any)
		if !ok {
			continue
		}
		for index, rawRow := range rows {
			row, ok := rawRow.(map[string]any)
			if !ok || !boolValue(row["secret"]) {
				continue
			}
			rowID := secretRowID(row, index)
			value := stringFromAny(row["value"])
			key := collectionRowSecretKey(collectionID, field, rowID)
			if placeholderKey, ok := kurloSecretKeyFromPlaceholder(value); ok {
				if existingValue, exists := existingSecrets[placeholderKey]; exists {
					secrets[placeholderKey] = existingValue
				}
			} else if value != "" {
				secrets[key] = value
				row["value"] = kurloSecretPlaceholder(key)
			}
		}
	}
}

func hydrateRequestCollectionNames(requests, collections []map[string]any) {
	collectionNames := map[string]string{}
	for _, collection := range collections {
		id := stringValue(collection, "id")
		if id != "" {
			collectionNames[id] = stringValue(collection, "name")
		}
	}
	for _, request := range requests {
		collectionID := stringValue(request, "collectionId")
		request["collection"] = collectionNames[collectionID]
	}
}

func sanitizeRequestSecretRows(request map[string]any, requestID string, existingSecrets, secrets map[string]string) {
	for _, field := range requestSecretRowFields {
		rows, ok := request[field].([]any)
		if !ok {
			continue
		}
		for index, rawRow := range rows {
			row, ok := rawRow.(map[string]any)
			if !ok || !boolValue(row["secret"]) {
				continue
			}
			rowID := secretRowID(row, index)
			value := stringFromAny(row["value"])
			key := requestRowSecretKey(requestID, field, rowID)
			if placeholderKey, ok := kurloSecretKeyFromPlaceholder(value); ok {
				if existingValue, exists := existingSecrets[placeholderKey]; exists {
					secrets[placeholderKey] = existingValue
				}
			} else if value != "" {
				secrets[key] = value
				row["value"] = kurloSecretPlaceholder(key)
			}
		}
	}
}

func sanitizeEnvironmentsForFilesystem(environments []map[string]any, existingSecrets, secrets map[string]string) []map[string]any {
	sanitized := make([]map[string]any, 0, len(environments))
	for _, environment := range environments {
		next := cloneMap(environment)
		envID := stringValue(next, "id")
		if rows, ok := next["values"].([]any); ok && envID != "" {
			for index, rawRow := range rows {
				row, ok := rawRow.(map[string]any)
				if !ok || !boolValue(row["secret"]) {
					continue
				}
				rowID := secretRowID(row, index)
				value := stringFromAny(row["value"])
				key := environmentSecretKey(envID, rowID)
				if placeholderKey, ok := kurloSecretKeyFromPlaceholder(value); ok {
					if existingValue, exists := existingSecrets[placeholderKey]; exists {
						secrets[placeholderKey] = existingValue
					}
				} else if value != "" {
					secrets[key] = value
					row["value"] = kurloSecretPlaceholder(key)
				}
			}
		}
		stripEnvironmentForFilesystem(next)
		sanitized = append(sanitized, next)
	}
	return sanitized
}

func sanitizeWorkspaceCookiesForFilesystem(workspaceCookies map[string][]map[string]any, workspaceIDs map[string]bool, existingSecrets, secrets map[string]string) map[string][]map[string]any {
	sanitized := map[string][]map[string]any{}
	for workspaceID, cookies := range workspaceCookies {
		if workspaceID == "" || !workspaceIDs[workspaceID] {
			continue
		}
		nextCookies := make([]map[string]any, 0, len(cookies))
		for _, cookie := range cookies {
			next := cloneMap(cookie)
			stripTimestamps(next)
			sanitizeWorkspaceCookieSecret(next, workspaceID, existingSecrets, secrets)
			nextCookies = append(nextCookies, next)
		}
		if len(nextCookies) > 0 {
			sanitized[workspaceID] = nextCookies
		}
	}
	return sanitized
}

func sanitizeWorkspaceCookieSecret(cookie map[string]any, workspaceID string, existingSecrets, secrets map[string]string) {
	value := stringFromAny(cookie["value"])
	if placeholderKey, ok := kurloSecretKeyFromPlaceholder(value); ok {
		if existingValue, exists := existingSecrets[placeholderKey]; exists {
			secrets[placeholderKey] = existingValue
		}
		return
	}
	if value == "" {
		return
	}
	key := workspaceCookieSecretKey(workspaceID, cookie)
	secrets[key] = value
	cookie["value"] = kurloSecretPlaceholder(key)
}

func mergeRequestSecrets(request map[string]any, secrets map[string]string) {
	auth := nestedMap(request, "auth")
	if auth != nil {
		for _, field := range requestAuthSecretFields {
			if key, ok := kurloSecretKeyFromPlaceholder(stringFromAny(auth[field])); ok {
				if value, exists := secrets[key]; exists {
					auth[field] = value
				}
			}
		}
	}
	if settings := nestedMap(request, "settings"); settings != nil {
		for _, field := range requestSettingSecretFields {
			if key, ok := kurloSecretKeyFromPlaceholder(stringFromAny(settings[field])); ok {
				if value, exists := secrets[key]; exists {
					settings[field] = value
				}
			}
		}
	}
	mergeRequestSecretRows(request, secrets)
}

func mergeCollectionSecrets(collection map[string]any, secrets map[string]string) {
	defaults := nestedMap(collection, "defaults")
	if defaults == nil {
		return
	}
	auth := nestedMap(defaults, "auth")
	if auth != nil {
		for _, field := range requestAuthSecretFields {
			if key, ok := kurloSecretKeyFromPlaceholder(stringFromAny(auth[field])); ok {
				if value, exists := secrets[key]; exists {
					auth[field] = value
				}
			}
		}
	}
	if settings := nestedMap(defaults, "settings"); settings != nil {
		for _, field := range requestSettingSecretFields {
			if key, ok := kurloSecretKeyFromPlaceholder(stringFromAny(settings[field])); ok {
				if value, exists := secrets[key]; exists {
					settings[field] = value
				}
			}
		}
	}
	mergeCollectionSecretRows(defaults, secrets)
}

func mergeCollectionSecretRows(defaults map[string]any, secrets map[string]string) {
	for _, field := range collectionSecretRowFields {
		rows, ok := defaults[field].([]any)
		if !ok {
			continue
		}
		for _, rawRow := range rows {
			row, ok := rawRow.(map[string]any)
			if !ok {
				continue
			}
			if key, ok := kurloSecretKeyFromPlaceholder(stringFromAny(row["value"])); ok {
				if value, exists := secrets[key]; exists {
					row["value"] = value
				}
			}
		}
	}
}

func mergeRequestSecretRows(request map[string]any, secrets map[string]string) {
	for _, field := range requestSecretRowFields {
		rows, ok := request[field].([]any)
		if !ok {
			continue
		}
		for _, rawRow := range rows {
			row, ok := rawRow.(map[string]any)
			if !ok {
				continue
			}
			if key, ok := kurloSecretKeyFromPlaceholder(stringFromAny(row["value"])); ok {
				if value, exists := secrets[key]; exists {
					row["value"] = value
				}
			}
		}
	}
}

func mergeEnvironmentSecrets(environment map[string]any, secrets map[string]string) {
	rows, ok := environment["values"].([]any)
	if !ok {
		return
	}
	for _, rawRow := range rows {
		row, ok := rawRow.(map[string]any)
		if !ok {
			continue
		}
		if key, ok := kurloSecretKeyFromPlaceholder(stringFromAny(row["value"])); ok {
			if value, exists := secrets[key]; exists {
				row["value"] = value
			}
		}
	}
}

func mergeWorkspaceCookieSecrets(cookies []map[string]any, secrets map[string]string) {
	for _, cookie := range cookies {
		if key, ok := kurloSecretKeyFromPlaceholder(stringFromAny(cookie["value"])); ok {
			if value, exists := secrets[key]; exists {
				cookie["value"] = value
			}
		}
	}
}

var beforeYAMLWrite func(path string) error

func writeYAMLFile(path string, value any) error {
	return writeJournaledYAMLFile(path, value, nil)
}

func writeJournaledYAMLFile(path string, value any, journal *saveJournal) error {
	return writeCanonicalYAMLFile(path, value, journal, nil)
}

func writeCanonicalYAMLFile(path string, value any, journal *saveJournal, canonical func(any) any) error {
	if beforeYAMLWrite != nil {
		if err := beforeYAMLWrite(path); err != nil {
			return err
		}
	}
	data, err := yaml.Marshal(value)
	if err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing to write symlink: %s", path)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("refusing to write non-file path: %s", path)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if existing, err := os.ReadFile(path); err == nil && (string(existing) == string(data) || yamlSameIgnoringTimestamps(existing, data, canonical)) {
		return nil
	}
	if err := journal.record(path); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".kurlo-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0644); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := journal.flush(tmp); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := replaceFile(tmpPath, path); err != nil {
		return err
	}
	cleanup = false
	return journal.syncDir(filepath.Dir(path))
}

func sameJSONValue(left, right any) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftJSON) == string(rightJSON)
}

func dropInferableSettingsOverrides(request, collection map[string]any) {
	overrides, ok := request["settingsOverrides"].(map[string]any)
	if !ok {
		return
	}
	settings, _ := request["settings"].(map[string]any)
	inherited, _ := nestedMap(collection, "defaults")["settings"].(map[string]any)
	inferred := map[string]bool{}
	for key, value := range settings {
		if inheritedValue, ok := inherited[key]; ok && sameJSONValue(inheritedValue, value) {
			continue
		}
		inferred[key] = true
	}
	explicit := map[string]bool{}
	for key, value := range overrides {
		if boolValue(value) {
			explicit[key] = true
		}
	}
	if reflect.DeepEqual(explicit, inferred) {
		delete(request, "settingsOverrides")
	}
}

func yamlSameIgnoringTimestamps(existing, next []byte, canonical func(any) any) bool {
	var left, right any
	if yaml.Unmarshal(existing, &left) != nil || yaml.Unmarshal(next, &right) != nil {
		return false
	}
	if canonical != nil {
		left = canonical(left)
	}
	return reflect.DeepEqual(withoutTimestamps(left), withoutTimestamps(right))
}

func canonicalRequestFile(collection map[string]any) func(any) any {
	return func(doc any) any {
		file, ok := doc.(map[string]any)
		if !ok {
			return doc
		}
		if request, ok := file["request"].(map[string]any); ok {
			dropInferableSettingsOverrides(request, collection)
		}
		return file
	}
}

func withoutTimestamps(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			if key == "createdAt" || key == "updatedAt" {
				continue
			}
			out[key] = withoutTimestamps(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = withoutTimestamps(item)
		}
		return out
	}
	return value
}

func yamlFileFormatVersion(out any) int {
	value := reflect.ValueOf(out)
	if value.Kind() != reflect.Pointer || value.Elem().Kind() != reflect.Struct {
		return 0
	}
	field := value.Elem().FieldByName("Version")
	if !field.IsValid() || field.Kind() != reflect.Int {
		return 0
	}
	return int(field.Int())
}

func readYAMLFile(path string, out any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("read %s: refusing to read symlink", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := yaml.Unmarshal(data, out); err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if version := yamlFileFormatVersion(out); version > fileStoreVersion {
		return fmt.Errorf("read %s: written by a newer Kurlo (file format version %d, this version reads %d). Update Kurlo to open it", path, version, fileStoreVersion)
	}
	return nil
}

func sharedStoreHash(workspaces, collections, requests, environments []map[string]any, workspaceCookies map[string][]map[string]any) (string, error) {
	payload, err := json.Marshal(kurloSharedStore{
		PathLayout:       workspacePathLayout,
		Workspaces:       workspaces,
		Collections:      collections,
		Requests:         requests,
		Environments:     environments,
		WorkspaceCookies: workspaceCookies,
	})
	if err != nil {
		return "", err
	}
	return shortHash(string(payload)), nil
}

func decodeJSONMap(payload string) (map[string]any, error) {
	var store map[string]any
	if err := json.Unmarshal([]byte(payload), &store); err != nil {
		return nil, err
	}
	if store == nil {
		store = map[string]any{}
	}
	return store, nil
}

func cloneMap(input map[string]any) map[string]any {
	if input == nil {
		return map[string]any{}
	}
	data, _ := json.Marshal(input)
	var output map[string]any
	_ = json.Unmarshal(data, &output)
	if output == nil {
		output = map[string]any{}
	}
	return output
}

func mapSlice(value any) []map[string]any {
	if values, ok := value.([]map[string]any); ok {
		return values
	}
	values, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]map[string]any, 0, len(values))
	for _, value := range values {
		if mapped, ok := value.(map[string]any); ok {
			result = append(result, mapped)
		}
	}
	return result
}

func workspaceCookiesFromStore(value any) map[string][]map[string]any {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	result := map[string][]map[string]any{}
	for workspaceID, rawCookies := range raw {
		if workspaceID == "" {
			continue
		}
		cookies := mapSlice(rawCookies)
		if len(cookies) > 0 {
			result[workspaceID] = cookies
		}
	}
	return result
}

func entityIDSet(items []map[string]any) map[string]bool {
	ids := make(map[string]bool, len(items))
	for _, item := range items {
		if id := stringValue(item, "id"); id != "" {
			ids[id] = true
		}
	}
	return ids
}

func groupByString(items []map[string]any, key string) map[string][]map[string]any {
	grouped := map[string][]map[string]any{}
	for _, item := range items {
		groupKey := stringValue(item, key)
		grouped[groupKey] = append(grouped[groupKey], item)
	}
	return grouped
}

func idsFor(items []map[string]any) []string {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		if id := stringValue(item, "id"); id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

func filesystemSegmentsForItems(items []map[string]any) map[string]string {
	used := map[string]string{}
	segments := map[string]string{}
	for _, item := range items {
		id := stringValue(item, "id")
		if id == "" {
			continue
		}
		segment := filesystemSegmentForItem(item)
		baseSegment := segment
		for suffix := 0; ; suffix++ {
			existingID, exists := used[strings.ToLower(segment)]
			if !exists || existingID == id {
				break
			}
			if suffix == 0 {
				segment = baseSegment + "-1"
			} else {
				segment = fmt.Sprintf("%s-%d", baseSegment, suffix+1)
			}
		}
		used[strings.ToLower(segment)] = id
		segments[id] = segment
		item[filesystemNameField] = segment
	}
	return segments
}

func filesystemSegmentForItem(item map[string]any) string {
	segment := safePathSegment(stringValue(item, filesystemNameField))
	if segment == "" {
		segment = safePathSegment(stringValue(item, "name"))
	}
	if segment == "" {
		segment = pathSafeID(stringValue(item, "id"))
	}
	return segment
}

func requireItemFilesystemName(item map[string]any, path string) error {
	if stringValue(item, filesystemNameField) == "" {
		derived := filesystemNameFromPath(path)
		if derived == "" {
			return fmt.Errorf("%s is missing filesystemName", path)
		}
		item[filesystemNameField] = derived
		return nil
	}
	item[filesystemNameField] = filesystemSegmentForItem(item)
	return nil
}

func filesystemNameFromPath(path string) string {
	base := filepath.Base(path)
	if base == fileStoreRootFileName || base == fileStoreCollection {
		return filepath.Base(filepath.Dir(path))
	}
	if filepath.Ext(base) == fileStoreYAMLExt {
		return base[:len(base)-len(fileStoreYAMLExt)]
	}
	return ""
}

func indexByID(ids []string) map[string]int {
	result := make(map[string]int, len(ids))
	for index, id := range ids {
		result[id] = index
	}
	return result
}

func nestedMap(item map[string]any, key string) map[string]any {
	value, ok := item[key].(map[string]any)
	if !ok {
		return nil
	}
	return value
}

func stringMap(value any) map[string]string {
	raw, ok := value.(map[string]any)
	if !ok {
		return map[string]string{}
	}
	result := make(map[string]string, len(raw))
	for key, value := range raw {
		result[key] = stringFromAny(value)
	}
	return result
}

func cloneStringMap(input map[string]string) map[string]string {
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func localStoreStorage(store map[string]any) map[string]any {
	storage, _ := store["storage"].(map[string]any)
	return storage
}

func localStoreSharedHash(store map[string]any) string {
	return stringValue(localStoreStorage(store), "sharedHash")
}

func stringValue(item map[string]any, key string) string {
	return stringFromAny(item[key])
}

func stringFromAny(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	default:
		return ""
	}
}

func boolValue(value any) bool {
	valueBool, _ := value.(bool)
	return valueBool
}

func rowIDValue(row map[string]any) string {
	switch value := row["id"].(type) {
	case string:
		return value
	case float64:
		return fmt.Sprintf("%.0f", value)
	case int:
		return fmt.Sprintf("%d", value)
	default:
		return ""
	}
}

func secretRowID(row map[string]any, index int) string {
	if id := rowIDValue(row); id != "" {
		return id
	}
	return fmt.Sprintf("index-%d", index)
}

func requestSecretKey(requestID, field string) string {
	return "request." + requestID + ".auth." + field
}

func requestSettingSecretKey(requestID, field string) string {
	return "request." + requestID + ".settings." + field
}

func requestRowSecretKey(requestID, field, rowID string) string {
	return "request." + requestID + "." + field + ".row." + rowID + ".value"
}

func collectionSecretKey(collectionID, field string) string {
	return "collection." + collectionID + ".auth." + field
}

func collectionSettingSecretKey(collectionID, field string) string {
	return "collection." + collectionID + ".settings." + field
}

func collectionRowSecretKey(collectionID, field, rowID string) string {
	return "collection." + collectionID + "." + field + ".row." + rowID + ".value"
}

func environmentSecretKey(environmentID, rowID string) string {
	return "environment." + environmentID + ".row." + rowID + ".value"
}

func workspaceCookieSecretKey(workspaceID string, cookie map[string]any) string {
	name := safePathSegment(stringValue(cookie, "name"))
	if name == "" {
		name = "cookie"
	}
	path := stringValue(cookie, "path")
	if path == "" {
		path = "/"
	}
	identity := strings.Join([]string{
		strings.ToLower(strings.Trim(stringValue(cookie, "domain"), ".")),
		path,
		stringValue(cookie, "name"),
		boolKey(boolValue(cookie["hostOnly"])),
	}, "\x1f")
	return "workspace." + workspaceID + ".cookies." + name + "." + shortHash(identity) + ".value"
}

func kurloSecretPlaceholder(key string) string {
	return kurloSecretPrefix + key + kurloSecretSuffix
}

func kurloSecretKeyFromPlaceholder(value string) (string, bool) {
	if !strings.HasPrefix(value, kurloSecretPrefix) || !strings.HasSuffix(value, kurloSecretSuffix) {
		return "", false
	}
	key := strings.TrimSuffix(strings.TrimPrefix(value, kurloSecretPrefix), kurloSecretSuffix)
	return key, key != ""
}

func pathSafeID(id string) string {
	segment := safePathSegment(id)
	if segment == "" {
		return shortHash(id)
	}
	if segment != id {
		return segment + "." + shortHash(id)
	}
	return segment
}

var unsafePathChars = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)
var repeatedPathDashes = regexp.MustCompile(`-+`)

func safePathSegment(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	value = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return '-'
		}
		return r
	}, value)
	value = unsafePathChars.ReplaceAllString(value, "-")
	value = repeatedPathDashes.ReplaceAllString(value, "-")
	value = strings.Trim(value, ".-_")
	if value == "" {
		return "item"
	}
	for strings.Contains(value, "..") {
		value = strings.ReplaceAll(value, "..", "-")
	}
	value = repeatedPathDashes.ReplaceAllString(value, "-")
	value = strings.Trim(value, ".-_")
	if value == "" {
		return "item"
	}
	if len(value) > 80 {
		value = truncateUTF8(value, 80)
		value = strings.Trim(value, ".-_")
	}
	return value
}

func truncateUTF8(value string, max int) string {
	if len(value) <= max {
		return value
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}

func shortHash(value string) string {
	hash := sha1.Sum([]byte(value))
	return hex.EncodeToString(hash[:])[:10]
}

var pureVariableReferenceRe = regexp.MustCompile(`^\{\{\s*[^{}\s]+\s*\}\}$`)

func secretFieldNeedsVault(value string) bool {
	return value != "" && !pureVariableReferenceRe.MatchString(value)
}
