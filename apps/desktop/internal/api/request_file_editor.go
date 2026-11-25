package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

type RequestFileYAMLResult struct {
	Ok          bool   `json:"ok"`
	ID          string `json:"id"`
	Path        string `json:"path"`
	Content     string `json:"content"`
	Revision    string `json:"revision"`
	RequestJSON string `json:"requestJson,omitempty"`
	Error       string `json:"error,omitempty"`
	Line        int    `json:"line,omitempty"`
	Conflict    bool   `json:"conflict,omitempty"`
}

type requestFileYAMLBaselineEntry struct {
	path           string
	workspaceID    string
	collectionID   string
	filesystemName string
	structure      requestFileYAMLStructure
}

type requestFileYAMLStructure struct {
	version           int
	versionLine       int
	order             int
	orderValue        any
	orderPresent      bool
	orderLine         int
	rootLine          int
	requestLine       int
	request           map[string]any
	requestFieldLines map[string]int
}

var requestFileYAMLBaselines = struct {
	sync.Mutex
	items map[string]requestFileYAMLBaselineEntry
}{items: map[string]requestFileYAMLBaselineEntry{}}

func (a *App) GetRequestFileYAML(workspaceRoot, requestID, pathHint string) RequestFileYAMLResult {
	gitOperationMu.RLock()
	defer gitOperationMu.RUnlock()
	root := fileWorkspaceStorePath()
	if !sameWorkspaceRoot(workspaceRoot, root) {
		return requestFileYAMLFailure(requestID, "workspace changed; reopen the request")
	}
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		return requestFileYAMLFailure(requestID, err.Error())
	}
	defer unlock()
	context, err := loadRequestYAMLContext(root, requestID, pathHint, nil)
	if err != nil {
		return requestFileYAMLFailure(requestID, err.Error())
	}
	content := context.content
	path := context.path
	requestJSON, err := json.Marshal(context.request)
	if err != nil {
		return requestFileYAMLFailure(requestID, err.Error())
	}
	rememberRequestFileYAMLBaseline(root, requestID, context)
	return RequestFileYAMLResult{Ok: true, ID: requestID, Path: workspaceDiagnosticPath(root, path), Content: content, Revision: requestFileYAMLRevision(content), RequestJSON: string(requestJSON)}
}

