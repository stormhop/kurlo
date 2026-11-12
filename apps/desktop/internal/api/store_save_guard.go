package api

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

type storeLoadFailures struct {
	mu    sync.Mutex
	roots map[string]bool
}

var failedStoreLoads = &storeLoadFailures{}

func (f *storeLoadFailures) note(root string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := workspaceLockKey(root)
	if err != nil {
		if f.roots == nil {
			f.roots = map[string]bool{}
		}
		f.roots[key] = true
		return
	}
	delete(f.roots, key)
}

func (f *storeLoadFailures) failed(root string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.roots[workspaceLockKey(root)]
}

func diskWorkspaces(root string) map[string]string {
	entries, err := os.ReadDir(filepath.Join(root, fileStoreWorkspacesDir))
	if err != nil {
		return nil
	}
	found := map[string]string{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, fileStoreWorkspacesDir, entry.Name())
		var file filesystemWorkspaceFile
		if err := readYAMLFile(filepath.Join(dir, fileStoreRootFileName), &file); err != nil {
			continue
		}
		workspace, _ := file.Workspace.(map[string]any)
		if id := stringValue(workspace, "id"); id != "" {
			found[id] = dir
		}
	}
	return found
}

var errWorkspaceHoldsItems = errors.New("workspace holds items")

func workspaceDirHoldsItems(dir string) bool {
	err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || filepath.Ext(path) != fileStoreYAMLExt {
			return nil
		}
		switch filepath.Base(path) {
		case fileStoreRootFileName, fileStoreCollection:
			return nil
		}
		return errWorkspaceHoldsItems
	})
	return errors.Is(err, errWorkspaceHoldsItems)
}

func guardWorkspacesKept(root string, store map[string]any) error {
	onDisk := diskWorkspaces(root)
	if len(onDisk) == 0 {
		return nil
	}
	kept := entityIDSet(mapSlice(store["workspaces"]))
	for id := range onDisk {
		if kept[id] {
			return nil
		}
	}
	for _, dir := range onDisk {
		if workspaceDirHoldsItems(dir) {
			return fmt.Errorf("this save would remove every workspace in %s, so Kurlo did not write anything. Reload the workspace and try again", root)
		}
	}
	return nil
}

func missingParentWithChildren(dir, file string, children ...string) bool {
	if _, err := os.Stat(filepath.Join(dir, file)); !errors.Is(err, os.ErrNotExist) {
		return false
	}
	return workspaceChildrenRemain(dir, children...)
}

func refuseRecreatingMissingParents(root string, workspaces, collections []map[string]any) error {
	workspaceSegments := map[string]string{}
	for _, workspace := range workspaces {
		segment := stringValue(workspace, filesystemNameField)
		if segment == "" {
			continue
		}
		workspaceSegments[stringValue(workspace, "id")] = segment
		workspaceDir := filepath.Join(root, fileStoreWorkspacesDir, segment)
		if missingParentWithChildren(workspaceDir, fileStoreRootFileName, fileStoreCollectionsDir, fileStoreEnvironmentsDir) {
			return missingParentError(root, filepath.Join(workspaceDir, fileStoreRootFileName))
		}
	}
	for _, collection := range collections {
		workspaceSegment := workspaceSegments[stringValue(collection, "workspaceId")]
		segment := stringValue(collection, filesystemNameField)
		if workspaceSegment == "" || segment == "" {
			continue
		}
		collectionDir := filepath.Join(root, fileStoreWorkspacesDir, workspaceSegment, fileStoreCollectionsDir, segment)
		if missingParentWithChildren(collectionDir, fileStoreCollection, fileStoreRequestsDir, fileStoreExamplesDir, fileStoreLoadTestsDir) {
			return missingParentError(root, filepath.Join(collectionDir, fileStoreCollection))
		}
	}
	return nil
}

func missingParentError(root, path string) error {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		rel = path
	}
	return fmt.Errorf("%s is missing but its child files remain, so Kurlo did not save. Restore the file or remove that folder", filepath.ToSlash(rel))
}
