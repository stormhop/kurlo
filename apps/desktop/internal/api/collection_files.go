package api

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	maxCollectionTextFiles = 20000
	maxCollectionTextBytes = 100 * 1024 * 1024
)

type CollectionTextFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type CollectionTextFilesResult struct {
	Root  string               `json:"root"`
	Name  string               `json:"name"`
	Files []CollectionTextFile `json:"files"`
	Error string               `json:"error"`
}

func (a *App) ReadCollectionTextFiles(root string) CollectionTextFilesResult {
	normalizedRoot, err := normalizeExistingDir(root)
	if err != nil {
		return CollectionTextFilesResult{Root: root, Error: err.Error(), Files: []CollectionTextFile{}}
	}
	files, err := readCollectionTextFilesForRoot(normalizedRoot)
	if err != nil {
		return CollectionTextFilesResult{Root: normalizedRoot, Name: filepath.Base(normalizedRoot), Error: err.Error(), Files: []CollectionTextFile{}}
	}
	return CollectionTextFilesResult{Root: normalizedRoot, Name: filepath.Base(normalizedRoot), Files: files}
}

func (a *App) WriteCollectionTextFiles(root string, files []CollectionTextFile) string {
	if err := writeCollectionTextFilesForRoot(root, files); err != nil {
		return err.Error()
	}
	return ""
}

func readCollectionTextFilesForRoot(root string) ([]CollectionTextFile, error) {
	info, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("refusing to read symlink directory: %s", root)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("collection path is not a directory: %s", root)
	}
	files := []CollectionTextFile{}
	totalBytes := int64(0)
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		name := entry.Name()
		if entry.IsDir() {
			if name == ".git" || name == "node_modules" || name == ".kurlo-local" {
				return filepath.SkipDir
			}
			return nil
		}
		if !collectionTextFileLooksImportable(path) {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		totalBytes += info.Size()
		if totalBytes > maxCollectionTextBytes {
			return fmt.Errorf("collection text files exceed %d MB", maxCollectionTextBytes/(1024*1024))
		}
		if len(files) >= maxCollectionTextFiles {
			return fmt.Errorf("collection contains more than %d importable text files", maxCollectionTextFiles)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files = append(files, CollectionTextFile{Path: filepath.ToSlash(rel), Content: string(data)})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

func writeCollectionTextFilesForRoot(root string, files []CollectionTextFile) error {
	if strings.TrimSpace(root) == "" {
		return fmt.Errorf("collection export folder is required")
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	if info, err := os.Lstat(rootAbs); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing to write into symlink directory: %s", rootAbs)
		}
		if !info.IsDir() {
			return fmt.Errorf("export path is not a directory: %s", rootAbs)
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(rootAbs, 0755); err != nil {
			return err
		}
	} else {
		return err
	}
	if len(files) > maxCollectionTextFiles {
		return fmt.Errorf("cannot export more than %d text files", maxCollectionTextFiles)
	}
	totalBytes := 0
	for _, file := range files {
		totalBytes += len(file.Content)
		if totalBytes > maxCollectionTextBytes {
			return fmt.Errorf("collection export exceeds %d MB", maxCollectionTextBytes/(1024*1024))
		}
		relPath, err := cleanCollectionTextRelativePath(file.Path)
		if err != nil {
			return err
		}
		if !collectionTextFileLooksImportable(relPath) {
			return fmt.Errorf("unsupported collection export file: %s", relPath)
		}
		target := filepath.Join(rootAbs, filepath.FromSlash(relPath))
		parent := filepath.Dir(target)
		if err := rejectSymlinkParents(rootAbs, target); err != nil {
			return err
		}
		if err := os.MkdirAll(parent, 0755); err != nil {
			return err
		}
		if err := rejectSymlinkParents(rootAbs, target); err != nil {
			return err
		}
		if info, err := os.Lstat(target); err == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("refusing to overwrite symlink: %s", relPath)
			}
			if !info.Mode().IsRegular() {
				return fmt.Errorf("refusing to overwrite non-file path: %s", relPath)
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := writeTextFileAtomic(target, []byte(file.Content)); err != nil {
			return err
		}
	}
	return nil
}

func collectionTextFileLooksImportable(path string) bool {
	name := strings.ToLower(filepath.Base(path))
	ext := strings.ToLower(filepath.Ext(path))
	return ext == ".yml" || ext == ".yaml" || ext == ".bru" || name == "bruno.json"
}

func cleanCollectionTextRelativePath(path string) (string, error) {
	path = strings.TrimSpace(filepath.ToSlash(path))
	if path == "" || filepath.IsAbs(path) || path == "." || path == ".." || strings.HasPrefix(path, "../") || strings.HasPrefix(path, "./") {
		return "", fmt.Errorf("invalid collection file path")
	}
	if strings.Contains(path, "\x00") || strings.Contains(path, "\\") || strings.Contains(path, "//") || strings.Contains(path, "/../") || strings.Contains(path, "/./") || strings.HasSuffix(path, "/..") || strings.HasSuffix(path, "/.") {
		return "", fmt.Errorf("invalid collection file path")
	}
	return path, nil
}
