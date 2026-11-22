package api

import (
	"errors"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type RequestFileInfo struct {
	Path            string `json:"path"`
	AbsolutePath    string `json:"absolutePath"`
	Name            string `json:"name"`
	Size            int64  `json:"size"`
	ContentType     string `json:"contentType"`
	Exists          bool   `json:"exists"`
	InsideWorkspace bool   `json:"insideWorkspace"`
	Error           string `json:"error,omitempty"`
}

func resolveRequestFilePath(root, path string) string {
	value := strings.TrimSpace(path)
	value = strings.TrimPrefix(value, "file://")
	if value == "" {
		return ""
	}
	if strings.HasPrefix(value, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			value = filepath.Join(home, value[2:])
		}
	}
	if filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	if root == "" {
		return filepath.FromSlash(value)
	}
	return filepath.Join(root, filepath.FromSlash(value))
}

func workspaceRelativeFilePath(root, absolute string) (string, bool) {
	if root == "" || !filepath.IsAbs(absolute) {
		return absolute, false
	}
	base, err := filepath.Abs(root)
	if err != nil {
		return absolute, false
	}
	target := filepath.Clean(absolute)
	if relative, ok := relativeInside(base, target); ok {
		return relative, true
	}
	if relative, ok := relativeInside(evalExistingSymlinks(base), evalExistingSymlinks(target)); ok {
		return relative, true
	}
	return absolute, false
}

func relativeInside(base, target string) (string, bool) {
	relative, err := filepath.Rel(base, target)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", false
	}
	return filepath.ToSlash(relative), true
}

func evalExistingSymlinks(path string) string {
	rest := ""
	current := path
	for {
		if resolved, err := filepath.EvalSymlinks(current); err == nil {
			return filepath.Join(resolved, rest)
		}
		parent := filepath.Dir(current)
		if parent == current {
			return path
		}
		rest = filepath.Join(filepath.Base(current), rest)
		current = parent
	}
}

func inspectRequestFile(root, path string) RequestFileInfo {
	absolute := resolveRequestFilePath(root, path)
	info := RequestFileInfo{Path: strings.TrimSpace(path), AbsolutePath: absolute}
	if absolute == "" {
		info.Error = "Choose a file."
		return info
	}
	if filepath.IsAbs(absolute) {
		info.Path, info.InsideWorkspace = workspaceRelativeFilePath(root, absolute)
		if info.InsideWorkspace {
			info.AbsolutePath = filepath.Join(root, filepath.FromSlash(info.Path))
		} else {
			info.Path = absolute
		}
	}
	info.Name = filepath.Base(absolute)
	info.ContentType = requestFileContentType(info.Name)
	stat, err := os.Stat(info.AbsolutePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			info.Error = "File not found."
		} else {
			info.Error = err.Error()
		}
		return info
	}
	if stat.IsDir() {
		info.Error = "This is a folder, not a file."
		return info
	}
	info.Exists = true
	info.Size = stat.Size()
	if info.Size > maxFileBodySize {
		info.Error = fmt.Sprintf("File is larger than the %d MB body limit.", maxFileBodySize/(1024*1024))
	}
	return info
}

func requestFileContentType(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		return ""
	}
	value := mime.TypeByExtension(ext)
	if value == "" {
		return ""
	}
	if media, _, err := mime.ParseMediaType(value); err == nil {
		return media
	}
	return value
}

func withRequestFileRoot(req model.HttpRequest, root string) model.HttpRequest {
	req.FileRoot = root
	return req
}

func resolveRequestFilePaths(req model.HttpRequest) model.HttpRequest {
	if req.BodyFilePath != "" {
		req.BodyFilePath = resolveRequestFilePath(req.FileRoot, req.BodyFilePath)
	}
	if len(req.FormData) == 0 {
		return req
	}
	rows := make([]model.KeyValue, len(req.FormData))
	for i, row := range req.FormData {
		if row.IsFile && row.Value != "" {
			row.Value = resolveRequestFilePath(req.FileRoot, row.Value)
		}
		rows[i] = row
	}
	req.FormData = rows
	return req
}

func (a *App) InspectRequestFile(path string) RequestFileInfo {
	return inspectRequestFile(fileWorkspaceStorePath(), path)
}

func (a *App) RevealRequestFile(path string) string {
	info := inspectRequestFile(fileWorkspaceStorePath(), path)
	if !info.Exists {
		return "Could not show the file: " + strings.TrimSuffix(info.Error, ".")
	}
	if err := selectInFileManager(info.AbsolutePath); err != nil {
		return "Could not show the file: " + err.Error()
	}
	return ""
}
