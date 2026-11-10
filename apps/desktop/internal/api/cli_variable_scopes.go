package api

import "github.com/stormhop/kurlo/apps/desktop/internal/api/state"

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
	return values
}

func applyCLICollectionUpdates(sm *state.Manager, collectionID string, updates map[string]string, removed []string) {
	if collectionID == "" || (len(updates) == 0 && len(removed) == 0) {
		return
	}
	sm.ApplyCollectionVariableChanges(collectionID, updates, removed)
}