func (a *App) SaveRequestFileYAML(workspaceRoot, requestID, content, baseRevision, pathHint string) RequestFileYAMLResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	if !sameWorkspaceRoot(workspaceRoot, root) {
		return requestFileYAMLFailure(requestID, "workspace changed; reopen the request")
	}
	if len(content) > maxTextFileReadSize {
		return requestFileYAMLFailure(requestID, fmt.Sprintf("file is larger than %d MB", maxTextFileReadSize/(1024*1024)))
	}
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		return requestFileYAMLFailure(requestID, err.Error())
	}
	defer unlock()
	hintedPath, pathParts, err := requestYAMLPathHint(root, pathHint)
	if err != nil {
		return requestFileYAMLFailure(requestID, err.Error())
	}
	var knownContent *string
	var context requestYAMLContext
	var comparisonRequest map[string]any
	var currentOnDisk string
	recoveredInvalidDisk := false
	if current, readErr := readRequestFile(hintedPath); readErr == nil {
		knownContent = &current
		currentOnDisk = current
		if baseRevision == "" || requestFileYAMLRevision(current) != baseRevision {
			baseline, cached := getRequestFileYAMLBaseline(root, requestID)
			workspaceID, collectionID, parentsErr := requestYAMLParentIDs(root, pathParts)
			if parentsErr != nil {
				return requestFileYAMLFailure(requestID, parentsErr.Error())
			}
			if cached && baseline.path == hintedPath && baseline.workspaceID == workspaceID && baseline.collectionID == collectionID {
				if diskRequest, _, _, parseErr := parseRequestFileYAMLDetailed(current); parseErr == nil && (stringValue(diskRequest, "id") != requestID || stringValue(diskRequest, "collectionId") != "" && stringValue(diskRequest, "collectionId") != collectionID) {
					return requestFileYAMLFailure(requestID, "request file path does not match this request")
				}
				return requestFileYAMLConflict(root, requestID, hintedPath, current)
			}
			verified, verifyErr := loadRequestYAMLContext(root, requestID, pathHint, knownContent)
			if verifyErr != nil {
				return requestFileYAMLFailure(requestID, verifyErr.Error())
			}
			return requestFileYAMLConflict(root, requestID, verified.path, verified.content)
		}
		if _, _, parseErr := parseRequestFileYAML(current); parseErr != nil {
			baseline, cached := getRequestFileYAMLBaseline(root, requestID)
			workspaceID, collectionID, parentsErr := requestYAMLParentIDs(root, pathParts)
			if parentsErr != nil || !cached || baseline.path != hintedPath || baseline.workspaceID != workspaceID || baseline.collectionID != collectionID {
				return requestFileYAMLResultFailure(root, requestID, hintedPath, current, "The request YAML on disk is invalid. Restore it in Workspace diagnostics before saving.", 1)
			}
			proposed, proposedStructure, line, parseErr := parseRequestFileYAMLDetailed(content)
			if parseErr != nil {
				return requestFileYAMLResultFailure(root, requestID, hintedPath, current, parseErr.Error(), line)
			}
			comparisonRequest = map[string]any{
				"id":                requestID,
				"collectionId":      baseline.collectionID,
				filesystemNameField: baseline.filesystemName,
			}
			if line, err := validateRequestFileEdit(comparisonRequest, proposed, baseline.structure, proposedStructure); err != nil {
				return requestFileYAMLResultFailure(root, requestID, hintedPath, current, err.Error(), line)
			}
			context, err = loadRequestYAMLContext(root, requestID, pathHint, &content)
			if err != nil {
				return requestFileYAMLFailure(requestID, err.Error())
			}
			context.content = current
			recoveredInvalidDisk = true
		}
	} else if !os.IsNotExist(readErr) {
		return requestFileYAMLFailure(requestID, readErr.Error())
	}
	if context.path == "" {
		context, err = loadRequestYAMLContext(root, requestID, pathHint, knownContent)
		if err != nil {
			if knownContent != nil && requestFileYAMLRevision(*knownContent) != baseRevision {
				return requestFileYAMLConflict(root, requestID, hintedPath, *knownContent)
			}
			if knownContent != nil {
				if _, line, parseErr := parseRequestFileYAML(*knownContent); parseErr != nil {
					return requestFileYAMLResultFailure(root, requestID, hintedPath, *knownContent, "The request YAML on disk is invalid. Restore it in Workspace diagnostics before saving.", line)
				}
			}
			return requestFileYAMLFailure(requestID, err.Error())
		}
	}
	request := context.request
	path := context.path
	if comparisonRequest == nil {
		comparisonRequest = request
	}
	if currentOnDisk == "" {
		currentOnDisk = context.content
	}
	if !recoveredInvalidDisk && (baseRevision == "" || requestFileYAMLRevision(currentOnDisk) != baseRevision) {
		return requestFileYAMLConflict(root, requestID, path, currentOnDisk)
	}
	edited, editedStructure, line, err := parseRequestFileYAMLDetailed(content)
	if err != nil {
		return requestFileYAMLResultFailure(root, requestID, path, currentOnDisk, err.Error(), line)
	}
	if line, err := validateRequestFileEdit(comparisonRequest, edited, context.structure, editedStructure); err != nil {
		return requestFileYAMLResultFailure(root, requestID, path, currentOnDisk, err.Error(), line)
	}
	if _, exists := edited["collectionId"]; !exists {
		edited["collectionId"] = stringValue(request, "collectionId")
	}
	doc, check := checkedRequestDocument(content)
	if !check.Ok {
		return requestFileYAMLResultFailure(root, requestID, path, currentOnDisk, check.Message, check.Line)
	}
	omitRequestEditorDefaults(edited)
	updated := cloneMap(edited)
	updated["collectionId"] = stringValue(request, "collectionId")
	updated[filesystemNameField] = stringValue(request, filesystemNameField)
	if examples, exists := request["examples"]; exists {
		updated["examples"] = examples
	}
	if err := validateWorkspaceStorePayload(map[string]any{"workspaces": []map[string]any{context.workspace}, "collections": []map[string]any{context.collection}, "requests": []map[string]any{updated}}); err != nil {
		return requestFileYAMLResultFailure(root, requestID, path, currentOnDisk, err.Error(), 0)
	}
	localStore, _, err := loadLocalRequestStore(requestStorePath())
	if os.IsNotExist(err) {
		localStore = map[string]any{}
	} else if err != nil {
		return requestFileYAMLResultFailure(root, requestID, path, currentOnDisk, err.Error(), 0)
	}
	existingSecrets := stringMap(localStore["secrets"])
	freshSecrets := map[string]string{}
	sanitizeRequestsForFilesystem([]map[string]any{cloneMap(updated)}, map[string]string{}, freshSecrets)
	if len(freshSecrets) > 0 {
		return requestFileYAMLResultFailure(root, requestID, path, currentOnDisk, "edit new secret values in Auth or Vars, then keep their vault references in the YAML file", 0)
	}
	sanitizedRequests := sanitizeRequestsForFilesystem([]map[string]any{cloneMap(updated)}, existingSecrets, map[string]string{})
	requestForFile := sanitizedRequests[0]
	delete(requestForFile, filesystemNameField)
	delete(requestForFile, "examples")
	collection := context.collection
	dropInferableSettingsOverrides(requestForFile, collection)
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return requestFileYAMLResultFailure(root, requestID, path, currentOnDisk, err.Error(), 0)
	}
	if _, err := safeWorkspaceYAMLPath(root, filepath.ToSlash(rel)); err != nil {
		return requestFileYAMLResultFailure(root, requestID, path, currentOnDisk, err.Error(), 0)
	}
	formatted := formatRequestFileDocument(doc, content)
	if !formatted.Ok {
		return requestFileYAMLResultFailure(root, requestID, path, currentOnDisk, formatted.Error, formatted.Line)
	}
	if len(formatted.Content) > maxTextFileReadSize {
		return requestFileYAMLResultFailure(root, requestID, path, currentOnDisk, fmt.Sprintf("formatted file is larger than %d MB", maxTextFileReadSize/(1024*1024)), 0)
	}
	resultRequest := cloneMap(updated)
	resultRequest["collection"] = stringValue(collection, "name")
	updateRequestRows(resultRequest, restoreWorkspaceRowDefaults)
	mergeRequestSecrets(resultRequest, existingSecrets)
	requestJSON, err := json.Marshal(resultRequest)
	if err != nil {
		return requestFileYAMLResultFailure(root, requestID, path, currentOnDisk, err.Error(), 0)
	}
	latest, err := readRequestFile(path)
	if err != nil || requestFileYAMLRevision(latest) != baseRevision {
		return requestFileYAMLConflict(root, requestID, path, latest)
	}
	fileInfo, err := os.Lstat(path)
	if err != nil || fileInfo.Mode()&os.ModeSymlink != 0 || !fileInfo.Mode().IsRegular() {
		if err == nil {
			err = fmt.Errorf("request file is not a regular file")
		}
		return requestFileYAMLResultFailure(root, requestID, path, currentOnDisk, err.Error(), 0)
	}
	if formatted.Content != latest {
		data := []byte(formatted.Content)
		if err := writeFileAtomicMode(path, data, fileInfo.Mode().Perm()); err != nil {
			return requestFileYAMLResultFailure(root, requestID, path, currentOnDisk, err.Error(), 0)
		}
		workspaceYAMLMemoForRawRequest(path, filesystemRequestFile{Version: fileStoreVersion, Request: requestForFile}, data)
		if err := workspaceDisk.noteDeltaWrites(root, []string{filepath.ToSlash(rel)}, nil); err != nil {
			workspaceDisk.forgetSavedShape()
		}
	}
	return RequestFileYAMLResult{Ok: true, ID: requestID, Path: workspaceDiagnosticPath(root, path), Content: formatted.Content, Revision: requestFileYAMLRevision(formatted.Content), RequestJSON: string(requestJSON)}
}

