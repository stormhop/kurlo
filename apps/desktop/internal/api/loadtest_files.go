package api

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/loadtest"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func (a *App) PreviewLoadTestData(path string) model.LoadDataPreview {
	return previewLoadTestData(fileWorkspaceStorePath(), path)
}

func previewLoadTestData(root, path string) model.LoadDataPreview {
	result := model.LoadDataPreview{Columns: []string{}, Rows: [][]string{}}
	if root == "" {
		result.Error = "Open a workspace folder before choosing test data."
		return result
	}
	if filepath.IsAbs(path) {
		var err error
		path, err = filepath.Rel(root, path)
		if err != nil {
			result.Error = err.Error()
			return result
		}
	}
	result.Path = filepath.ToSlash(path)
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".csv" && ext != ".json" {
		result.Error = "Choose a CSV or JSON file inside the workspace folder."
		return result
	}
	rows, message := loadTestData(root, result.Path)
	if message != "" {
		result.Error = message
		return result
	}
	columns := map[string]bool{}
	for _, row := range rows {
		for column := range row {
			columns[column] = true
		}
	}
	for column := range columns {
		result.Columns = append(result.Columns, column)
	}
	sort.Strings(result.Columns)
	result.Total = len(rows)
	for _, row := range rows[:min(5, len(rows))] {
		cells := make([]string, len(result.Columns))
		for index, column := range result.Columns {
			cells[index] = row[column]
		}
		result.Rows = append(result.Rows, cells)
	}
	return result
}

func (a *App) ExportLoadTestK6Files(payload string, inlineSecrets bool) model.K6ExportResult {
	plan, err := loadTestPlanFromPayload(payload, fileWorkspaceStorePath())
	if err != nil {
		return model.K6ExportResult{Warnings: []model.K6ExportWarning{}, Error: err.Error()}
	}
	if plan.DataError != "" {
		return model.K6ExportResult{Warnings: []model.K6ExportWarning{}, Error: plan.DataError}
	}
	result := loadtest.GenerateK6(plan, loadtest.Options{InlineSecrets: inlineSecrets, SeparateData: true})
	if result.Warnings == nil {
		result.Warnings = []model.K6ExportWarning{}
	}
	return result
}

func (a *App) SaveLoadTestK6Folder(payload string, inlineSecrets bool, parent string) string {
	result := a.ExportLoadTestK6Files(payload, inlineSecrets)
	if result.Error != "" {
		return result.Error
	}
	plan, err := loadTestPlanFromPayload(payload, fileWorkspaceStorePath())
	if err != nil {
		return err.Error()
	}
	name := strings.TrimSuffix(loadtest.GenerateK6(plan, loadtest.Options{}).FileName, ".k6.js")
	if err := writeLoadTestFolder(parent, name, result.Files); err != nil {
		return err.Error()
	}
	return ""
}

func writeLoadTestFolder(parent, name string, files []model.K6ExportFile) error {
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name {
		return fmt.Errorf("invalid export folder name")
	}
	target := filepath.Join(parent, name)
	if _, err := os.Lstat(target); err == nil {
		return fmt.Errorf("%s already exists. Choose another parent folder or rename the existing export", target)
	} else if !os.IsNotExist(err) {
		return err
	}
	dir, err := os.MkdirTemp(parent, ".kurlo-export-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	for _, file := range files {
		if file.Path != "script.k6.js" && file.Path != "data.json" {
			return fmt.Errorf("invalid export file name: %s", file.Path)
		}
		if err := os.WriteFile(filepath.Join(dir, file.Path), []byte(file.Content), 0600); err != nil {
			return err
		}
	}
	return os.Rename(dir, target)
}
