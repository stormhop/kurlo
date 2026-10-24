package api

import (
	"os"
	"path/filepath"
)

func requestStorePath() string {
	return filepath.Join(requestStoreDir(), "requests.json")
}

func fileWorkspaceStorePath() string {
	if root := configuredFileWorkspaceStorePath(); root != "" {
		return root
	}
	return defaultFileWorkspaceStorePath()
}

func fileWorkspaceStorageMode() string {
	storage, err := loadLocalRequestStoreStorage(requestStorePath())
	if err != nil {
		return inferWorkspaceStorageMode(fileWorkspaceStorePath())
	}
	mode := stringValue(storage, "mode")
	if mode == workspaceStorageModeGit || mode == workspaceStorageModeLocal {
		return mode
	}
	return inferWorkspaceStorageMode(fileWorkspaceStorePath())
}

func defaultFileWorkspaceStorePath() string {
	return filepath.Join(requestStoreDir(), "workspaces")
}

func configuredFileWorkspaceStorePath() string {
	storage, err := loadLocalRequestStoreStorage(requestStorePath())
	if err != nil {
		return ""
	}
	return stringValue(storage, "root")
}

func persistedWorkspaceRoot(root string) string {
	if isDefaultWorkspaceRoot(root) {
		return ""
	}
	return root
}

func resolvedStoredWorkspaceRoot(stored string) string {
	if stored == "" {
		return defaultFileWorkspaceStorePath()
	}
	return stored
}

func inferWorkspaceStorageMode(root string) string {
	if root == "" || root == defaultFileWorkspaceStorePath() {
		return workspaceStorageModeLocal
	}
	return workspaceStorageModeGit
}

func requestStoreDir() string {
	dir, err := os.UserConfigDir()
	if err != nil || dir == "" {
		dir = "."
	}
	return filepath.Join(dir, "Kurlo")
}
