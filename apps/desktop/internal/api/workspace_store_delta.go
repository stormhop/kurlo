package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
)

var errStoreDeltaStale = errors.New("workspace changed since the last full save")

var storeSaveRevision atomic.Int64

type storeRequestShape struct {
	collectionID string
}

type storeEnvironmentShape struct {
	workspaceID string
}

type storeSaveShape struct {
	revision         int64
	workspaces       string
	collections      string
	requestOrder     []string
	requests         map[string]storeRequestShape
	environmentOrder []string
	environments     map[string]storeEnvironmentShape
}

type storeDeltaPayload struct {
	Base       int64            `json:"base"`
	Store      map[string]any   `json:"store"`
	RequestIDs []string         `json:"requestIds"`
	Requests   []map[string]any `json:"requests"`
}

func canonicalJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func storeShapeFromPayload(store map[string]any) *storeSaveShape {
	shape := &storeSaveShape{
		workspaces:   canonicalJSON(store["workspaces"]),
		collections:  canonicalJSON(store["collections"]),
		requests:     map[string]storeRequestShape{},
		environments: map[string]storeEnvironmentShape{},
	}
	for _, request := range mapSlice(store["requests"]) {
		id := stringValue(request, "id")
		shape.requestOrder = append(shape.requestOrder, id)
		shape.requests[id] = storeRequestShape{collectionID: stringValue(request, "collectionId")}
	}
	for _, environment := range mapSlice(store["environments"]) {
		id := stringValue(environment, "id")
		shape.environmentOrder = append(shape.environmentOrder, id)
		shape.environments[id] = storeEnvironmentShape{workspaceID: stringValue(environment, "workspaceId")}
	}
	return shape
}

func sameStringList(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func (t *workspaceDiskTracker) rememberSavedShape(root string, shape *storeSaveShape) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if sameWorkspaceRoot(t.root, root) && t.known != nil && t.savedSegments != nil {
		t.savedShape = shape
	}
}

func (t *workspaceDiskTracker) forgetSavedShape() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.savedShape = nil
}

type storeDeltaDisk struct {
	shape    *storeSaveShape
	segments map[string]string
	known    workspaceSnapshot
}

func (t *workspaceDiskTracker) deltaDisk(root string) (storeDeltaDisk, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !sameWorkspaceRoot(t.root, root) || t.known == nil || t.savedSegments == nil || t.savedShape == nil {
		return storeDeltaDisk{}, false
	}
	if t.announced != t.known.fingerprint() {
		return storeDeltaDisk{}, false
	}
	return storeDeltaDisk{shape: t.savedShape, segments: t.savedSegments, known: t.known}, true
}

func (t *workspaceDiskTracker) noteDeltaWrites(root string, rels []string, shape *storeSaveShape) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !sameWorkspaceRoot(t.root, root) || t.known == nil {
		return errStoreDeltaStale
	}
	next := make(workspaceSnapshot, len(t.known))
	for rel, stamp := range t.known {
		next[rel] = stamp
	}
	for _, rel := range rels {
		path := filepath.Join(root, filepath.FromSlash(rel))
		info, err := os.Lstat(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				delete(next, rel)
				continue
			}
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		next[rel] = workspaceFileStamp{size: info.Size(), mod: info.ModTime().UnixNano(), hash: contentHash(data)}
	}
	t.known = next
	t.announced = next.fingerprint()
	t.savedShape = shape
	return nil
}

type storeDeltaWrite struct {
	path      string
	rel       string
	value     any
	canonical func(any) any
}

func (a *App) SaveRequestStoreDelta(payload string) SaveRequestStoreResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	revision, err := a.saveRequestStoreDelta(payload)
	if errors.Is(err, errStoreDeltaStale) {
		return SaveRequestStoreResult{Ok: false, NeedFull: true}
	}
	if err != nil {
		workspaceDisk.forgetSavedShape()
		return SaveRequestStoreResult{Ok: false, Error: err.Error()}
	}
	return SaveRequestStoreResult{Ok: true, Revision: revision}
}

