package api

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func (s *mcpServer) toolStartMock(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Collection      string `json:"collection"`
		Port            int    `json:"port"`
		SimulateLatency bool   `json:"simulateLatency"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	if args.Port < 0 || args.Port > 65535 {
		return nil, fmt.Errorf("port must be between 1 and 65535 or omitted")
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	var collection cliCollection
	for _, item := range ws.collections {
		if args.Collection != "" && loadCLICollectionMatches(item, args.Collection) {
			if collection.ID != "" {
				return nil, fmt.Errorf("collection %q is ambiguous; use its ID", args.Collection)
			}
			collection = item
		}
	}
	if collection.ID == "" {
		return nil, fmt.Errorf("collection %q was not found", args.Collection)
	}
	config := model.MockServerConfig{CollectionID: collection.ID, CollectionName: collection.Name, Port: args.Port, SimulateLatency: args.SimulateLatency}
	for _, req := range ws.requests {
		if req.CollectionID != collection.ID {
			continue
		}
		for _, example := range req.Examples {
			config.Routes = append(config.Routes, mockRouteFromExample(req.ID, mcpRequestLabel(req), req.Method, example))
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	status := s.executionApp.mock.startScoped(config, s.executionApp.emitMockRequest, ws.collectionScope())
	if status.Error != "" {
		return nil, fmt.Errorf("%s", status.Error)
	}
	return status, nil
}

func (s *mcpServer) toolStopMock(_ context.Context, _ json.RawMessage) (any, error) {
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	status := s.executionApp.mock.stopScoped(ws.collectionScope())
	if status.Error != "" {
		return nil, fmt.Errorf("%s", status.Error)
	}
	return status, nil
}

func (s *mcpServer) toolMockLog(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Limit int `json:"limit"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	if args.Limit < 0 || args.Limit > 200 {
		return nil, fmt.Errorf("limit must be between 1 and 200")
	}
	limit := args.Limit
	if limit == 0 {
		limit = 25
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	status, entries := s.executionApp.mock.logSnapshot(ws.collectionScope())
	if status.Error != "" {
		return nil, fmt.Errorf("%s", status.Error)
	}
	entries = entries[max(0, len(entries)-limit):]
	secrets := agentActivitySecrets()
	for i := range entries {
		entries[i].Path = redactSecrets(entries[i].Path, secrets)
		entries[i].Query = redactSecrets(entries[i].Query, secrets)
	}
	return map[string]any{"status": status, "entries": entries}, nil
}