type requestYAMLContext struct {
	request    map[string]any
	collection map[string]any
	workspace  map[string]any
	path       string
	content    string
	structure  requestFileYAMLStructure
}

func requestFileYAMLBaselineKey(root, requestID string) string {
	return filepath.Clean(root) + "\x00" + requestID
}

func rememberRequestFileYAMLBaseline(root, requestID string, context requestYAMLContext) {
	requestFileYAMLBaselines.Lock()
	defer requestFileYAMLBaselines.Unlock()
	if len(requestFileYAMLBaselines.items) >= 10000 {
		requestFileYAMLBaselines.items = map[string]requestFileYAMLBaselineEntry{}
	}
	requestFileYAMLBaselines.items[requestFileYAMLBaselineKey(root, requestID)] = requestFileYAMLBaselineEntry{
		path:           context.path,
		workspaceID:    stringValue(context.workspace, "id"),
		collectionID:   stringValue(context.collection, "id"),
		filesystemName: stringValue(context.request, filesystemNameField),
		structure:      context.structure,
	}
}

func getRequestFileYAMLBaseline(root, requestID string) (requestFileYAMLBaselineEntry, bool) {
	requestFileYAMLBaselines.Lock()
	defer requestFileYAMLBaselines.Unlock()
	baseline, exists := requestFileYAMLBaselines.items[requestFileYAMLBaselineKey(root, requestID)]
	return baseline, exists
}

