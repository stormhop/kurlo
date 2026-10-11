package api

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

const workspaceIntegrityScope = "store"

type workspaceIntegrityValidator struct {
	root          string
	paths         map[string]string
	kept          map[string]bool
	duplicateDirs []string
	diagnostics   []WorkspaceDiagnostic
	fixes         []workspaceReferenceFix
}

type workspaceReferenceFix struct {
	path string
	keys []string
	from string
	to   string
}

func newWorkspaceIntegrityValidator(root string) *workspaceIntegrityValidator {
	return &workspaceIntegrityValidator{root: root, paths: map[string]string{}, kept: map[string]bool{}}
}

func (v *workspaceIntegrityValidator) report(path, message string) {
	v.diagnostics = append(v.diagnostics, workspaceDiagnostic{
		scope: workspaceIntegrityScope, root: v.root, path: path, message: message, blocking: true,
	}.toDiagnostic())
}

func (v *workspaceIntegrityValidator) item(kind, path string, item map[string]any) {
	if v == nil {
		return
	}
	raw, present := item["id"]
	id, valid := raw.(string)
	if present && raw != nil && !valid {
		v.report(path, fmt.Sprintf("The %s id must be text. Put it in quotes, for example id: \"%v\".", kind, raw))
		return
	}
	if strings.TrimSpace(id) == "" {
		v.report(path, "The "+kind+" has no id. Restore its id before saving.")
		return
	}
	key := kind + ":" + id
	previous, exists := v.paths[key]
	if !exists {
		v.paths[key] = path
		return
	}
	if v.insideDuplicate(path) {
		return
	}
	other := workspaceDiagnosticPath(v.root, previous)
	if kind == "workspace" || kind == "collection" {
		v.duplicateDirs = append(v.duplicateDirs, filepath.Dir(path))
		v.report(path, fmt.Sprintf("This %s has the same id %q as %s, so the folder looks like a copy. Give the copy and everything inside it new ids, or remove it.", kind, id, other))
		return
	}
	v.report(path, fmt.Sprintf("This %s has the same id %q as %s. Change the id in one of the two files to a new unique value.", kind, id, other))
}

