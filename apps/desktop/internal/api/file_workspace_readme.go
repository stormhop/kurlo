package api

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	workspaceReadmeFile       = "README.md"
	workspaceReadmeMaxBytes   = 256 << 10
	workspaceReadmeIssueField = "readmeIssue"
)

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

func workspaceReadmePath(workspaceDir string) string {
	return filepath.Join(workspaceDir, workspaceReadmeFile)
}

func isWorkspaceReadmeName(name string) bool {
	return strings.EqualFold(name, workspaceReadmeFile)
}

func findWorkspaceReadme(workspaceDir string) (string, bool) {
	exact := workspaceReadmePath(workspaceDir)
	if _, err := os.Lstat(exact); err == nil {
		return exact, true
	}
	entries, err := os.ReadDir(workspaceDir)
	if err != nil {
		return exact, false
	}
	var names []string
	for _, entry := range entries {
		if isWorkspaceReadmeName(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	if len(names) == 0 {
		return exact, false
	}
	sort.Strings(names)
	return filepath.Join(workspaceDir, names[0]), true
}

func workspaceReadmeIssue(path string, data []byte) string {
	name := filepath.Base(path)
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Sprintf("Kurlo could not read %s: %v", name, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Sprintf("%s is a link to another file, so Kurlo shows nothing here and never changes it. Edit it in another editor.", name)
	}
	if !info.Mode().IsRegular() {
		return fmt.Sprintf("%s is not a regular file, so Kurlo leaves it alone.", name)
	}
	if info.Size() > workspaceReadmeMaxBytes {
		return fmt.Sprintf("%s is over %d KB, so Kurlo does not show or edit it. Shorten it in another editor.", name, workspaceReadmeMaxBytes>>10)
	}
	if data != nil && (!utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0) {
		return fmt.Sprintf("%s is not plain UTF-8 text, so Kurlo does not show or edit it.", name)
	}
	return ""
}

func readWorkspaceReadme(workspaceDir string) (text string, issue string, exists bool) {
	path, exists := findWorkspaceReadme(workspaceDir)
	if !exists {
		return "", "", false
	}
	if issue := workspaceReadmeIssue(path, nil); issue != "" {
		return "", issue, true
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Sprintf("Kurlo could not read %s: %v", filepath.Base(path), err), true
	}
	if issue := workspaceReadmeIssue(path, data); issue != "" {
		return "", issue, true
	}
	data = bytes.TrimPrefix(data, utf8BOM)
	return strings.ReplaceAll(string(data), "\r\n", "\n"), "", true
}

func applyWorkspaceReadme(workspaceDir string, workspace map[string]any) {
	text, issue, exists := readWorkspaceReadme(workspaceDir)
	if !exists {
		return
	}
	workspace["description"] = text
	if issue != "" {
		workspace[workspaceReadmeIssueField] = issue
	}
}

func workspaceReadmeBytes(text string, existing []byte) []byte {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	if bytes.Contains(existing, []byte("\r\n")) {
		text = strings.ReplaceAll(text, "\n", "\r\n")
	}
	data := []byte(text)
	if bytes.HasPrefix(existing, utf8BOM) {
		data = append(append([]byte{}, utf8BOM...), data...)
	}
	return data
}

func writeWorkspaceReadme(workspaceDir string, workspace map[string]any, journal *saveJournal) error {
	text, _ := workspace["description"].(string)
	delete(workspace, "description")
	delete(workspace, workspaceReadmeIssueField)
	path, exists := findWorkspaceReadme(workspaceDir)
	var existing []byte
	if exists {
		if workspaceReadmeIssue(path, nil) != "" {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if workspaceReadmeIssue(path, data) != "" {
			return nil
		}
		existing = data
	}
	if strings.TrimSpace(text) == "" {
		if !exists {
			return nil
		}
		if err := journal.record(path); err != nil {
			return err
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	data := workspaceReadmeBytes(text, existing)
	if exists && bytes.Equal(existing, data) {
		return nil
	}
	if err := journal.record(path); err != nil {
		return err
	}
	return writeTextFileAtomic(path, data)
}

func staleWorkspaceReadmes(managedRoot string, stale []string) []string {
	var readmes []string
	for _, path := range stale {
		if filepath.Base(path) != fileStoreRootFileName || filepath.Dir(filepath.Dir(path)) != managedRoot {
			continue
		}
		readme, exists := findWorkspaceReadme(filepath.Dir(path))
		if !exists {
			continue
		}
		if info, err := os.Lstat(readme); err == nil && info.Mode().IsRegular() {
			readmes = append(readmes, readme)
		}
	}
	return readmes
}

func workspaceDirsByID(managedRoot string) map[string]string {
	dirs := map[string]string{}
	entries, err := readDirNoSymlink(managedRoot)
	if err != nil {
		return dirs
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		dir := filepath.Join(managedRoot, entry.Name())
		var doc filesystemWorkspaceFile
		if err := readYAMLFile(filepath.Join(dir, fileStoreRootFileName), &doc); err != nil {
			continue
		}
		workspace, ok := doc.Workspace.(map[string]any)
		if !ok {
			continue
		}
		if id := stringValue(workspace, "id"); id != "" {
			dirs[id] = dir
		}
	}
	return dirs
}

func carryWorkspaceReadme(previousDir, workspaceDir string, journal *saveJournal) error {
	if previousDir == "" || previousDir == workspaceDir {
		return nil
	}
	from, exists := findWorkspaceReadme(previousDir)
	if !exists {
		return nil
	}
	if info, err := os.Lstat(from); err != nil || !info.Mode().IsRegular() {
		return nil
	}
	if _, taken := findWorkspaceReadme(workspaceDir); taken {
		return nil
	}
	to := filepath.Join(workspaceDir, filepath.Base(from))
	if err := journal.record(from); err != nil {
		return err
	}
	if err := journal.record(to); err != nil {
		return err
	}
	return os.Rename(from, to)
}
