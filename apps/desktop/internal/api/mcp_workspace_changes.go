package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

type mcpWorkspaceOperation struct {
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
}

func (s *mcpServer) toolApplyChanges(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Operations []mcpWorkspaceOperation `json:"operations"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	if len(args.Operations) == 0 || len(args.Operations) > 50 {
		return nil, fmt.Errorf("pass between 1 and 50 workspace operations")
	}
	return s.mutate(ctx, func(st *mcpStore) (func() any, error) {
		st.batch = true
		results := make([]func() any, 0, len(args.Operations))
		for i, operation := range args.Operations {
			result, err := s.applyWorkspaceOperation(st, operation)
			if err != nil {
				return nil, fmt.Errorf("operation %d (%s): %w", i+1, operation.Tool, err)
			}
			results = append(results, result)
		}
		return func() any {
			output := make([]any, 0, len(results))
			for _, result := range results {
				output = append(output, result())
			}
			return map[string]any{"results": output}
		}, nil
	})
}

func (s *mcpServer) applyWorkspaceOperation(st *mcpStore, operation mcpWorkspaceOperation) (func() any, error) {
	switch operation.Tool {
	case "save_example":
		return s.editSaveExample(st, operation.Arguments)
	case "set_variable":
		return s.editSetVariable(st, operation.Arguments)
	}
	if apply := mcpWorkspaceOperations[operation.Tool]; apply != nil {
		return apply(st, operation.Arguments)
	}
	return nil, fmt.Errorf("%q is not a supported workspace edit", operation.Tool)
}

var mcpWorkspaceOperations = map[string]func(*mcpStore, json.RawMessage) (func() any, error){
	"create_collection": editCreateCollection,
	"save_request": func(st *mcpStore, arguments json.RawMessage) (func() any, error) {
		var args mcpSaveRequestArgs
		if err := mcpDecodeArguments(arguments, &args); err != nil {
			return nil, err
		}
		return mcpSaveRequest(st, args)
	},
	"patch_request":        mcpPatchRequest,
	"delete_request":       mcpDeleteRequest,
	"duplicate_request":    mcpDuplicateRequest,
	"patch_collection":     mcpPatchCollection,
	"patch_example":        mcpPatchExample,
	"delete_example":       mcpDeleteExample,
	"move_folder":          mcpMoveFolder,
	"duplicate_folder":     mcpDuplicateFolder,
	"duplicate_collection": mcpDuplicateCollection,
	"create_environment":   mcpCreateEnvironment,
	"patch_environment":    mcpPatchEnvironment,
	"delete_environment":   mcpDeleteEnvironment,
	"edit_global":          mcpEditGlobal,
}

func mcpDuplicateRequest(st *mcpStore, arguments json.RawMessage) (func() any, error) {
	var args struct {
		Request string         `json:"request"`
		Patch   map[string]any `json:"patch"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	source, _, err := st.request(args.Request)
	if err != nil {
		return nil, err
	}
	request, err := mcpCloneRequest(source)
	if err != nil {
		return nil, err
	}
	if _, exists := args.Patch["id"]; exists {
		return nil, fmt.Errorf("Kurlo assigns the new request id")
	}
	if err := validateMCPWorkspaceInput(args.Patch); err != nil {
		return nil, err
	}
	request["name"] = stringValue(source, "name") + " copy"
	result, err := st.patchRequestDocument(request, args.Patch)
	if err != nil {
		return nil, err
	}
	st.requests = append(st.requests, request)
	return result, nil
}

func mcpCloneRequest(source map[string]any) (map[string]any, error) {
	request := cloneMap(source)
	for _, key := range []string{"filesystemName", "collection", "isDraft"} {
		delete(request, key)
	}
	if err := validateMCPWorkspaceInput(request); err != nil {
		return nil, fmt.Errorf("duplicate requests containing saved secrets in Kurlo: %w", err)
	}
	id := uuid.NewString()
	request["id"] = id
	for _, example := range mapSlice(request["examples"]) {
		example["id"] = "example-" + uuid.NewString()
		example["requestId"] = id
		delete(example, "filesystemName")
	}
	return request, nil
}