func (v *workspaceIntegrityValidator) insideDuplicate(path string) bool {
	for _, dir := range v.duplicateDirs {
		if strings.HasPrefix(path, dir+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func workspaceIntegrityError(diagnostics []WorkspaceDiagnostic) error {
	var blocking []WorkspaceDiagnostic
	for _, diagnostic := range diagnostics {
		if diagnostic.Scope == workspaceIntegrityScope {
			blocking = append(blocking, diagnostic)
		}
	}
	return workspaceDiagnosticsError(blocking)
}

func validateWorkspaceStorePayload(store map[string]any) error {
	v := newWorkspaceIntegrityValidator("")
	workspaceIDs := entityIDSet(mapSlice(store["workspaces"]))
	collectionIDs := entityIDSet(mapSlice(store["collections"]))
	for _, kind := range []string{"workspace", "collection", "request", "environment"} {
		for _, item := range mapSlice(store[kind+"s"]) {
			path := kind + ":" + stringValue(item, "id")
			v.item(kind, path, item)
			field := ""
			var parents map[string]bool
			switch kind {
			case "collection", "environment":
				field, parents = "workspaceId", workspaceIDs
			case "request":
				field, parents = "collectionId", collectionIDs
			}
			if field != "" && !parents[stringValue(item, field)] {
				v.report(path, fmt.Sprintf("%s references missing %s %q. Restore the reference before saving.", kind, field, stringValue(item, field)))
			}
			if kind == "request" {
				for _, example := range mapSlice(item["examples"]) {
					v.item("example", filepath.Join(path, "examples", stringValue(example, "id")), example)
				}
			}
		}
	}
	return workspaceIntegrityError(v.diagnostics)
}

func validateWorkspaceStoreOnDisk(root string) error {
	_, err := inspectWorkspaceStoreOnDisk(root)
	return err
}

func inspectWorkspaceStoreOnDisk(root string) (map[string]string, error) {
	if rootIndexMissingWithChildren(root) {
		return nil, fmt.Errorf("kurlo.yml is missing but workspace files remain. Restore kurlo.yml before saving.")
	}
	if !hasYAMLWorkspaceStore(root) {
		return nil, nil
	}
	workspaces, collections, requests, environments, _, diagnostics, err := loadFilesystemWorkspaceStoreWithDiagnostics(root, nil)
	if err != nil {
		return nil, err
	}
	if err := workspaceIntegrityError(diagnostics); err != nil {
		return nil, err
	}
	return diskItemSegments(workspaces, collections, requests, environments), nil
}

func rootIndexMissingWithChildren(root string) bool {
	if hasYAMLWorkspaceStore(root) || !workspaceChildrenRemain(root, fileStoreWorkspacesDir) {
		return false
	}
	stillMissing := !hasYAMLWorkspaceStore(root)
	return stillMissing
}

func workspaceChildrenRemain(root string, dirs ...string) bool {
	for _, dir := range dirs {
		found := false
		_ = filepath.WalkDir(filepath.Join(root, dir), func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				if !os.IsNotExist(err) {
					found = true
				}
				return nil
			}
			if !entry.IsDir() && filepath.Ext(path) == fileStoreYAMLExt {
				found = true
				return fs.SkipAll
			}
			return nil
		})
		if found {
			return true
		}
	}
	return false
}

func (v *workspaceIntegrityValidator) orphanExamples(collectionDir string, requests []requestFileEntry) {
	if v == nil {
		return
	}
	segments := map[string]bool{}
	for _, request := range requests {
		segments[stringValue(request.request, filesystemNameField)] = true
	}
	root := filepath.Join(collectionDir, fileStoreExamplesDir)
	entries, err := readDirNoSymlink(root)
	if err != nil {
		if !os.IsNotExist(err) {
			v.report(root, err.Error())
		}
		return
	}
	for _, entry := range entries {
		path := filepath.Join(root, entry.Name())
		if entry.IsDir() && !segments[entry.Name()] && workspaceChildrenRemain(path, ".") {
			v.report(path, "Example files have no matching request file. Restore the request or remove its examples before saving.")
		}
	}
}

func (v *workspaceIntegrityValidator) usableItems(kind string, items []map[string]any) []map[string]any {
	usable := make([]map[string]any, 0, len(items))
	for _, item := range items {
		id, valid := item["id"].(string)
		if !valid || strings.TrimSpace(id) == "" {
			continue
		}
		key := kind + ":" + id
		if v.kept[key] {
			continue
		}
		v.kept[key] = true
		usable = append(usable, item)
	}
	return usable
}

func (v *workspaceIntegrityValidator) reference(path, section string, item map[string]any, field, parentID string) {
	current, exists := item[field]
	item[field] = parentID
	if v == nil || !exists || current == parentID || parentID == "" {
		return
	}
	text, _ := current.(string)
	v.fixes = append(v.fixes, workspaceReferenceFix{path: path, keys: []string{section, field}, from: text, to: parentID})
}

func (v *workspaceIntegrityValidator) order(path, key string, order []string, items []map[string]any) {
	if v == nil {
		return
	}
	ids := entityIDSet(items)
	listed := map[string]bool{}
	var unknown []string
	for _, id := range order {
		listed[id] = true
		if !ids[id] {
			unknown = append(unknown, id)
		}
	}
	var missing []string
	for _, item := range items {
		if id := stringValue(item, "id"); id != "" && !listed[id] {
			missing = append(missing, id)
		}
	}
	if len(unknown) == 1 && len(missing) == 1 {
		v.fixes = append(v.fixes, workspaceReferenceFix{path: path, keys: []string{key}, from: unknown[0], to: missing[0]})
	}
}

func applyWorkspaceReferenceFixes(fixes []workspaceReferenceFix) error {
	byPath := map[string][]workspaceReferenceFix{}
	var paths []string
	for _, fix := range fixes {
		if _, seen := byPath[fix.path]; !seen {
			paths = append(paths, fix.path)
		}
		byPath[fix.path] = append(byPath[fix.path], fix)
	}
	for _, path := range paths {
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var document yaml.Node
		if err := yaml.Unmarshal(data, &document); err != nil || len(document.Content) == 0 {
			continue
		}
		changed := false
		for _, fix := range byPath[path] {
			node := document.Content[0]
			for _, key := range fix.keys {
				node = yamlMappingValue(node, key)
			}
			switch {
			case node == nil:
			case node.Kind == yaml.ScalarNode:
				node.Value, node.Tag, node.Style = fix.to, "!!str", 0
				changed = true
			case node.Kind == yaml.SequenceNode:
				for _, entry := range node.Content {
					if entry.Kind == yaml.ScalarNode && entry.Value == fix.from {
						entry.Value, entry.Tag, entry.Style = fix.to, "!!str", 0
						changed = true
					}
				}
			}
		}
		if changed {
			if err := writeYAMLFile(path, &document); err != nil {
				return err
			}
		}
	}
	return nil
}

func yamlMappingValue(node *yaml.Node, key string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for index := 0; index+1 < len(node.Content); index += 2 {
		if node.Content[index].Value == key {
			return node.Content[index+1]
		}
	}
	return nil
}
