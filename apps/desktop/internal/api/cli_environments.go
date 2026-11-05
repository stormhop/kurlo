package api

import "strings"

func cliEnvironmentChain(environments []cliEnvironment, index int) []cliEnvironment {
	byID := make(map[string]int, len(environments))
	for i, env := range environments {
		if env.ID != "" {
			byID[env.ID] = i
		}
	}
	chain := []cliEnvironment{}
	seen := map[string]bool{}
	current := index
	workspaceID := environments[index].WorkspaceID
	for {
		env := environments[current]
		if seen[env.ID] || env.WorkspaceID != workspaceID {
			break
		}
		chain = append(chain, env)
		seen[env.ID] = true
		next, ok := byID[strings.TrimSpace(env.ParentID)]
		if !ok {
			break
		}
		current = next
	}
	return chain
}

func flattenCLIEnvironments(environments []cliEnvironment) []cliEnvironment {
	out := make([]cliEnvironment, len(environments))
	for i := range environments {
		chain := cliEnvironmentChain(environments, i)
		env := environments[i]
		if len(chain) > 1 {
			env.Values = flattenedCLIEnvironmentRows(chain)
			if parent := chain[1]; parent.Name != "" {
				env.Parent = parent.Name
			}
		}
		for _, ancestor := range chain {
			if ancestor.Protected {
				env.Protected = true
			}
		}
		out[i] = env
	}
	return out
}

func flattenedCLIEnvironmentRows(chain []cliEnvironment) []cliKV {
	own := map[string]bool{}
	for _, row := range chain[0].Values {
		if key := strings.TrimSpace(row.Key); row.Enabled && key != "" {
			own[key] = true
		}
	}
	inherited := map[string]cliKV{}
	order := []string{}
	for i := len(chain) - 1; i >= 1; i-- {
		for _, row := range chain[i].Values {
			key := strings.TrimSpace(row.Key)
			if !row.Enabled || key == "" || own[key] {
				continue
			}
			if _, ok := inherited[key]; !ok {
				order = append(order, key)
			}
			inherited[key] = row
		}
	}
	rows := make([]cliKV, 0, len(order))
	for _, key := range order {
		rows = append(rows, inherited[key])
	}
	return append(rows, chain[0].Values...)
}

func rawEnvironmentAncestors(environments []map[string]any, environment map[string]any) []map[string]any {
	ancestors := []map[string]any{}
	seen := map[string]bool{stringValue(environment, "id"): true}
	workspaceID := stringValue(environment, "workspaceId")
	parentID := strings.TrimSpace(stringValue(environment, "parentId"))
	for parentID != "" && !seen[parentID] {
		var parent map[string]any
		for _, candidate := range environments {
			if stringValue(candidate, "id") == parentID {
				parent = candidate
				break
			}
		}
		if parent == nil || stringValue(parent, "workspaceId") != workspaceID {
			break
		}
		ancestors = append(ancestors, parent)
		seen[parentID] = true
		parentID = strings.TrimSpace(stringValue(parent, "parentId"))
	}
	return ancestors
}

func rawEnvironmentRow(environment map[string]any, key string) (map[string]any, bool) {
	rows, _ := environment["values"].([]any)
	var found map[string]any
	for _, raw := range rows {
		row, ok := raw.(map[string]any)
		if ok && boolValue(row["enabled"]) && strings.TrimSpace(stringValue(row, "key")) == key {
			found = row
		}
	}
	return found, found != nil
}