func mcpDuplicateCollection(st *mcpStore, arguments json.RawMessage) (func() any, error) {
	var args struct {
		Collection string `json:"collection"`
		Name       string `json:"name"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	source, err := st.collection(args.Collection)
	if err != nil {
		return nil, err
	}
	name := defaultString(strings.TrimSpace(args.Name), stringValue(source, "name")+" copy")
	for _, existing := range st.collections {
		if stringValue(existing, "workspaceId") == stringValue(source, "workspaceId") && strings.EqualFold(stringValue(existing, "name"), name) {
			return nil, fmt.Errorf("a collection named %q already exists", name)
		}
	}
	collection := cloneMap(source)
	for _, key := range []string{"filesystemName", "loadTests"} {
		delete(collection, key)
	}
	if err := validateMCPWorkspaceInput(collection); err != nil {
		return nil, fmt.Errorf("duplicate collections containing saved secrets in Kurlo: %w", err)
	}
	id := "collection-" + uuid.NewString()
	collection["id"] = id
	collection["name"] = name
	for _, defaults := range collectionFolderDefaults(collection) {
		defaults["id"] = uuid.NewString()
	}
	for _, request := range st.requests {
		if stringValue(request, "collectionId") != stringValue(source, "id") {
			continue
		}
		copy, err := mcpCloneRequest(request)
		if err != nil {
			return nil, err
		}
		copy["collectionId"] = id
		st.requests = append(st.requests, copy)
	}
	st.collections = append(st.collections, collection)
	return func() any { return map[string]any{"id": id, "name": name, "file": st.collectionDir(collection)} }, nil
}

func mcpPatchCollection(st *mcpStore, arguments json.RawMessage) (func() any, error) {
	var args struct {
		Collection string         `json:"collection"`
		Patch      map[string]any `json:"patch"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	if args.Patch == nil {
		return nil, fmt.Errorf("patch must be a JSON object")
	}
	for key := range args.Patch {
		switch key {
		case "name", "description", "defaults", "folderPaths", "folderDefaults":
		default:
			return nil, fmt.Errorf("collection field %s is not editable by this operation", key)
		}
	}
	if err := validateMCPWorkspaceInput(args.Patch); err != nil {
		return nil, err
	}
	collection, err := st.collection(args.Collection)
	if err != nil {
		return nil, err
	}
	mcpMergePatch(collection, args.Patch)
	if err := validateWorkspaceFileContract("collection", collection); err != nil {
		return nil, err
	}
	if strings.TrimSpace(stringValue(collection, "name")) == "" {
		return nil, fmt.Errorf("collection name is required")
	}
	for _, request := range st.requests {
		if stringValue(request, "collectionId") == stringValue(collection, "id") {
			mcpEnsureFolder(collection, mcpFolderPath(request["folderPath"]))
		}
	}
	return func() any {
		return map[string]any{"id": stringValue(collection, "id"), "name": stringValue(collection, "name")}
	}, nil
}

func mcpPatchExample(st *mcpStore, arguments json.RawMessage) (func() any, error) {
	return mcpEditExample(st, arguments, false)
}

func mcpDeleteExample(st *mcpStore, arguments json.RawMessage) (func() any, error) {
	return mcpEditExample(st, arguments, true)
}

func mcpEditExample(st *mcpStore, arguments json.RawMessage, remove bool) (func() any, error) {
	var args struct {
		Request string         `json:"request"`
		Example string         `json:"example"`
		Patch   map[string]any `json:"patch"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	request, _, err := st.request(args.Request)
	if err != nil {
		return nil, err
	}
	examples := mapSlice(request["examples"])
	example, err := mcpFindByName(examples, args.Example, "example")
	if err != nil {
		return nil, err
	}
	id := stringValue(example, "id")
	if remove {
		for i, item := range examples {
			if stringValue(item, "id") == id {
				request["examples"] = append(examples[:i:i], examples[i+1:]...)
				break
			}
		}
	} else {
		if args.Patch == nil {
			return nil, fmt.Errorf("patch must be a JSON object")
		}
		for _, key := range []string{"id", "requestId", "filesystemName"} {
			if _, exists := args.Patch[key]; exists {
				return nil, fmt.Errorf("example field %s cannot be changed", key)
			}
		}
		if err := validateMCPWorkspaceInput(args.Patch); err != nil {
			return nil, err
		}
		mcpMergePatch(example, args.Patch)
		if err := validateWorkspaceFileContract("example", example); err != nil {
			return nil, err
		}
	}
	return func() any { return map[string]any{"id": id, "deleted": remove} }, nil
}