func requestYAMLParentIDs(root string, parts []string) (string, string, error) {
	workspacePath, err := safeWorkspaceYAMLPath(root, filepath.ToSlash(filepath.Join(fileStoreWorkspacesDir, parts[1], fileStoreRootFileName)))
	if err != nil {
		return "", "", err
	}
	collectionPath, err := safeWorkspaceYAMLPath(root, filepath.ToSlash(filepath.Join(fileStoreWorkspacesDir, parts[1], fileStoreCollectionsDir, parts[3], fileStoreCollection)))
	if err != nil {
		return "", "", err
	}
	var workspaceFile filesystemWorkspaceFile
	if err := readYAMLFile(workspacePath, &workspaceFile); err != nil {
		return "", "", err
	}
	var collectionFile filesystemCollectionFile
	if err := readYAMLFile(collectionPath, &collectionFile); err != nil {
		return "", "", err
	}
	workspace, workspaceOK := workspaceFile.Workspace.(map[string]any)
	collection, collectionOK := collectionFile.Collection.(map[string]any)
	workspaceID := stringValue(workspace, "id")
	collectionID := stringValue(collection, "id")
	if !workspaceOK || !collectionOK || workspaceFile.Version != fileStoreVersion || collectionFile.Version != fileStoreVersion || workspaceID == "" || collectionID == "" || stringValue(collection, "workspaceId") != workspaceID {
		return "", "", fmt.Errorf("request file path does not match its workspace and collection")
	}
	return workspaceID, collectionID, nil
}

func requestYAMLPathHint(root, pathHint string) (string, []string, error) {
	clean := filepath.Clean(filepath.FromSlash(strings.TrimSpace(pathHint)))
	parts := strings.Split(filepath.ToSlash(clean), "/")
	if filepath.IsAbs(pathHint) || len(parts) < 6 || parts[0] != fileStoreWorkspacesDir || parts[2] != fileStoreCollectionsDir || parts[4] != fileStoreRequestsDir || filepath.Ext(parts[len(parts)-1]) != fileStoreYAMLExt {
		return "", nil, fmt.Errorf("request file path hint is invalid")
	}
	path, err := safeWorkspaceYAMLPath(root, filepath.ToSlash(clean))
	return path, parts, err
}

