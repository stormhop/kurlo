package api

import (
	"context"
	"testing"
)

func announcedWorkspaceFingerprint() string {
	workspaceDisk.mu.Lock()
	defer workspaceDisk.mu.Unlock()
	return workspaceDisk.announced
}

func TestDiskPollingWaitsWhileTheWindowIsMinimised(t *testing.T) {
	app, root := appWorkspaceForTest(t)
	minimised := true
	previous := workspaceWindowMinimised
	workspaceWindowMinimised = func(context.Context) bool { return minimised }
	t.Cleanup(func() { workspaceWindowMinimised = previous })
	agentAddsRequest(t, root, "Orders")
	before := announcedWorkspaceFingerprint()
	var globals string

	if app.pollWorkspaceDisk(context.Background(), &globals) {
		t.Fatal("a minimised window should not scan the workspace")
	}
	if announcedWorkspaceFingerprint() != before {
		t.Fatal("a skipped poll should leave the outside change for the next one")
	}

	minimised = false
	if !app.pollWorkspaceDisk(context.Background(), &globals) {
		t.Fatal("a restored window should scan the workspace")
	}
	if announcedWorkspaceFingerprint() == before {
		t.Fatal("the first poll after restoring should announce the outside change")
	}
	if changed, _ := app.workspaceChangedOutside(); changed {
		t.Fatal("the change should be announced once")
	}
}
