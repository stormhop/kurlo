package api

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type mcpGlobalsEdit struct {
	before []map[string]any
	rows   []map[string]any
}

func mcpProfileForWorkspace(root string) (map[string]any, error) {
	if workspaceLockKey(root) != workspaceLockKey(fileWorkspaceStorePath()) {
		return nil, fmt.Errorf("globals belong to the local Kurlo profile; open this workspace in Kurlo before accessing them")
	}
	profile, _, err := loadLocalRequestStore(requestStorePath())
	return profile, err
}

func mcpPublicGlobals(rows []map[string]any) []map[string]any {
	result := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		if strings.TrimSpace(stringValue(row, "key")) == "" {
			continue
		}
		public := cloneMap(row)
		maskMCPWorkspaceValue(public, nil)
		delete(public, "id")
		result = append(result, public)
	}
	return result
}

func (s *mcpServer) toolListGlobals(_ context.Context, _ json.RawMessage) (any, error) {
	profile, err := mcpProfileForWorkspace(s.opts.workspace)
	if err != nil {
		return nil, err
	}
	return map[string]any{"globals": mcpPublicGlobals(mapSlice(profile["globals"]))}, nil
}

func mcpEditGlobal(st *mcpStore, arguments json.RawMessage) (func() any, error) {
	var args struct {
		Key    string  `json:"key"`
		Name   *string `json:"name"`
		Value  *string `json:"value"`
		Delete bool    `json:"delete"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	key := strings.TrimSpace(args.Key)
	if key == "" || (args.Delete && (args.Name != nil || args.Value != nil)) || (!args.Delete && args.Name == nil && args.Value == nil) {
		return nil, fmt.Errorf("pass a key and a value, a new name, or delete: true")
	}
	if args.Value != nil {
		if err := validateMCPWorkspaceInput(*args.Value); err != nil {
			return nil, err
		}
	}
	if st.globals == nil {
		profile, err := mcpProfileForWorkspace(st.root)
		if err != nil {
			return nil, err
		}
		rows := mapSlice(profile["globals"])
		st.globals = &mcpGlobalsEdit{before: rows, rows: mapSlice(cloneMap(map[string]any{"globals": rows})["globals"])}
	}
	edit := st.globals
	index, maxID := -1, 0
	for i, row := range edit.rows {
		if strings.TrimSpace(stringValue(row, "key")) == key {
			if index >= 0 {
				return nil, fmt.Errorf("more than one global is named %q", key)
			}
			index = i
		}
		if id, err := strconv.Atoi(rowIDValue(row)); err == nil {
			maxID = max(maxID, id)
		}
	}
	if index >= 0 && boolValue(edit.rows[index]["secret"]) {
		return nil, fmt.Errorf("edit secret globals in Kurlo")
	}
	if args.Delete || args.Name != nil {
		if index < 0 {
			return nil, fmt.Errorf("no global named %q", key)
		}
	}
	if args.Delete {
		edit.rows = slices.Delete(edit.rows, index, index+1)
	} else {
		if args.Name != nil {
			name := strings.TrimSpace(*args.Name)
			if name == "" {
				return nil, fmt.Errorf("global name is required")
			}
			for i, row := range edit.rows {
				if i != index && strings.TrimSpace(stringValue(row, "key")) == name {
					return nil, fmt.Errorf("a global named %q already exists", name)
				}
			}
			key = name
		}
		if index < 0 {
			index = len(edit.rows)
			edit.rows = append(edit.rows, map[string]any{"id": maxID + 1, "enabled": true})
		}
		row := edit.rows[index]
		row["key"] = key
		if args.Value != nil {
			row["value"] = *args.Value
		}
	}
	return func() any { return map[string]any{"key": key, "deleted": args.Delete} }, nil
}

func (edit *mcpGlobalsEdit) change() []model.AgentFileChange {
	if edit == nil || reflect.DeepEqual(edit.before, edit.rows) {
		return nil
	}
	before, _ := json.MarshalIndent(mcpPublicGlobals(edit.before), "", "  ")
	after, _ := json.MarshalIndent(mcpPublicGlobals(edit.rows), "", "  ")
	return diffWorkspaceFiles(map[string][]byte{"Profile globals": before}, map[string][]byte{"Profile globals": after})
}

func (edit *mcpGlobalsEdit) updatedProfile(root string) (string, string, error) {
	profile, err := mcpProfileForWorkspace(root)
	if err != nil {
		return "", "", err
	}
	if !reflect.DeepEqual(mapSlice(profile["globals"]), edit.before) {
		return "", "", fmt.Errorf("globals changed while waiting for approval; try again")
	}
	before, err := json.Marshal(profile)
	if err != nil {
		return "", "", err
	}
	profile["globals"] = edit.rows
	profile[profileGlobalsRevisionField] = uuid.NewString()
	data, err := json.Marshal(profile)
	return string(before), string(data), err
}

func mcpGlobalValues(root string, includeSecrets bool) (map[string]string, []string) {
	values := map[string]string{}
	var secrets []string
	profile, err := mcpProfileForWorkspace(root)
	if err != nil {
		return values, secrets
	}
	for _, row := range mapSlice(profile["globals"]) {
		if key := strings.TrimSpace(stringValue(row, "key")); key != "" && boolValue(row["enabled"]) {
			if boolValue(row["secret"]) && !includeSecrets {
				continue
			}
			value := stringValue(row, "value")
			values[key] = value
			if value != "" && boolValue(row["secret"]) {
				secrets = append(secrets, value)
			}
		}
	}
	return values, secrets
}

const profileGlobalsRevisionField = "globalsRevision"

func profileGlobalsRevision(payload string) string {
	var profile struct {
		Revision string `json:"globalsRevision"`
	}
	_ = json.Unmarshal([]byte(payload), &profile)
	return profile.Revision
}

func currentProfileGlobalsRevision() string {
	payload, _ := loadRequestStorePayload(requestStorePath())
	return profileGlobalsRevision(payload)
}