func findNestedRequestYAML(root, requestsDir, requestID string) (string, string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", "", err
	}
	requestsAbs, err := filepath.Abs(requestsDir)
	if err != nil {
		return "", "", err
	}
	rel, err := filepath.Rel(rootAbs, requestsAbs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("request directory escapes the workspace root")
	}
	if err := rejectSymlinkParents(rootAbs, requestsAbs); err != nil {
		return "", "", err
	}
	info, err := os.Lstat(requestsAbs)
	if err != nil {
		return "", "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", "", fmt.Errorf("request directory is not a regular directory")
	}
	requestsDir = requestsAbs
	var foundPath, foundContent string
	err = filepath.WalkDir(requestsDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() || filepath.Ext(path) != fileStoreYAMLExt {
			return nil
		}
		content, err := readRequestFile(path)
		if err != nil {
			return nil
		}
		request, _, err := parseRequestFileYAML(content)
		if err != nil || stringValue(request, "id") != requestID {
			return nil
		}
		if foundPath != "" {
			return fmt.Errorf("request id is ambiguous in this collection")
		}
		foundPath, foundContent = path, content
		return nil
	})
	if err != nil {
		return "", "", err
	}
	if foundPath == "" {
		return "", "", fmt.Errorf("request file was not found at the provided path or in its collection")
	}
	return foundPath, foundContent, nil
}

