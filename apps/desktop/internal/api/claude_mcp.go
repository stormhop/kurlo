package api

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
)

func startClaudeMCP(ctx context.Context, bridge *agentToolBridge) (string, func(), error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	path := "/mcp/" + uuid.NewString()
	handler := claudeMCPHandler(bridge)
	server := &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != path {
				http.NotFound(w, r)
				return
			}
			handler.ServeHTTP(w, r)
		}),
	}
	var once sync.Once
	closeServer := func() {
		once.Do(func() {
			cancel()
			_ = listener.Close()
			_ = server.Close()
		})
	}
	stop := context.AfterFunc(ctx, closeServer)
	go func() { _ = server.Serve(listener) }()
	return "http://" + listener.Addr().String() + path, func() {
		stop()
		closeServer()
	}, nil
}

func claudeMCPHandler(bridge *agentToolBridge) http.Handler {
	tools := map[string]aiTool{}
	for _, tool := range bridge.tools() {
		tools[tool.Original] = tool
	}
	callSlot := make(chan struct{}, 1)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if r.Header.Get("Origin") != "" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		var request struct {
			Version string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Method  string          `json:"method"`
			Params  json.RawMessage `json:"params"`
		}
		body := http.MaxBytesReader(w, r.Body, 1024*1024)
		if err := json.NewDecoder(body).Decode(&request); err != nil || request.Version != "2.0" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if len(request.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		reply := map[string]any{"jsonrpc": "2.0", "id": request.ID}
		switch request.Method {
		case "initialize":
			reply["result"] = bridge.server.initializeResult(request.Params)
		case "ping":
			reply["result"] = map[string]any{}
		case "tools/list":
			reply["result"] = map[string]any{
				"tools": mcpServerTools(bridge.server.opts.readOnly), "ttlMs": mcpServerListTTLMs, "cacheScope": "private",
			}
		case "tools/call":
			var params struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			if err := json.Unmarshal(request.Params, &params); err != nil {
				reply["error"] = map[string]any{"code": -32602, "message": "Invalid tool arguments"}
				break
			}
			tool, ok := tools[params.Name]
			if !ok {
				reply["error"] = map[string]any{"code": -32602, "message": "Unknown Kurlo tool"}
				break
			}
			select {
			case callSlot <- struct{}{}:
				defer func() { <-callSlot }()
			case <-r.Context().Done():
				return
			}
			if r.Context().Err() != nil {
				return
			}
			result, failed := bridge.call(r.Context(), tool, string(params.Arguments), uuid.NewString())
			reply["result"] = mcpToolText(result, failed)
		default:
			reply["error"] = map[string]any{"code": -32601, "message": "Method not found"}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(reply)
	})
}
