package api

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	openAPISpecDir  = "openapi"
	openAPISpecFile = "spec.json"
)

type OpenAPISpecFileResult struct {
	Content string `json:"content"`
	Exists  bool   `json:"exists"`
	Path    string `json:"path"`
	Error   string `json:"error,omitempty"`
}

func openAPIBaseSpecPath(collectionDir string) string {
	return filepath.Join(collectionDir, openAPISpecDir, openAPISpecFile)
}

func isOpenAPIBaseSpecPath(path string) bool {
	return filepath.Base(path) == openAPISpecFile && filepath.Base(filepath.Dir(path)) == openAPISpecDir
}

func collectionIDInDir(dir string) string {
	var doc filesystemCollectionFile
	if err := readYAMLFile(filepath.Join(dir, fileStoreCollection), &doc); err != nil {
		return ""
	}
	collection, ok := doc.Collection.(map[string]any)
	if !ok {
		return ""
	}
	return stringValue(collection, "id")
}

func collectionDirsInWorkspace(workspaceDir string) map[string][]string {
	dirs := map[string][]string{}
	collectionsDir := filepath.Join(workspaceDir, fileStoreCollectionsDir)
	entries, err := readDirNoSymlink(collectionsDir)
	if err != nil {
		return dirs
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		dir := filepath.Join(collectionsDir, entry.Name())
		if id := collectionIDInDir(dir); id != "" {
			dirs[id] = append(dirs[id], dir)
		}
	}
	return dirs
}

func collectionDirByID(root, collectionID string) (string, error) {
	if strings.TrimSpace(collectionID) == "" {
		return "", errors.New("collection id is required")
	}
	managedRoot := filepath.Join(root, fileStoreWorkspacesDir)
	entries, err := readDirNoSymlink(managedRoot)
	if err != nil {
		return "", errors.New("the workspace is not saved to a folder yet")
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		if dirs := collectionDirsInWorkspace(filepath.Join(managedRoot, entry.Name()))[collectionID]; len(dirs) > 0 {
			return dirs[0], nil
		}
	}
	return "", errors.New("the collection is not saved to a folder yet")
}

func carryCollectionOpenAPISpec(workspaceDir, collectionID, collectionDir string, journal *saveJournal) error {
	target := openAPIBaseSpecPath(collectionDir)
	if _, err := os.Lstat(target); err == nil {
		return nil
	}
	for _, dir := range collectionDirsInWorkspace(workspaceDir)[collectionID] {
		if filepath.Clean(dir) == filepath.Clean(collectionDir) {
			continue
		}
		from := openAPIBaseSpecPath(dir)
		info, err := os.Lstat(from)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		if err := journal.record(from); err != nil {
			return err
		}
		if err := journal.record(target); err != nil {
			return err
		}
		return os.Rename(from, target)
	}
	return nil
}

func readOpenAPIBaseSpec(root, collectionID string) OpenAPISpecFileResult {
	dir, err := collectionDirByID(root, collectionID)
	if err != nil {
		return OpenAPISpecFileResult{Error: err.Error()}
	}
	path := openAPIBaseSpecPath(dir)
	rel, _ := filepath.Rel(root, path)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return OpenAPISpecFileResult{Path: filepath.ToSlash(rel)}
	}
	if err != nil {
		return OpenAPISpecFileResult{Path: filepath.ToSlash(rel), Error: err.Error()}
	}
	if !info.Mode().IsRegular() {
		return OpenAPISpecFileResult{Path: filepath.ToSlash(rel), Error: fmt.Sprintf("%s is not a regular file", filepath.ToSlash(rel))}
	}
	if info.Size() > maxTextFileReadSize {
		return OpenAPISpecFileResult{Path: filepath.ToSlash(rel), Error: fmt.Sprintf("%s is larger than %d MB", filepath.ToSlash(rel), maxTextFileReadSize/(1024*1024))}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return OpenAPISpecFileResult{Path: filepath.ToSlash(rel), Error: err.Error()}
	}
	return OpenAPISpecFileResult{Content: string(data), Exists: true, Path: filepath.ToSlash(rel)}
}

func writeOpenAPIBaseSpec(root, collectionID, content string) error {
	if len(content) > maxTextFileReadSize {
		return fmt.Errorf("the spec is larger than %d MB", maxTextFileReadSize/(1024*1024))
	}
	dir, err := collectionDirByID(root, collectionID)
	if err != nil {
		return err
	}
	path := openAPIBaseSpecPath(dir)
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return fmt.Errorf("refusing to replace %s: it is not a regular file", path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	return writeTextFileAtomic(path, []byte(content))
}

func deleteOpenAPIBaseSpec(root, collectionID string) error {
	dir, err := collectionDirByID(root, collectionID)
	if err != nil {
		return nil
	}
	path := openAPIBaseSpecPath(dir)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = os.Remove(filepath.Dir(path))
	return nil
}

func resolveOpenAPISourcePath(root, source string) (string, error) {
	value := strings.TrimSpace(source)
	value = strings.TrimPrefix(value, "file://")
	if value == "" {
		return "", errors.New("the spec path is empty")
	}
	if strings.HasPrefix(value, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			value = filepath.Join(home, value[2:])
		}
	}
	if !filepath.IsAbs(value) {
		value = filepath.Join(root, filepath.FromSlash(value))
	}
	return filepath.Clean(value), nil
}

func readOpenAPISourceFile(root, source string) OpenAPISpecFileResult {
	path, err := resolveOpenAPISourcePath(root, source)
	if err != nil {
		return OpenAPISpecFileResult{Error: err.Error()}
	}
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return OpenAPISpecFileResult{Path: path, Error: fmt.Sprintf("%s does not exist", source)}
		}
		return OpenAPISpecFileResult{Path: path, Error: err.Error()}
	}
	if info.IsDir() {
		return OpenAPISpecFileResult{Path: path, Error: fmt.Sprintf("%s is a folder, not a spec file", source)}
	}
	if info.Size() > maxTextFileReadSize {
		return OpenAPISpecFileResult{Path: path, Error: fmt.Sprintf("%s is larger than %d MB", source, maxTextFileReadSize/(1024*1024))}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return OpenAPISpecFileResult{Path: path, Error: err.Error()}
	}
	return OpenAPISpecFileResult{Content: string(data), Exists: true, Path: path}
}

func (a *App) ReadOpenAPIBaseSpec(collectionID string) OpenAPISpecFileResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	return readOpenAPIBaseSpec(fileWorkspaceStorePath(), collectionID)
}

func (a *App) WriteOpenAPIBaseSpec(collectionID, content string) string {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		return err.Error()
	}
	defer unlock()
	if err := writeOpenAPIBaseSpec(root, collectionID, content); err != nil {
		return err.Error()
	}
	workspaceDisk.remember(root)
	return ""
}

func (a *App) DeleteOpenAPIBaseSpec(collectionID string) string {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		return err.Error()
	}
	defer unlock()
	if err := deleteOpenAPIBaseSpec(root, collectionID); err != nil {
		return err.Error()
	}
	workspaceDisk.remember(root)
	return ""
}

func (a *App) ReadOpenAPISourceFile(source string) OpenAPISpecFileResult {
	return readOpenAPISourceFile(fileWorkspaceStorePath(), source)
}
