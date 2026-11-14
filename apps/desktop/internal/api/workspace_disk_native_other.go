//go:build !(darwin && cgo) && !linux && !windows

package api

import "errors"

func startWorkspaceNativeWatch(string) (workspaceNativeWatch, error) {
	return nil, errors.New("native file watching is not available")
}
