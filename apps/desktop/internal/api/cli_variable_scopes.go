package api

import (
	"regexp"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func cliRequestCollectionScope(req cliSavedRequest, sm *state.Manager) cliSavedRequest {
	if req.CollectionID == "" {
		return req
	}
	req.CollectionVariables = sm.EnsureCollectionVariables(req.CollectionID, req.CollectionVariables)
	return req
}

func cliRequestValues(req cliSavedRequest, sm *state.Manager) map[string]string {
	req = cliRequestCollectionScope(req, sm)
	values := sm.GetVariables()
	for key, value := range req.CollectionVariables {
		values[key] = value
	}
	for key, value := range sm.GetEnvironment() {
		values[key] = value
	}
	for key, value := range cliRequestVariableValues(req.Vars, values) {
		values[key] = value
	}
	return values
}

var requestVariableReference = regexp.MustCompile(`\{\{([^{}]*)\}\}`)

func substituteKnownVariables(value string, values map[string]string) string {
	for depth := 0; depth < 20 && strings.Contains(value, "{{"); depth++ {
		next := requestVariableReference.ReplaceAllStringFunc(value, func(match string) string {
			key := strings.TrimSpace(match[2 : len(match)-2])
			if resolved, ok := values[key]; ok && key != "" {
				return resolved
			}
			return match
		})
		if next == value {
			break
		}
		value = next
	}
	return value
}

func cliRequestVariableValues(rows []cliKV, scope map[string]string) map[string]string {
	if len(rows) == 0 {
		return nil
	}
	lookup := make(map[string]string, len(scope)+len(rows))
	for key, value := range scope {
		lookup[key] = value
	}
	out := make(map[string]string, len(rows))
	for _, row := range rows {
		key := strings.TrimSpace(row.Key)
		if !row.Enabled || key == "" {
			continue
		}
		value := substituteKnownVariables(row.Value, lookup)
		out[key] = value
		lookup[key] = value
	}
	return out
}

func cliRequestVariablesForSend(rows []cliKV, values map[string]string) map[string]string {
	var out map[string]string
	for _, row := range rows {
		key := strings.TrimSpace(row.Key)
		if !row.Enabled || key == "" {
			continue
		}
		if value, ok := values[key]; ok {
			if out == nil {
				out = make(map[string]string)
			}
			out[key] = value
		}
	}
	return out
}

func cliRequestVariableSecrets(rows []cliKV) []string {
	var out []string
	for _, row := range rows {
		if row.Enabled && row.Secret && row.Value != "" {
			out = append(out, row.Value)
		}
	}
	return out
}

func cliPostResponseVars(rows []cliKV) []model.KeyValue {
	var out []model.KeyValue
	for _, row := range rows {
		key := strings.TrimSpace(row.Key)
		if row.Enabled && key != "" && strings.TrimSpace(row.Value) != "" {
			out = append(out, model.KeyValue{Key: key, Value: row.Value, Enabled: true})
		}
	}
	return out
}

func applyCLICollectionUpdates(sm *state.Manager, collectionID string, updates map[string]string, removed []string) {
	if collectionID == "" || (len(updates) == 0 && len(removed) == 0) {
		return
	}
	sm.ApplyCollectionVariableChanges(collectionID, updates, removed)
}
