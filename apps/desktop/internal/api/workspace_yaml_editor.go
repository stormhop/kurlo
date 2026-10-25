package api

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type WorkspaceYAMLFileResult struct {
	Ok      bool   `json:"ok"`
	Path    string `json:"path"`
	Content string `json:"content"`
	Error   string `json:"error"`
}

func (a *App) ReadWorkspaceYAMLFile(path string) WorkspaceYAMLFileResult {
	gitOperationMu.RLock()
	defer gitOperationMu.RUnlock()
	root := fileWorkspaceStorePath()
	fullPath, err := safeWorkspaceYAMLPath(root, path)
	if err != nil {
		return WorkspaceYAMLFileResult{Path: path, Error: err.Error()}
	}
	info, err := os.Lstat(fullPath)
	if err != nil {
		return WorkspaceYAMLFileResult{Path: path, Error: err.Error()}
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return WorkspaceYAMLFileResult{Path: path, Error: fmt.Sprintf("refusing to read symlink: %s", path)}
	}
	if !info.Mode().IsRegular() {
		return WorkspaceYAMLFileResult{Path: path, Error: fmt.Sprintf("not a YAML file: %s", path)}
	}
	if info.Size() > maxTextFileReadSize {
		return WorkspaceYAMLFileResult{Path: path, Error: fmt.Sprintf("file is larger than %d MB", maxTextFileReadSize/(1024*1024))}
	}
	data, err := os.ReadFile(fullPath)
	if err != nil {
		return WorkspaceYAMLFileResult{Path: path, Error: err.Error()}
	}
	return WorkspaceYAMLFileResult{Ok: true, Path: workspaceDiagnosticPath(root, fullPath), Content: string(data)}
}

func (a *App) WriteWorkspaceYAMLFile(path string, content string) WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	fullPath, err := safeWorkspaceYAMLPath(root, path)
	if err != nil {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: workspaceOpenStatus(root)}
	}
	info, err := os.Lstat(fullPath)
	if err != nil {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: workspaceOpenStatus(root)}
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: fmt.Sprintf("refusing to write symlink: %s", path), Git: workspaceOpenStatus(root)}
	}
	if !info.Mode().IsRegular() {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: fmt.Sprintf("not a YAML file: %s", path), Git: workspaceOpenStatus(root)}
	}
	if len(content) > maxTextFileReadSize {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: fmt.Sprintf("file is larger than %d MB", maxTextFileReadSize/(1024*1024)), Git: workspaceOpenStatus(root)}
	}
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: workspaceOpenStatus(root)}
	}
	defer unlock()
	if err := writeTextFileAtomic(fullPath, []byte(content)); err != nil {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: workspaceOpenStatus(root)}
	}
	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(requestStorePath(), root)
	if err != nil {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: workspaceOpenStatus(root), Diagnostics: diagnostics}
	}
	secrets := map[string]string{}
	if localStore, _, err := loadLocalRequestStore(requestStorePath()); err == nil {
		secrets = stringMap(localStore["secrets"])
	}
	return WorkspaceOpenResult{
		Ok:             true,
		Root:           root,
		Payload:        payload,
		Git:            workspaceOpenStatus(root),
		MissingSecrets: missingWorkspaceSecrets(root, secrets),
		Diagnostics:    diagnostics,
	}
}

func safeWorkspaceYAMLPath(root string, path string) (string, error) {
	value := strings.TrimSpace(path)
	if value == "" {
		return "", fmt.Errorf("YAML path is required")
	}
	if filepath.IsAbs(value) {
		return "", fmt.Errorf("YAML path must be relative to the workspace root")
	}
	cleanRel := filepath.Clean(filepath.FromSlash(value))
	if cleanRel == "." || cleanRel == ".." || strings.HasPrefix(cleanRel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("YAML path escapes the workspace root")
	}
	ext := strings.ToLower(filepath.Ext(cleanRel))
	if ext != ".yml" && ext != ".yaml" {
		return "", fmt.Errorf("only YAML files can be edited")
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	fullPath, err := filepath.Abs(filepath.Join(rootAbs, cleanRel))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(rootAbs, fullPath)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("YAML path escapes the workspace root")
	}
	if err := rejectSymlinkParents(rootAbs, fullPath); err != nil {
		return "", err
	}
	return fullPath, nil
}

func rejectSymlinkParents(root string, path string) error {
	rel, err := filepath.Rel(root, filepath.Dir(path))
	if err != nil || rel == "." {
		return err
	}
	current := root
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if part == "" || part == "." {
			continue
		}
		current = filepath.Join(current, filepath.FromSlash(part))
		info, err := os.Lstat(current)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing to traverse symlink directory: %s", current)
		}
	}
	return nil
}

func writeTextFileAtomic(path string, data []byte) error {
	return writeFileAtomicMode(path, data, 0644)
}

func writeFileAtomicMode(path string, data []byte, mode os.FileMode) error {
	if existing, err := os.ReadFile(path); err == nil && string(existing) == string(data) {
		return nil
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
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
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
	return syncDir(filepath.Dir(path))
}

func workspaceOpenStatus(root string) GitWorkspaceStatus {
	if inferWorkspaceStorageMode(root) == workspaceStorageModeLocal {
		return localWorkspaceGitStatus(root)
	}
	return gitStatusForWorkspace(root)
}
