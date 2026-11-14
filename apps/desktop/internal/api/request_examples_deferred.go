package api

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

var errRequestExamplesNeedReload = errors.New("some example files need attention; reopen the workspace to see what to fix")

type deferredExampleSource struct {
	collectionDir string
	segment       string
	workspaceID   string
	collectionID  string
	requestID     string
}

type deferredRequestExamples struct {
	sources []deferredExampleSource
}

func (d *deferredRequestExamples) reset() {
	if d != nil {
		d.sources = nil
	}
}

func collectionExampleSegments(collectionDir string) map[string]bool {
	entries, err := readDirNoSymlink(filepath.Join(collectionDir, fileStoreExamplesDir))
	if err != nil {
		return nil
	}
	segments := make(map[string]bool, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			segments[entry.Name()] = true
		}
	}
	return segments
}

func (d *deferredRequestExamples) note(collectionDir, workspaceID, collectionID string, request map[string]any, segments map[string]bool) {
	segment := stringValue(request, filesystemNameField)
	if segment == "" || !segments[segment] {
		return
	}
	entries, err := readDirNoSymlink(requestExampleDir(collectionDir, segment))
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	count := 0
	for _, entry := range entries {
		if !entry.IsDir() && filepath.Ext(entry.Name()) == fileStoreYAMLExt {
			count++
		}
	}
	if count == 0 && err == nil {
		return
	}
	if count > 0 {
		request[exampleCountField] = count
	}
	d.sources = append(d.sources, deferredExampleSource{
		collectionDir: collectionDir,
		segment:       segment,
		workspaceID:   workspaceID,
		collectionID:  collectionID,
		requestID:     stringValue(request, "id"),
	})
}

func (d *deferredRequestExamples) load(root string) (map[string]json.RawMessage, bool) {
	examples := map[string]json.RawMessage{}
	if d == nil || len(d.sources) == 0 {
		return examples, true
	}
	dirs := make([]string, 0, len(d.sources))
	for _, source := range d.sources {
		dirs = append(dirs, requestExampleDir(source.collectionDir, source.segment))
	}
	scanned := scanRequestExampleDirs(dirs)
	validator := newWorkspaceIntegrityValidator(root)
	healthy := true
	for _, source := range d.sources {
		loaded, diagnostics := readRequestExamples(source.collectionDir, source.segment, root, source.workspaceID, source.collectionID, source.requestID, validator, scanned)
		if len(diagnostics) > 0 {
			healthy = false
		}
		usable := validator.usableItems("example", loaded)
		if len(usable) == 0 {
			continue
		}
		encoded, err := json.Marshal(usable)
		if err != nil {
			healthy = false
			continue
		}
		examples[source.requestID] = encoded
	}
	if len(validator.diagnostics) > 0 || len(validator.fixes) > 0 {
		healthy = false
	}
	return examples, healthy
}
