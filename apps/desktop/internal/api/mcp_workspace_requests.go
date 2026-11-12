package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/google/uuid"
	"gopkg.in/yaml.v3"
)

func mcpMergePatch(target, patch map[string]any) {
	for key, value := range patch {
		switch value := value.(type) {
		case nil:
			delete(target, key)
		case map[string]any:
			existing, ok := target[key].(map[string]any)
			if !ok {
				existing = map[string]any{}
			}
			mcpMergePatch(existing, value)
			target[key] = existing
		default:
			target[key] = value
		}
	}
}

func validateMCPWorkspaceInput(value any) error {
	switch value := value.(type) {
	case map[string]any:
		key := strings.ToLower(strings.TrimSpace(stringValue(value, "key")))
		if (mcpSensitiveHeaders[key] || key == "x-api-key") && secretFieldNeedsVault(stringValue(value, "value")) {
			return fmt.Errorf("use a {{variable}} reference for %s", key)
		}
		for _, child := range value {
			if err := validateMCPWorkspaceInput(child); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range value {
			if err := validateMCPWorkspaceInput(child); err != nil {
				return err
			}
		}
	case string:
		if strings.Contains(value, "{{kurloSecret:") {
			return fmt.Errorf("use {{variable}} references instead of internal vault placeholders")
		}
	}
	return nil
}

func decodeMCPRequestYAML(content string) (map[string]any, error) {
	var doc filesystemRequestFile
	decoder := yaml.NewDecoder(strings.NewReader(content))
	if err := decoder.Decode(&doc); err != nil {
		return nil, fmt.Errorf("invalid request YAML: %w", err)
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, fmt.Errorf("pass one request YAML document")
	}
	request, ok := doc.Request.(map[string]any)
	if !ok || doc.Version != fileStoreVersion {
		return nil, fmt.Errorf("pass a workspace YAML document with version: %d and a request mapping", fileStoreVersion)
	}
	return request, validateMCPWorkspaceInput(request)
}

func (st *mcpStore) editRequestDocument(args mcpSaveRequestArgs) (func() any, error) {
	fields, err := decodeMCPRequestYAML(*args.YAML)
	if err != nil {
		return nil, err
	}
	ref := strings.TrimSpace(args.Request)
	var request map[string]any
	if ref == "" {
		request = map[string]any{"id": uuid.NewString()}
		if id, exists := fields["id"]; exists {
			request["id"] = id
		}
	} else {
		request, _, err = st.request(ref)
		if err != nil {
			return nil, err
		}
		if id, exists := fields["id"]; exists && id != request["id"] {
			return nil, fmt.Errorf("the YAML id must match the request being changed")
		}
	}
	if boolValue(fields["isDraft"]) {
		return nil, fmt.Errorf("save_request requires a saved request, not a draft")
	}
	delete(fields, "isDraft")
	delete(fields, "filesystemName")
	collectionRef := stringValue(fields, "collectionId")
	if args.Collection != nil {
		collectionRef = *args.Collection
	} else if collectionRef == "" {
		collectionRef = stringValue(request, "collectionId")
	}
	collection, err := st.collection(collectionRef)
	if err != nil {
		return nil, err
	}
	fields["collectionId"] = stringValue(collection, "id")
	if args.Folder != nil {
		fields["folderPath"] = mcpSplitFolder(*args.Folder)
	}
	result, err := st.patchRequestDocument(request, fields)
	if err != nil {
		return nil, err
	}
	if ref == "" {
		st.requests = append(st.requests, request)
	}
	return func() any {
		reply := result().(map[string]any)
		reply["created"] = ref == ""
		return reply
	}, nil
}

func (st *mcpStore) patchRequestDocument(request, fields map[string]any) (func() any, error) {
	for _, key := range []string{"filesystemName", "examples", "isDraft"} {
		if _, exists := fields[key]; exists {
			return nil, fmt.Errorf("%s is managed by Kurlo and cannot be edited here", key)
		}
	}
	mcpMergePatch(request, fields)
	if err := validateWorkspaceFileContract("request", request); err != nil {
		return nil, err
	}
	collection := st.collectionByID(stringValue(request, "collectionId"))
	if collection == nil {
		return nil, fmt.Errorf("collectionId must identify an existing collection")
	}
	mcpEnsureFolder(collection, mcpFolderPath(request["folderPath"]))
	if strings.TrimSpace(stringValue(request, "name")) == "" {
		request["name"] = defaultString(mcpDefaultRequestName(request), "Untitled request")
	}
	return func() any {
		return map[string]any{"id": stringValue(request, "id"), "path": st.requestPath(request), "file": st.requestFile(request)}
	}, nil
}

func mcpPatchRequest(st *mcpStore, arguments json.RawMessage) (func() any, error) {
	var args struct {
		Request string         `json:"request"`
		Patch   map[string]any `json:"patch"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	if args.Patch == nil {
		return nil, fmt.Errorf("patch must be a JSON object")
	}
	if _, exists := args.Patch["id"]; exists {
		return nil, fmt.Errorf("the request id cannot be changed")
	}
	if err := validateMCPWorkspaceInput(args.Patch); err != nil {
		return nil, err
	}
	request, _, err := st.request(args.Request)
	if err != nil {
		return nil, err
	}
	return st.patchRequestDocument(request, args.Patch)
}

func (s *mcpServer) toolPatchRequest(ctx context.Context, arguments json.RawMessage) (any, error) {
	return s.mutate(ctx, func(st *mcpStore) (func() any, error) {
		return mcpPatchRequest(st, arguments)
	})
}

func (s *mcpServer) getMCPRequestDocument(ref string) (any, error) {
	st, err := s.loadStore()
	if err != nil {
		return nil, err
	}
	request, _, err := st.request(ref)
	if err != nil {
		return nil, err
	}
	doc := cloneMap(request)
	for _, key := range []string{"filesystemName", "collection", "examples"} {
		delete(doc, key)
	}
	var secrets []string
	if s.opts.loadAppSecrets {
		secrets = agentActivitySecrets()
	}
	maskMCPWorkspaceValue(doc, secrets)
	data, err := marshalWorkspaceYAML(filesystemRequestFile{Version: fileStoreVersion, Request: doc})
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": stringValue(request, "id"), "path": st.requestPath(request), "yaml": string(data)}, nil
}

func maskMCPWorkspaceValue(value any, secrets []string) {
	switch value := value.(type) {
	case map[string]any:
		key := strings.ToLower(strings.TrimSpace(stringValue(value, "key")))
		if boolValue(value["secret"]) || mcpSensitiveHeaders[key] || key == "x-api-key" {
			if text := stringValue(value, "value"); secretFieldNeedsVault(text) || strings.Contains(text, "{{kurloSecret:") {
				delete(value, "value")
			}
		}
		for key, child := range value {
			if text, ok := child.(string); ok {
				if strings.Contains(text, "{{kurloSecret:") || (secretFieldNeedsVault(text) && (slices.Contains(requestAuthSecretFields, key) || slices.Contains(requestSettingSecretFields, key))) {
					delete(value, key)
					continue
				}
				value[key] = redactSecrets(text, secrets)
				continue
			}
			maskMCPWorkspaceValue(child, secrets)
		}
	case []any:
		for i, child := range value {
			if text, ok := child.(string); ok {
				if strings.Contains(text, "{{kurloSecret:") {
					value[i] = "[secret]"
				} else {
					value[i] = redactSecrets(text, secrets)
				}
				continue
			}
			maskMCPWorkspaceValue(child, secrets)
		}
	}
}
