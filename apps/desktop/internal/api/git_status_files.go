package api

import (
	"path"
	"path/filepath"
	"strings"
)

const gitScopedStatusPathLimit = 64

type GitFileStatusResult struct {
	Ok     bool            `json:"ok"`
	Scoped bool            `json:"scoped"`
	Paths  []string        `json:"paths"`
	Files  []GitFileStatus `json:"files"`
}

func (a *App) GitStatusFiles(paths []string) GitFileStatusResult {
	gitOperationMu.RLock()
	defer gitOperationMu.RUnlock()
	if fileWorkspaceStorageMode() == workspaceStorageModeLocal {
		return GitFileStatusResult{}
	}
	return gitStatusFilesForWorkspace(fileWorkspaceStorePath(), paths)
}

func gitStatusFilesForWorkspace(workspaceRoot string, paths []string) GitFileStatusResult {
	if workspaceRootMissing(workspaceRoot) {
		return GitFileStatusResult{}
	}
	located, err := gitOutput(workspaceRoot, "rev-parse", "--show-toplevel", "--show-prefix")
	if err != nil {
		return GitFileStatusResult{}
	}
	lines := strings.Split(strings.ReplaceAll(located, "\r\n", "\n"), "\n")
	repoRoot := strings.TrimSpace(lines[0])
	if repoRoot == "" {
		return GitFileStatusResult{}
	}
	repoRoot = filepath.Clean(repoRoot)
	prefix := ""
	if len(lines) > 1 {
		prefix = strings.TrimSpace(lines[1])
	}
	repoPaths, scoped := gitScopedStatusPaths(prefix, paths)
	args := []string{"status", "--porcelain=v1", "-b", "--untracked-files=all"}
	if scoped {
		if len(repoPaths) == 0 {
			return GitFileStatusResult{Ok: true, Scoped: true, Paths: []string{}, Files: []GitFileStatus{}}
		}
		args = append(args, "--")
		for _, repoPath := range repoPaths {
			args = append(args, ":(literal)"+repoPath)
		}
	}
	output, err := gitOutput(repoRoot, args...)
	if err != nil {
		return GitFileStatusResult{}
	}
	result := GitFileStatusResult{Ok: true, Scoped: scoped, Paths: repoPaths, Files: parseGitPorcelainStatus(workspaceRoot, repoRoot, output, nil)}
	if result.Paths == nil {
		result.Paths = []string{}
	}
	return result
}

func gitScopedStatusPaths(prefix string, paths []string) ([]string, bool) {
	if paths == nil || len(paths) > gitScopedStatusPathLimit {
		return nil, false
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(paths))
	for _, raw := range paths {
		rel := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
		if rel == "" || !filepath.IsLocal(filepath.FromSlash(rel)) {
			return nil, false
		}
		repoPath := path.Clean(path.Join(prefix, rel))
		if seen[repoPath] {
			continue
		}
		seen[repoPath] = true
		out = append(out, repoPath)
	}
	return out, true
}
