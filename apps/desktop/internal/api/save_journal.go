package api

import (
	"bufio"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

const saveJournalName = ".kurlo-save-journal.tmp"

var yamlStoreWriteMu sync.Mutex

type saveJournal struct {
	root string
	file *os.File
	dirs map[string]bool
}

func (j *saveJournal) flush(f *os.File) error {
	if j == nil {
		return f.Sync()
	}
	return flushFile(f)
}

func (j *saveJournal) syncDir(dir string) error {
	if j == nil {
		return syncDir(dir)
	}
	if j.dirs == nil {
		j.dirs = map[string]bool{}
	}
	j.dirs[dir] = true
	return nil
}

func saveJournalPath(root string) string {
	return filepath.Join(root, saveJournalName)
}

func (j *saveJournal) record(path string) error {
	if j == nil {
		return nil
	}
	rel, err := filepath.Rel(j.root, path)
	if err != nil {
		return err
	}
	if j.file == nil {
		file, err := os.OpenFile(saveJournalPath(j.root), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			return err
		}
		j.file = file
	}
	if _, err := j.file.WriteString(filepath.ToSlash(rel) + "\n"); err != nil {
		return err
	}
	return flushFile(j.file)
}

func (j *saveJournal) close() {
	if j.file != nil {
		_ = j.file.Close()
		j.file = nil
	}
}

func (j *saveJournal) finish() error {
	if j.file == nil {
		return nil
	}
	for dir := range j.dirs {
		if err := syncDir(dir); err != nil {
			return err
		}
	}
	if err := j.file.Sync(); err != nil {
		return err
	}
	j.close()
	if err := os.Remove(saveJournalPath(j.root)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDir(j.root)
}

func readSaveJournal(root string) (map[string]bool, error) {
	file, err := os.Open(saveJournalPath(root))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	written := map[string]bool{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "..") || filepath.IsAbs(line) {
			continue
		}
		written[filepath.Join(root, filepath.FromSlash(line))] = true
	}
	return written, scanner.Err()
}

func managedYAMLIdentity(path string) (string, bool) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	var doc map[string]any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return "", false
	}
	if _, ok := doc["version"]; !ok {
		return "", false
	}
	for _, kind := range []string{"workspace", "collection", "request", "environment", "example"} {
		item, ok := doc[kind].(map[string]any)
		if !ok {
			continue
		}
		id, _ := item["id"].(string)
		if id == "" {
			return "", false
		}
		return kind + "\x00" + id, true
	}
	return "", false
}

func recoverInterruptedSaveLocked(root string) error {
	yamlStoreWriteMu.Lock()
	defer yamlStoreWriteMu.Unlock()
	return recoverInterruptedSave(root)
}

func recoverInterruptedSave(root string) error {
	written, err := readSaveJournal(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	byIdentity := map[string][]string{}
	managedRoot := filepath.Join(root, fileStoreWorkspacesDir)
	walkErr := filepath.WalkDir(managedRoot, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() || filepath.Ext(path) != fileStoreYAMLExt {
			return nil
		}
		if identity, ok := managedYAMLIdentity(path); ok {
			byIdentity[identity] = append(byIdentity[identity], path)
		}
		return nil
	})
	if walkErr != nil {
		return walkErr
	}
	for _, paths := range byIdentity {
		if len(paths) < 2 {
			continue
		}
		fresh := 0
		for _, path := range paths {
			if written[path] {
				fresh++
			}
		}
		if fresh == 0 || fresh == len(paths) {
			continue
		}
		for _, path := range paths {
			if !written[path] {
				if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
					return err
				}
			}
		}
	}
	if err := removeEmptyDirs(managedRoot); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Remove(saveJournalPath(root)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDir(root)
}
