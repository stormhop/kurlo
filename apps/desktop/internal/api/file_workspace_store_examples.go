package api

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	fileStoreExamplesDir = "examples"
	exampleBodySuffix    = ".body"
)

type filesystemExampleFile struct {
	Version int            `yaml:"version" json:"version"`
	Order   int            `yaml:"order,omitempty" json:"order,omitempty"`
	Example map[string]any `yaml:"example" json:"example"`
}

func exampleResponseMap(example map[string]any) map[string]any {
	response, _ := example["response"].(map[string]any)
	return response
}

func requestExampleMaps(request map[string]any) []map[string]any {
	raw, ok := request["examples"]
	delete(request, "examples")
	if !ok {
		return nil
	}
	var list []map[string]any
	switch typed := raw.(type) {
	case []map[string]any:
		list = typed
	case []any:
		for _, item := range typed {
			if example, ok := item.(map[string]any); ok {
				list = append(list, example)
			}
		}
	default:
		return nil
	}
	examples := make([]map[string]any, 0, len(list))
	for _, example := range list {
		if stringValue(example, "id") != "" {
			examples = append(examples, example)
		}
	}
	return examples
}

func writeRequestExamples(collectionDir, requestSegment string, examples []map[string]any, desiredFiles map[string]struct{}, journal *saveJournal) error {
	if len(examples) == 0 {
		return nil
	}
	if requestSegment == "" {
		return fmt.Errorf("request has no filesystem name to store its examples under")
	}
	exampleDir := filepath.Join(collectionDir, fileStoreExamplesDir, requestSegment)
	if err := os.MkdirAll(exampleDir, 0755); err != nil {
		return err
	}

	segments := filesystemSegmentsForItems(examples)
	for index, example := range examples {
		id := stringValue(example, "id")
		segment := segments[id]
		if segment == "" {
			continue
		}

		if response := exampleResponseMap(example); response != nil {
			delete(response, "bodyFile")
		}

		delete(example, filesystemNameField)
		stripTimestamps(example)
		examplePath := filepath.Join(exampleDir, segment+fileStoreYAMLExt)
		if err := writeJournaledYAMLFile(examplePath, filesystemExampleFile{
			Version: fileStoreVersion,
			Order:   index,
			Example: example,
		}, journal); err != nil {
			return err
		}
		desiredFiles[examplePath] = struct{}{}
	}
	return nil
}

func readRequestExamples(collectionDir, requestSegment, workspaceRoot, workspaceID, collectionID, requestID string, validator *workspaceIntegrityValidator) ([]map[string]any, []WorkspaceDiagnostic) {
	if requestSegment == "" {
		return nil, nil
	}
	exampleDir := filepath.Join(collectionDir, fileStoreExamplesDir, requestSegment)
	entries, err := readDirNoSymlink(exampleDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, []WorkspaceDiagnostic{workspaceDiagnostic{
			scope: workspaceIntegrityScope, blocking: true, path: exampleDir, root: workspaceRoot, err: err,
			workspaceID: workspaceID, collectionID: collectionID, requestID: requestID,
		}.toDiagnostic()}
	}

	type loadedExample struct {
		order   int
		name    string
		example map[string]any
	}
	var loaded []loadedExample
	var diagnostics []WorkspaceDiagnostic

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != fileStoreYAMLExt {
			continue
		}
		path := filepath.Join(exampleDir, entry.Name())
		var doc filesystemExampleFile
		if err := readYAMLFile(path, &doc); err != nil {
			diagnostics = append(diagnostics, workspaceDiagnostic{
				scope: workspaceIntegrityScope, blocking: true, path: path, root: workspaceRoot, err: err,
				workspaceID: workspaceID, collectionID: collectionID, requestID: requestID,
			}.toDiagnostic())
			continue
		}
		if doc.Example == nil {
			diagnostics = append(diagnostics, workspaceDiagnostic{
				scope: workspaceIntegrityScope, blocking: true, path: path, root: workspaceRoot,
				message: "example file does not contain an example object. Restore the example before saving.",
			}.toDiagnostic())
			continue
		}
		validator.item("example", path, doc.Example)
		if _, exists := doc.Example["requestId"]; exists {
			validator.reference(path, "example", doc.Example, "requestId", requestID)
		}
		segment := strings.TrimSuffix(entry.Name(), fileStoreYAMLExt)
		doc.Example[filesystemNameField] = segment

		if response := exampleResponseMap(doc.Example); response != nil {
			bodyFile := stringValue(response, "bodyFile")
			delete(response, "bodyFile")
			if bodyFile != "" {
				if bodyFile != filepath.Base(bodyFile) {
					diagnostics = append(diagnostics, workspaceDiagnostic{
						scope: workspaceIntegrityScope, blocking: true, path: path, root: workspaceRoot,
						message:     fmt.Sprintf("example body file %q must be a plain file name", bodyFile),
						workspaceID: workspaceID, collectionID: collectionID, requestID: requestID,
					}.toDiagnostic())
				} else if data, err := os.ReadFile(filepath.Join(exampleDir, bodyFile)); err != nil {
					diagnostics = append(diagnostics, workspaceDiagnostic{
						scope: workspaceIntegrityScope, blocking: true, path: filepath.Join(exampleDir, bodyFile), root: workspaceRoot, err: err,
						workspaceID: workspaceID, collectionID: collectionID, requestID: requestID,
					}.toDiagnostic())
				} else {
					response["body"] = string(data)
				}
			}
			if _, ok := response["body"]; !ok {
				response["body"] = ""
			}
		}
		loaded = append(loaded, loadedExample{order: doc.Order, name: segment, example: doc.Example})
	}

	sort.SliceStable(loaded, func(i, j int) bool {
		if loaded[i].order != loaded[j].order {
			return loaded[i].order < loaded[j].order
		}
		return loaded[i].name < loaded[j].name
	})
	examples := make([]map[string]any, 0, len(loaded))
	for _, item := range loaded {
		examples = append(examples, item.example)
	}
	if len(examples) == 0 {
		return nil, diagnostics
	}
	return examples, diagnostics
}

func isExampleBodyPath(path string) bool {
	if filepath.Ext(path) == fileStoreYAMLExt {
		return false
	}
	parent := filepath.Dir(path)
	return filepath.Base(filepath.Dir(parent)) == fileStoreExamplesDir
}