func loadRequestYAMLContext(root, requestID, pathHint string, knownContent *string) (requestYAMLContext, error) {
	if strings.TrimSpace(requestID) == "" {
		return requestYAMLContext{}, fmt.Errorf("request id is required")
	}
	requestPath, parts, err := requestYAMLPathHint(root, pathHint)
	if err != nil {
		return requestYAMLContext{}, err
	}
	hintedRequestPath := requestPath
	workspacePath, err := safeWorkspaceYAMLPath(root, filepath.ToSlash(filepath.Join(fileStoreWorkspacesDir, parts[1], fileStoreRootFileName)))
	if err != nil {
		return requestYAMLContext{}, err
	}
	collectionPath, err := safeWorkspaceYAMLPath(root, filepath.ToSlash(filepath.Join(fileStoreWorkspacesDir, parts[1], fileStoreCollectionsDir, parts[3], fileStoreCollection)))
	if err != nil {
		return requestYAMLContext{}, err
	}
	var workspaceFile filesystemWorkspaceFile
	if err := readYAMLFile(workspacePath, &workspaceFile); err != nil {
		return requestYAMLContext{}, err
	}
	var collectionFile filesystemCollectionFile
	if err := readYAMLFile(collectionPath, &collectionFile); err != nil {
		return requestYAMLContext{}, err
	}
	workspace, ok := workspaceFile.Workspace.(map[string]any)
	if !ok || workspaceFile.Version != fileStoreVersion {
		return requestYAMLContext{}, fmt.Errorf("workspace file is invalid")
	}
	collection, ok := collectionFile.Collection.(map[string]any)
	if !ok || collectionFile.Version != fileStoreVersion {
		return requestYAMLContext{}, fmt.Errorf("collection file is invalid")
	}
	if stringValue(collection, "workspaceId") != stringValue(workspace, "id") {
		return requestYAMLContext{}, fmt.Errorf("request file path does not match its workspace and collection")
	}
	collectionDir := filepath.Dir(collectionPath)
	content := ""
	directExists := false
	if knownContent != nil {
		content = *knownContent
	} else if content, err = readRequestFile(requestPath); err != nil {
		if !os.IsNotExist(err) {
			return requestYAMLContext{}, err
		}
	} else {
		directExists = true
	}
	request, structure, _, parseErr := parseRequestFileYAMLDetailed(content)
	if parseErr != nil && (knownContent != nil || directExists) {
		return requestYAMLContext{}, parseErr
	}
	if parseErr == nil && structure.version != fileStoreVersion {
		return requestYAMLContext{}, fmt.Errorf("request file version must be %d", fileStoreVersion)
	}
	if parseErr == nil && structure.order < 0 {
		return requestYAMLContext{}, fmt.Errorf("request file order cannot be negative")
	}
	if parseErr != nil || stringValue(request, "id") != requestID {
		if knownContent != nil && parseErr == nil {
			return requestYAMLContext{}, fmt.Errorf("request id cannot be changed in the file editor")
		}
		requestPath, content, err = findNestedRequestYAML(root, filepath.Join(collectionDir, fileStoreRequestsDir), requestID)
		if err != nil {
			return requestYAMLContext{}, err
		}
		request, structure, _, err = parseRequestFileYAMLDetailed(content)
		if err != nil {
			return requestYAMLContext{}, err
		}
	}
	if stringValue(request, "id") != requestID {
		return requestYAMLContext{}, fmt.Errorf("request file path does not match this request")
	}
	if collectionID := stringValue(request, "collectionId"); collectionID != "" && collectionID != stringValue(collection, "id") {
		return requestYAMLContext{}, fmt.Errorf("request file path does not match its collection")
	}
	requestSegment := filesystemNameFromPath(requestPath)
	if filesystemName := stringValue(request, filesystemNameField); filesystemName != "" && requestPath == hintedRequestPath && filesystemName != strings.TrimSuffix(parts[len(parts)-1], fileStoreYAMLExt) {
		return requestYAMLContext{}, fmt.Errorf("request file path does not match its filesystem name")
	}
	request["collectionId"] = stringValue(collection, "id")
	workspace[filesystemNameField] = parts[1]
	collection[filesystemNameField] = parts[3]
	if stringValue(request, filesystemNameField) == "" {
		request[filesystemNameField] = requestSegment
	}
	request["collection"] = stringValue(collection, "name")
	if err := validateWorkspaceFileContract("workspace", workspace); err != nil {
		return requestYAMLContext{}, err
	}
	if err := validateWorkspaceFileContract("collection", collection); err != nil {
		return requestYAMLContext{}, err
	}
	if err := validateWorkspaceFileContract("request", request); err != nil {
		return requestYAMLContext{}, err
	}
	localStore, _, err := loadLocalRequestStore(requestStorePath())
	if err != nil && !os.IsNotExist(err) {
		return requestYAMLContext{}, err
	}
	updateRequestRows(request, restoreWorkspaceRowDefaults)
	mergeRequestSecrets(request, stringMap(localStore["secrets"]))
	validator := newWorkspaceIntegrityValidator(root)
	scanned := scanRequestExampleDirs([]string{requestExampleDir(collectionDir, request[filesystemNameField].(string))})
	examples, diagnostics := readRequestExamples(collectionDir, request[filesystemNameField].(string), root, stringValue(workspace, "id"), stringValue(collection, "id"), requestID, validator, scanned)
	if err := workspaceDiagnosticsError(diagnostics); err != nil {
		return requestYAMLContext{}, err
	}
	if len(examples) > 0 {
		request["examples"] = examples
	}
	return requestYAMLContext{request: request, collection: collection, workspace: workspace, path: requestPath, content: content, structure: structure}, nil
}

func readRequestFile(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", fmt.Errorf("request file is not a regular file")
	}
	if info.Size() > maxTextFileReadSize {
		return "", fmt.Errorf("file is larger than %d MB", maxTextFileReadSize/(1024*1024))
	}
	data, err := os.ReadFile(path)
	return string(data), err
}

