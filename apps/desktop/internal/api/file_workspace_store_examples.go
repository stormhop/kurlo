package api

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
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

type parsedExampleFile struct {
	doc filesystemExampleFile
	err error
}

type requestExampleScan struct {
	entries []os.DirEntry
	err     error
	files   map[string]parsedExampleFile
}

func scanRequestExampleDir(exampleDir string) requestExampleScan {
	entries, err := readDirNoSymlink(exampleDir)
	if err != nil {
		return requestExampleScan{err: err}
	}
	files := make(map[string]parsedExampleFile, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != fileStoreYAMLExt {
			continue
		}
		path := filepath.Join(exampleDir, entry.Name())
		var parsed parsedExampleFile
		if entry.Type()&os.ModeSymlink != 0 {
			parsed.err = fmt.Errorf("read %s: refusing to read symlink", path)
		} else {
			parsed.err = readYAMLRegularFile(path, &parsed.doc)
		}
		files[entry.Name()] = parsed
	}
	return requestExampleScan{entries: entries, files: files}
}

func scanRequestExampleDirs(dirs []string) map[string]requestExampleScan {
	scans := make(map[string]requestExampleScan, len(dirs))
	if len(dirs) == 0 {
		return scans
	}
	workers := runtime.GOMAXPROCS(0) * 2
	if workers > 16 {
		workers = 16
	}
	if workers > len(dirs) {
		workers = len(dirs)
	}
	type result struct {
		dir  string
		scan requestExampleScan
	}
	jobs := make(chan string)
	results := make(chan result)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for dir := range jobs {
				results <- result{dir: dir, scan: scanRequestExampleDir(dir)}
			}
		}()
	}
	go func() {
		for _, dir := range dirs {
			jobs <- dir
		}
		close(jobs)
		wg.Wait()
		close(results)
	}()
	for item := range results {
		scans[item.dir] = item.scan
	}
	return scans
}

func requestExampleDir(collectionDir, requestSegment string) string {
	return filepath.Join(collectionDir, fileStoreExamplesDir, requestSegment)
}

func readRequestExamples(collectionDir, requestSegment, workspaceRoot, workspaceID, collectionID, requestID string, validator *workspaceIntegrityValidator, scanned map[string]requestExampleScan) ([]map[string]any, []WorkspaceDiagnostic) {
	if requestSegment == "" {
		return nil, nil
	}
	exampleDir := requestExampleDir(collectionDir, requestSegment)
	scan, ok := scanned[exampleDir]
	if !ok {
		scan = scanRequestExampleDir(exampleDir)
	}
	entries, err := scan.entries, scan.err
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
		parsed, ok := scan.files[entry.Name()]
		if !ok {
			parsed.err = readYAMLFile(path, &parsed.doc)
		}
		doc := parsed.doc
		if err := parsed.err; err != nil {
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

func legacyExampleBodyPaths(root string) (map[string]struct{}, error) {
	paths := map[string]struct{}{}
	examplesByDir := map[string][]string{}
	dirsWithBodies := map[string]bool{}
	err := filepath.WalkDir(filepath.Join(root, fileStoreWorkspacesDir), func(path string, entry os.DirEntry, err error) error {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || filepath.Base(filepath.Dir(filepath.Dir(path))) != fileStoreExamplesDir {
			return nil
		}
		dir := filepath.Dir(path)
		if filepath.Ext(path) != fileStoreYAMLExt {
			dirsWithBodies[dir] = true
			return nil
		}
		examplesByDir[dir] = append(examplesByDir[dir], path)
		return nil
	})
	if err != nil {
		return paths, err
	}
	for dir := range dirsWithBodies {
		for _, path := range examplesByDir[dir] {
			var example filesystemExampleFile
			if err := readYAMLFile(path, &example); err != nil || example.Version != fileStoreVersion || stringValue(example.Example, "id") == "" {
				continue
			}
			body := stringValue(exampleResponseMap(example.Example), "bodyFile")
			if body != "" && body == filepath.Base(body) {
				paths[filepath.Join(dir, body)] = struct{}{}
			}
		}
	}
	return paths, nil
}