func (a *App) saveRequestStoreDelta(payload string) (int64, error) {
	root := fileWorkspaceStorePath()
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		return 0, err
	}
	defer unlock()
	if failedStoreLoads.failed(root) {
		return 0, errStoreDeltaStale
	}
	if seen := a.globalsRevision.Load(); seen != nil && *seen != currentProfileGlobalsRevision() {
		return 0, errStoreDeltaStale
	}
	var delta storeDeltaPayload
	if err := json.Unmarshal([]byte(payload), &delta); err != nil {
		return 0, err
	}
	if delta.Store == nil {
		return 0, errStoreDeltaStale
	}
	disk, ok := workspaceDisk.deltaDisk(root)
	if !ok || disk.shape.revision != delta.Base {
		return 0, errStoreDeltaStale
	}
	store := delta.Store
	delete(store, "requests")
	if canonicalJSON(store["workspaces"]) != disk.shape.workspaces || canonicalJSON(store["collections"]) != disk.shape.collections {
		return 0, errStoreDeltaStale
	}
	if !sameStringList(delta.RequestIDs, disk.shape.requestOrder) {
		return 0, errStoreDeltaStale
	}
	workspaces := mapSlice(store["workspaces"])
	collections := mapSlice(store["collections"])
	environments := mapSlice(store["environments"])
	if !sameStringList(idsFor(environments), disk.shape.environmentOrder) {
		return 0, errStoreDeltaStale
	}
	if err := validateWorkspaceStorePayload(map[string]any{"workspaces": store["workspaces"], "collections": store["collections"], "requests": anySlice(delta.Requests), "environments": store["environments"]}); err != nil {
		return 0, err
	}
	examples, ok := loadedRequestExamples.snapshot(root)
	if !ok {
		return 0, errStoreDeltaStale
	}
	seen := map[string]bool{}
	for _, request := range delta.Requests {
		id := stringValue(request, "id")
		shape, known := disk.shape.requests[id]
		if id == "" || seen[id] || !known || shape.collectionID != stringValue(request, "collectionId") {
			return 0, errStoreDeltaStale
		}
		seen[id] = true
		if !segmentKeepsName(disk.segments["request:"+id], stringValue(request, "name")) {
			return 0, errStoreDeltaStale
		}
		delete(request, exampleCountField)
		if raw, sent := request["examples"]; sent {
			cached, hasCached := examples[id]
			list, isList := raw.([]any)
			switch {
			case hasCached && bytes.Equal([]byte(canonicalJSON(raw)), cached):
			case !hasCached && isList && len(list) == 0:
			default:
				return 0, errStoreDeltaStale
			}
			delete(request, "examples")
		}
	}
	for _, environment := range environments {
		id := stringValue(environment, "id")
		if disk.shape.environments[id].workspaceID != stringValue(environment, "workspaceId") || !segmentKeepsName(disk.segments["environment:"+id], stringValue(environment, "name")) {
			return 0, errStoreDeltaStale
		}
	}

	local := requestStorePath()
	existingStore, _, err := loadLocalRequestStore(local)
	if err != nil {
		return 0, errStoreDeltaStale
	}
	existingSecrets := stringMap(existingStore["secrets"])
	if existingSecrets == nil {
		existingSecrets = map[string]string{}
	}
	storageMode := inferWorkspaceStorageMode(root)
	if mode := stringValue(localStoreStorage(existingStore), "mode"); mode == workspaceStorageModeGit || mode == workspaceStorageModeLocal {
		storageMode = mode
	}
	delete(store, profileGlobalsRevisionField)
	if revision := stringValue(existingStore, profileGlobalsRevisionField); revision != "" {
		store[profileGlobalsRevisionField] = revision
	}

	fresh := map[string]string{}
	sanitizedRequests := sanitizeRequestsForFilesystem(delta.Requests, existingSecrets, fresh)
	sanitizedEnvironments := sanitizeEnvironmentsForFilesystem(environments, existingSecrets, fresh)
	sanitizedWorkspaces := sanitizeWorkspacesForFilesystem(workspaces)
	sanitizedCollections := sanitizeCollectionsForFilesystem(collections, existingSecrets, fresh)
	sanitizedCookies := sanitizeWorkspaceCookiesForFilesystem(workspaceCookiesFromStore(store["workspaceCookies"]), entityIDSet(workspaces), existingSecrets, fresh)
	secrets, secretsChanged := secretsAhead(existingSecrets, fresh)

	collectionsByID := map[string]map[string]any{}
	for _, collection := range sanitizedCollections {
		collectionsByID[stringValue(collection, "id")] = collection
	}
	collectionsByWorkspace := groupByString(sanitizedCollections, "workspaceId")
	workspaceDir := func(workspaceID string) (string, bool) {
		segment := disk.segments["workspace:"+workspaceID]
		return filepath.Join(root, fileStoreWorkspacesDir, segment), segment != ""
	}

	var candidates []storeDeltaWrite
	add := func(path string, value any, canonical func(any) any) error {
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		candidates = append(candidates, storeDeltaWrite{path: path, rel: filepath.ToSlash(rel), value: value, canonical: canonical})
		return nil
	}
	for _, workspace := range sanitizedWorkspaces {
		id := stringValue(workspace, "id")
		dir, ok := workspaceDir(id)
		if !ok {
			return 0, errStoreDeltaStale
		}
		delete(workspace, filesystemNameField)
		if err := add(filepath.Join(dir, fileStoreRootFileName), filesystemWorkspaceFile{
			Version:         fileStoreVersion,
			Workspace:       workspace,
			CollectionOrder: idsFor(collectionsByWorkspace[id]),
			Cookies:         sanitizedCookies[id],
		}, nil); err != nil {
			return 0, err
		}
	}
	for _, environment := range sanitizedEnvironments {
		dir, ok := workspaceDir(stringValue(environment, "workspaceId"))
		if !ok {
			return 0, errStoreDeltaStale
		}
		segment := disk.segments["environment:"+stringValue(environment, "id")]
		delete(environment, filesystemNameField)
		if err := add(filepath.Join(dir, fileStoreEnvironmentsDir, segment+fileStoreYAMLExt), filesystemEnvironmentFile{Version: fileStoreVersion, Environment: environment}, nil); err != nil {
			return 0, err
		}
	}
	for _, request := range sanitizedRequests {
		collection := collectionsByID[stringValue(request, "collectionId")]
		dir, ok := workspaceDir(stringValue(collection, "workspaceId"))
		collectionSegment := disk.segments["collection:"+stringValue(collection, "id")]
		if collection == nil || !ok || collectionSegment == "" {
			return 0, errStoreDeltaStale
		}
		segment := disk.segments["request:"+stringValue(request, "id")]
		delete(request, "examples")
		delete(request, filesystemNameField)
		dropInferableSettingsOverrides(request, collection)
		path := filepath.Join(dir, fileStoreCollectionsDir, collectionSegment, fileStoreRequestsDir, segment+fileStoreYAMLExt)
		if err := add(path, filesystemRequestFile{Version: fileStoreVersion, Request: request}, canonicalRequestFile(collection)); err != nil {
			return 0, err
		}
	}

	journal := &saveJournal{root: root, known: map[string]string{}}
	for rel, stamp := range disk.known {
		if stamp.hash != "" {
			journal.known[filepath.Join(root, filepath.FromSlash(rel))] = stamp.hash
		}
	}
	var writes []storeDeltaWrite
	for _, candidate := range candidates {
		data, err := marshalWorkspaceYAML(candidate.value)
		if err != nil {
			return 0, err
		}
		if journal.unchanged(candidate.path, data) {
			continue
		}
		stamp, tracked := disk.known[candidate.rel]
		info, err := os.Lstat(candidate.path)
		if !tracked || err != nil || !info.Mode().IsRegular() || !sameStamp(stamp, workspaceFileStamp{size: info.Size(), mod: info.ModTime().UnixNano()}) {
			return 0, errStoreDeltaStale
		}
		writes = append(writes, candidate)
	}

	yamlStoreWriteMu.Lock()
	defer yamlStoreWriteMu.Unlock()
	if err := recoverInterruptedSave(root); err != nil {
		return 0, err
	}
	if len(writes) > 0 && secretsChanged {
		if err := saveLocalKurloStore(local, buildLocalKurloStore(store, root, secrets, "", storageMode)); err != nil {
			return 0, err
		}
	}
	defer journal.close()
	rels := make([]string, 0, len(writes))
	for _, write := range writes {
		if err := writeCanonicalYAMLFile(write.path, write.value, journal, write.canonical); err != nil {
			return 0, err
		}
		rels = append(rels, write.rel)
	}
	if err := journal.finish(); err != nil {
		return 0, err
	}
	if err := saveLocalKurloStore(local, buildLocalKurloStore(store, root, secrets, "", storageMode)); err != nil {
		return 0, err
	}
	next := *disk.shape
	next.revision = storeSaveRevision.Add(1)
	if err := workspaceDisk.noteDeltaWrites(root, rels, &next); err != nil {
		return 0, err
	}
	return next.revision, nil
}

func segmentKeepsName(segment, name string) bool {
	return segment != "" && segmentFitsName(segment, fileNameForName(name))
}

func anySlice(items []map[string]any) []any {
	out := make([]any, 0, len(items))
	for _, item := range items {
		out = append(out, item)
	}
	return out
}