func requestFileYAMLRevision(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

func requestFileYAMLFailure(id, message string) RequestFileYAMLResult {
	return RequestFileYAMLResult{ID: id, Error: message}
}

func requestFileYAMLResultFailure(root, id, path, content, message string, line int) RequestFileYAMLResult {
	return RequestFileYAMLResult{ID: id, Path: workspaceDiagnosticPath(root, path), Content: content, Revision: requestFileYAMLRevision(content), Error: message, Line: line}
}

func requestFileYAMLConflict(root, id, path, content string) RequestFileYAMLResult {
	return RequestFileYAMLResult{ID: id, Path: workspaceDiagnosticPath(root, path), Content: content, Revision: requestFileYAMLRevision(content), Error: "request file changed outside the editor; reload it before saving", Conflict: true}
}

func parseRequestFileYAML(content string) (map[string]any, int, error) {
	request, structure, line, err := parseRequestFileYAMLDetailed(content)
	if err == nil && structure.version != fileStoreVersion {
		return nil, 1, fmt.Errorf("request file version must be %d", fileStoreVersion)
	}
	if err == nil && structure.order < 0 {
		return nil, 1, fmt.Errorf("request file order cannot be negative")
	}
	return request, line, err
}

func parseRequestFileYAMLDetailed(content string) (map[string]any, requestFileYAMLStructure, int, error) {
	decoder := yaml.NewDecoder(bytes.NewReader([]byte(content)))
	var document yaml.Node
	if err := decoder.Decode(&document); err != nil {
		check := yamlErrorFailure(err)
		return nil, requestFileYAMLStructure{}, check.Line, fmt.Errorf("%s", check.Message)
	}
	if len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return nil, requestFileYAMLStructure{}, 1, fmt.Errorf("request file must contain one YAML mapping")
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); err == nil {
		if len(extra.Content) > 0 {
			return nil, requestFileYAMLStructure{}, 1, fmt.Errorf("request file must contain one YAML document")
		}
	} else if err != io.EOF {
		check := yamlErrorFailure(err)
		return nil, requestFileYAMLStructure{}, check.Line, fmt.Errorf("%s", check.Message)
	}
	if yamlHasAliasOrAnchor(&document) {
		return nil, requestFileYAMLStructure{}, 1, fmt.Errorf("YAML aliases and anchors are not supported in request files")
	}
	top := document.Content[0]
	var file filesystemRequestFile
	if err := top.Decode(&file); err != nil {
		check := yamlErrorFailure(err)
		return nil, requestFileYAMLStructure{}, check.Line, fmt.Errorf("%s", check.Message)
	}
	for index := 0; index+1 < len(top.Content); index += 2 {
		key := top.Content[index]
		if key.Value != "version" && key.Value != "order" && key.Value != "request" {
			return nil, requestFileYAMLStructure{}, key.Line, fmt.Errorf("unknown request file field %q", key.Value)
		}
	}
	requestNode := yamlMappingValue(top, "request")
	if requestNode == nil || requestNode.Kind != yaml.MappingNode {
		return nil, requestFileYAMLStructure{}, 1, fmt.Errorf("request file needs a request mapping")
	}
	var request map[string]any
	if err := requestNode.Decode(&request); err != nil {
		check := yamlErrorFailure(err)
		return nil, requestFileYAMLStructure{}, check.Line, fmt.Errorf("%s", check.Message)
	}
	structure := requestFileYAMLStructure{
		version:           file.Version,
		versionLine:       yamlMappingKeyLine(top, "version"),
		order:             file.Order,
		rootLine:          top.Line,
		requestLine:       yamlMappingKeyLine(top, "request"),
		request:           protectedRequestFields(request),
		requestFieldLines: requestYAMLFieldLines(requestNode),
	}
	if orderNode := yamlMappingValue(top, "order"); orderNode != nil {
		structure.orderPresent = true
		structure.orderLine = yamlMappingKeyLine(top, "order")
		if err := orderNode.Decode(&structure.orderValue); err != nil {
			check := yamlErrorFailure(err)
			return nil, requestFileYAMLStructure{}, check.Line, fmt.Errorf("%s", check.Message)
		}
	}
	return request, structure, 0, nil
}

func protectedRequestFields(request map[string]any) map[string]any {
	protected := make(map[string]any, 4)
	for _, field := range []string{"id", "collectionId", filesystemNameField} {
		if value, exists := request[field]; exists {
			protected[field] = value
		}
	}
	return protected
}

