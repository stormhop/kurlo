package api

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const fileStoreLoadTestsDir = "loadtests"

type filesystemLoadTestFile struct {
	Version  int            `yaml:"version" json:"version"`
	Order    int            `yaml:"order,omitempty" json:"order,omitempty"`
	LoadTest map[string]any `yaml:"loadTest" json:"loadTest"`
}

func collectionLoadTestMaps(collection map[string]any) []map[string]any {
	raw, ok := collection["loadTests"]
	delete(collection, "loadTests")
	if !ok {
		return nil
	}
	loadTests := make([]map[string]any, 0)
	for _, loadTest := range mapSlice(raw) {
		if stringValue(loadTest, "id") != "" {
			loadTests = append(loadTests, loadTest)
		}
	}
	return loadTests
}

func writeCollectionLoadTests(collectionDir string, loadTests []map[string]any, desiredFiles map[string]struct{}, journal *saveJournal) error {
	if len(loadTests) == 0 {
		return nil
	}
	loadTestDir := filepath.Join(collectionDir, fileStoreLoadTestsDir)
	if err := os.MkdirAll(loadTestDir, 0755); err != nil {
		return err
	}
	segments := filesystemSegmentsForItems(loadTests)
	for index, loadTest := range loadTests {
		segment := segments[stringValue(loadTest, "id")]
		if segment == "" {
			continue
		}
		delete(loadTest, filesystemNameField)
		loadTestPath := filepath.Join(loadTestDir, segment+fileStoreYAMLExt)
		if err := writeJournaledYAMLFile(loadTestPath, filesystemLoadTestFile{
			Version:  fileStoreVersion,
			Order:    index,
			LoadTest: loadTest,
		}, journal); err != nil {
			return err
		}
		desiredFiles[loadTestPath] = struct{}{}
	}
	return nil
}

func readCollectionLoadTests(collectionDir, workspaceRoot, workspaceID, collectionID string, validator *workspaceIntegrityValidator) ([]map[string]any, []WorkspaceDiagnostic) {
	loadTestDir := filepath.Join(collectionDir, fileStoreLoadTestsDir)
	entries, err := readDirNoSymlink(loadTestDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, []WorkspaceDiagnostic{workspaceDiagnostic{
			scope: workspaceIntegrityScope, blocking: true, path: loadTestDir, root: workspaceRoot, err: err,
			workspaceID: workspaceID, collectionID: collectionID,
		}.toDiagnostic()}
	}

	type loadedLoadTest struct {
		order    int
		name     string
		loadTest map[string]any
	}
	var loaded []loadedLoadTest
	var diagnostics []WorkspaceDiagnostic

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != fileStoreYAMLExt {
			continue
		}
		path := filepath.Join(loadTestDir, entry.Name())
		var doc filesystemLoadTestFile
		if err := readYAMLFile(path, &doc); err != nil {
			diagnostics = append(diagnostics, workspaceDiagnostic{
				scope: workspaceIntegrityScope, blocking: true, path: path, root: workspaceRoot, err: err,
				workspaceID: workspaceID, collectionID: collectionID,
			}.toDiagnostic())
			continue
		}
		if doc.LoadTest == nil {
			diagnostics = append(diagnostics, workspaceDiagnostic{
				scope: workspaceIntegrityScope, blocking: true, path: path, root: workspaceRoot,
				message:     "load test file does not contain a loadTest object. Restore the load test before saving.",
				workspaceID: workspaceID, collectionID: collectionID,
			}.toDiagnostic())
			continue
		}
		validator.item("load test", path, doc.LoadTest)
		segment := strings.TrimSuffix(entry.Name(), fileStoreYAMLExt)
		doc.LoadTest[filesystemNameField] = segment
		loaded = append(loaded, loadedLoadTest{order: doc.Order, name: segment, loadTest: doc.LoadTest})
	}

	sort.SliceStable(loaded, func(i, j int) bool {
		if loaded[i].order != loaded[j].order {
			return loaded[i].order < loaded[j].order
		}
		return loaded[i].name < loaded[j].name
	})
	loadTests := make([]map[string]any, 0, len(loaded))
	for _, item := range loaded {
		loadTests = append(loadTests, item.loadTest)
	}
	if len(loadTests) == 0 {
		return nil, diagnostics
	}
	return loadTests, diagnostics
}
