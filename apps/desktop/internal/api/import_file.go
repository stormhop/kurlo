package api

import (
	"fmt"
	"os"
	"path/filepath"
	"unicode/utf8"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type ImportFileResult struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Error   string `json:"error"`
}

var importFileFilters = map[string]runtime.FileFilter{
	"postman":  {DisplayName: "Postman collection or environment (*.json)", Pattern: "*.json"},
	"insomnia": {DisplayName: "Insomnia export (*.json, *.yaml)", Pattern: "*.json;*.yaml;*.yml"},
	"openapi":  {DisplayName: "OpenAPI / Swagger (*.json, *.yaml)", Pattern: "*.json;*.yaml;*.yml"},
	"har":      {DisplayName: "HAR (*.har, *.json)", Pattern: "*.har;*.json"},
	"httpfile": {DisplayName: "HTTP file (*.http, *.rest)", Pattern: "*.http;*.rest"},
}

func importDialogOptions(source string) runtime.OpenDialogOptions {
	options := runtime.OpenDialogOptions{Title: "Import"}
	if filter, ok := importFileFilters[source]; ok {
		options.Title = "Import " + filter.DisplayName
		options.Filters = []runtime.FileFilter{filter}
	}
	return options
}

func readImportFile(path string) ImportFileResult {
	result := ImportFileResult{Path: path, Name: filepath.Base(path)}
	info, err := os.Stat(path)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	if info.IsDir() {
		result.Error = fmt.Sprintf("%s is a folder", result.Name)
		return result
	}
	if info.Size() > maxTextFileReadSize {
		result.Error = fmt.Sprintf("%s is larger than %d MB", result.Name, maxTextFileReadSize>>20)
		return result
	}
	data, err := os.ReadFile(path)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	if !utf8.Valid(data) {
		result.Error = fmt.Sprintf("%s is not a text file", result.Name)
		return result
	}
	result.Content = string(data)
	return result
}

func (a *App) ChooseImportFile(source string) ImportFileResult {
	if a.ctx == nil {
		return ImportFileResult{Error: "the import dialog needs the desktop app"}
	}
	path, err := runtime.OpenFileDialog(a.ctx, importDialogOptions(source))
	if err != nil {
		return ImportFileResult{Error: err.Error()}
	}
	if path == "" {
		return ImportFileResult{}
	}
	return readImportFile(path)
}

func (a *App) ReadImportFile(path string) ImportFileResult {
	if path == "" {
		return ImportFileResult{Error: "no file to import"}
	}
	return readImportFile(path)
}
