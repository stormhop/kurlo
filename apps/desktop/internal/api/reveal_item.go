package api

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	goruntime "runtime"
)

var selectInFileManager = func(target string) error {
	if showItemInFileManager(target) == nil {
		return nil
	}
	return startFileManager(fileManagerSelectCommand(target))
}

func fileManagerSelectCommand(target string) *exec.Cmd {
	switch goruntime.GOOS {
	case "darwin":
		return exec.Command("open", "-R", target)
	case "windows":
		return explorerSelectCommand(filepath.FromSlash(target))
	default:
		return exec.Command("xdg-open", filepath.Dir(target))
	}
}

func (a *App) RevealWorkspaceItem(kind, id string) string {
	target, err := workspaceItemPath(fileWorkspaceStorePath(), kind, id)
	if err == nil {
		err = selectInFileManager(target)
	}
	if err != nil {
		return "Could not show the file: " + err.Error()
	}
	return ""
}

func workspaceItemPath(root, kind, id string) (string, error) {
	workspaces, collections, requests, _, _, _, err := loadFilesystemWorkspaceStoreWithDiagnostics(root, map[string]string{})
	if err != nil {
		return "", err
	}
	var collection map[string]any
	file := ""
	switch kind {
	case "request":
		request := itemByID(requests, id)
		if request == nil {
			return "", errors.New("the request is not saved to a file yet")
		}
		collection = itemByID(collections, stringValue(request, "collectionId"))
		file = path.Join(fileStoreRequestsDir, stringValue(request, filesystemNameField)+fileStoreYAMLExt)
	case "collection":
		collection = itemByID(collections, id)
	default:
		return "", fmt.Errorf("unknown item kind %q", kind)
	}
	if collection == nil {
		return "", errors.New("the collection is not saved to a folder yet")
	}
	workspace := itemByID(workspaces, stringValue(collection, "workspaceId"))
	if workspace == nil {
		return "", errors.New("the workspace is not saved to a folder yet")
	}
	relative := path.Join(fileStoreWorkspacesDir, stringValue(workspace, filesystemNameField), fileStoreCollectionsDir, stringValue(collection, filesystemNameField), file)
	target := filepath.Join(root, filepath.FromSlash(relative))
	if _, err := os.Stat(target); err != nil {
		return "", fmt.Errorf("%s is not on disk yet", filepath.Base(target))
	}
	return target, nil
}

func itemByID(items []map[string]any, id string) map[string]any {
	for _, item := range items {
		if id != "" && stringValue(item, "id") == id {
			return item
		}
	}
	return nil
}
