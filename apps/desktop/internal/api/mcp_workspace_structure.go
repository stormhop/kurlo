package api

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/google/uuid"
)

func mcpMoveFolder(st *mcpStore, arguments json.RawMessage) (func() any, error) {
	return mcpTransferFolder(st, arguments, false)
}

func mcpDuplicateFolder(st *mcpStore, arguments json.RawMessage) (func() any, error) {
	return mcpTransferFolder(st, arguments, true)
}

func mcpTransferFolder(st *mcpStore, arguments json.RawMessage, duplicate bool) (func() any, error) {
	var args struct {
		Collection       string `json:"collection"`
		TargetCollection string `json:"targetCollection"`
		From             string `json:"from"`
		To               string `json:"to"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	source, err := st.collection(args.Collection)
	if err != nil {
		return nil, err
	}
	target := source
	if args.TargetCollection != "" {
		target, err = st.collection(args.TargetCollection)
		if err != nil {
			return nil, err
		}
	}
	sourceID, targetID := stringValue(source, "id"), stringValue(target, "id")
	same := sourceID == targetID
	from, to := mcpSplitFolder(args.From), mcpSplitFolder(args.To)
	if len(from) == 0 || len(to) == 0 || (same && (slices.Equal(from, to) || (folderPrefixMatches(to, from) && (duplicate || len(to) > len(from))))) {
		return nil, fmt.Errorf("pass distinct non-empty paths; a folder cannot be moved or copied into itself")
	}
	targetPaths, _ := target["folderPaths"].([]any)
	for _, raw := range targetPaths {
		folder := mcpFolderPath(raw)
		if folderPrefixMatches(folder, to) && (!same || duplicate || !folderPrefixMatches(folder, from)) {
			return nil, fmt.Errorf("the destination folder already exists")
		}
	}
	replacePath := func(folder []string) []string {
		return append(slices.Clone(to), folder[len(from):]...)
	}
	sourcePaths, _ := source["folderPaths"].([]any)
	var kept, transferred []any
	for _, raw := range sourcePaths {
		folder := mcpFolderPath(raw)
		if !folderPrefixMatches(folder, from) {
			kept = append(kept, raw)
			continue
		}
		transferred = append(transferred, replacePath(folder))
	}
	if len(transferred) == 0 {
		return nil, fmt.Errorf("source folder does not exist")
	}
	if !duplicate {
		source["folderPaths"] = kept
		if same {
			targetPaths = kept
		}
	}
	target["folderPaths"] = append(targetPaths, transferred...)
	for _, raw := range transferred {
		mcpEnsureFolder(target, mcpFolderPath(raw))
	}

	var keptDefaults, transferredDefaults []any
	for _, defaults := range collectionFolderDefaults(source) {
		folder := mcpFolderPath(defaults["path"])
		if !folderPrefixMatches(folder, from) {
			keptDefaults = append(keptDefaults, defaults)
			continue
		}
		if duplicate || !same {
			if err := validateMCPWorkspaceInput(defaults); err != nil {
				return nil, fmt.Errorf("transfer folder defaults with saved secrets in Kurlo: %w", err)
			}
		}
		next := cloneMap(defaults)
		next["path"] = replacePath(folder)
		if duplicate {
			next["id"] = uuid.NewString()
		}
		transferredDefaults = append(transferredDefaults, next)
	}
	if len(transferredDefaults) > 0 {
		if !duplicate {
			source["folderDefaults"] = keptDefaults
		}
		targetDefaults, _ := target["folderDefaults"].([]any)
		target["folderDefaults"] = append(targetDefaults, transferredDefaults...)
	}
	for _, request := range st.requests {
		folder := mcpFolderPath(request["folderPath"])
		if stringValue(request, "collectionId") != sourceID || !folderPrefixMatches(folder, from) {
			continue
		}
		if duplicate {
			request, err = mcpCloneRequest(request)
			if err != nil {
				return nil, err
			}
			st.requests = append(st.requests, request)
		}
		request["collectionId"] = targetID
		request["folderPath"] = replacePath(folder)
	}
	return func() any { return map[string]any{"collection": targetID, "folder": strings.Join(to, "/")} }, nil
}

func mcpCreateEnvironment(st *mcpStore, arguments json.RawMessage) (func() any, error) {
	var args struct {
		Workspace string         `json:"workspace"`
		Name      string         `json:"name"`
		Patch     map[string]any `json:"patch"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	workspace, err := st.workspace(args.Workspace)
	if err != nil {
		return nil, err
	}
	environment := map[string]any{"id": "environment-" + uuid.NewString(), "workspaceId": stringValue(workspace, "id"), "name": args.Name}
	if err := mcpUpdateEnvironment(st, environment, args.Patch); err != nil {
		return nil, err
	}
	st.environments = append(st.environments, environment)
	return mcpEnvironmentResult(environment, false), nil
}

func mcpPatchEnvironment(st *mcpStore, arguments json.RawMessage) (func() any, error) {
	var args struct {
		Environment string         `json:"environment"`
		Patch       map[string]any `json:"patch"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	environment, err := mcpFindByName(st.environments, args.Environment, "environment")
	if err != nil {
		return nil, err
	}
	if args.Patch == nil {
		return nil, fmt.Errorf("patch must be a JSON object")
	}
	if err := mcpUpdateEnvironment(st, environment, args.Patch); err != nil {
		return nil, err
	}
	return mcpEnvironmentResult(environment, false), nil
}

func mcpEnvironmentResult(environment map[string]any, deleted bool) func() any {
	return func() any {
		return map[string]any{"id": stringValue(environment, "id"), "name": stringValue(environment, "name"), "deleted": deleted}
	}
}

func mcpEditableEnvironment(st *mcpStore, environment map[string]any) error {
	chain := append(rawEnvironmentAncestors(st.environments, environment), environment)
	for _, item := range chain {
		if boolValue(item["protected"]) {
			return fmt.Errorf("environment %s is protected; change it in Kurlo", stringValue(item, "name"))
		}
	}
	return nil
}

func mcpUpdateEnvironment(st *mcpStore, environment, patch map[string]any) error {
	if err := mcpEditableEnvironment(st, environment); err != nil {
		return err
	}
	for key := range patch {
		switch key {
		case "name", "parentId", "values":
		default:
			return fmt.Errorf("environment field %s is not editable by this operation", key)
		}
	}
	if _, editsValues := patch["values"]; editsValues {
		for _, row := range mapSlice(environment["values"]) {
			if boolValue(row["secret"]) {
				return fmt.Errorf("this environment contains secret rows; use set_variable for individual non-secret values")
			}
		}
	}
	if err := validateMCPWorkspaceInput(patch); err != nil {
		return err
	}
	mcpMergePatch(environment, patch)
	id := stringValue(environment, "id")
	workspaceID := stringValue(environment, "workspaceId")
	name := strings.TrimSpace(stringValue(environment, "name"))
	if name == "" {
		return fmt.Errorf("environment name is required")
	}
	environment["name"] = name
	for _, candidate := range st.environments {
		if stringValue(candidate, "id") != id && stringValue(candidate, "workspaceId") == workspaceID && strings.EqualFold(stringValue(candidate, "name"), name) {
			return fmt.Errorf("an environment named %q already exists in this workspace", name)
		}
	}
	if parentID := stringValue(environment, "parentId"); parentID != "" {
		ancestors := rawEnvironmentAncestors(st.environments, environment)
		if len(ancestors) == 0 {
			return fmt.Errorf("parentId must identify an environment in this workspace")
		}
		if stringValue(ancestors[len(ancestors)-1], "parentId") != "" {
			return fmt.Errorf("environment inheritance must not contain a cycle")
		}
	}
	if err := mcpEditableEnvironment(st, environment); err != nil {
		return err
	}
	return validateWorkspaceFileContract("environment", environment)
}

func mcpDeleteEnvironment(st *mcpStore, arguments json.RawMessage) (func() any, error) {
	var args struct {
		Environment string `json:"environment"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	environment, err := mcpFindByName(st.environments, args.Environment, "environment")
	if err != nil {
		return nil, err
	}
	if err := mcpEditableEnvironment(st, environment); err != nil {
		return nil, err
	}
	id := stringValue(environment, "id")
	for _, candidate := range st.environments {
		if stringValue(candidate, "parentId") == id {
			return nil, fmt.Errorf("another environment inherits from this one; change its parent first")
		}
	}
	st.environments = slices.DeleteFunc(st.environments, func(candidate map[string]any) bool { return stringValue(candidate, "id") == id })
	return mcpEnvironmentResult(environment, true), nil
}