func requestYAMLFieldLines(node *yaml.Node) map[string]int {
	fields := map[string]bool{
		"id": true, "collectionId": true, filesystemNameField: true, "requestType": true,
		"examples": true, "collection": true, "isDraft": true, "isInvalid": true,
		"workspaceDiagnostics": true, exampleCountField: true, "url": true, "bodyType": true,
	}
	lines := make(map[string]int, len(fields))
	for index := 0; index+1 < len(node.Content); index += 2 {
		key := node.Content[index]
		if fields[key.Value] {
			lines[key.Value] = key.Line
		}
	}
	return lines
}

func yamlMappingKeyLine(node *yaml.Node, name string) int {
	for index := 0; index+1 < len(node.Content); index += 2 {
		if node.Content[index].Value == name {
			return node.Content[index].Line
		}
	}
	return 0
}

func yamlHasAliasOrAnchor(node *yaml.Node) bool {
	if node.Kind == yaml.AliasNode || node.Anchor != "" {
		return true
	}
	for _, child := range node.Content {
		if yamlHasAliasOrAnchor(child) {
			return true
		}
	}
	return false
}

func validateRequestFileEdit(current, edited map[string]any, currentStructure, editedStructure requestFileYAMLStructure) (int, error) {
	if currentStructure.version != editedStructure.version {
		line := editedStructure.versionLine
		if line == 0 {
			line = editedStructure.rootLine
		}
		return line, fmt.Errorf("request file version cannot be changed in the file editor")
	}
	if currentStructure.orderPresent != editedStructure.orderPresent || currentStructure.order != editedStructure.order || !reflect.DeepEqual(currentStructure.orderValue, editedStructure.orderValue) {
		line := editedStructure.orderLine
		if line == 0 {
			line = editedStructure.rootLine
		}
		return line, fmt.Errorf("request order is managed by the collection")
	}
	for _, field := range []string{"id", "collectionId", filesystemNameField} {
		before, beforeExists := currentStructure.request[field]
		after, afterExists := editedStructure.request[field]
		if beforeExists != afterExists || !reflect.DeepEqual(before, after) {
			line := editedStructure.requestFieldLines[field]
			if line == 0 {
				line = editedStructure.requestLine
			}
			return line, fmt.Errorf("request field %q is managed by the file editor", field)
		}
	}
	if stringValue(edited, "id") == "" {
		line := editedStructure.requestFieldLines["id"]
		if line == 0 {
			line = editedStructure.requestLine
		}
		return line, fmt.Errorf("request field %q is managed by the file editor", "id")
	}
	for _, field := range []string{"examples", "collection"} {
		if _, exists := edited[field]; exists {
			return editedStructure.requestFieldLines[field], fmt.Errorf("request %s are stored separately and cannot be edited here", field)
		}
	}
	if boolValue(edited["isDraft"]) {
		return editedStructure.requestFieldLines["isDraft"], fmt.Errorf("draft requests cannot be saved from the file editor")
	}
	for _, field := range []string{"isInvalid", "workspaceDiagnostics", exampleCountField} {
		if _, exists := edited[field]; exists {
			return editedStructure.requestFieldLines[field], fmt.Errorf("request field %q is managed by the editor", field)
		}
	}
	return 0, nil
}

func workspaceYAMLMemoForRawRequest(path string, value any, content []byte) {
	key, keyed := workspaceYAMLMemoKey(value)
	if !keyed {
		return
	}
	workspaceYAMLMemo.Lock()
	defer workspaceYAMLMemo.Unlock()
	if len(workspaceYAMLMemo.entries) >= workspaceYAMLMemoLimit {
		workspaceYAMLMemo.entries = map[string]workspaceYAMLMemoEntry{}
	}
	workspaceYAMLMemo.entries[path] = workspaceYAMLMemoEntry{key: key, yaml: sha256.Sum256(content)}
}
