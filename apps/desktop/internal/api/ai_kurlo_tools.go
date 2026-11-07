package api

import (
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type aiRequestKurloTools struct {
	*agentToolBridge
}

func newAiRequestKurloTools(opts mcpServerOptions, sessionID string) aiRequestKurloTools {
	opts.readOnly = true
	opts.loadAppSecrets = true
	bridge := newAgentToolBridge(opts, sessionID, nil)
	bridge.server.client = model.AiRequestClientName
	return aiRequestKurloTools{agentToolBridge: bridge}
}

func (a *App) aiRequestKurloTools(req model.AiRequest) aiRequestKurloTools {
	tools := newAiRequestKurloTools(mcpServerOptions{workspace: fileWorkspaceStorePath(), env: strings.TrimSpace(req.KurloEnvironment)}, req.HTTP.RequestID)
	if a.mock != nil {
		tools.server.executionApp = a
	}
	if a.cookieJars != nil {
		tools.server.jars = a.cookieJars
	}
	return tools
}

func (t aiRequestKurloTools) tools() []aiTool {
	all := t.agentToolBridge.tools()
	out := all[:0:0]
	for _, tool := range all {
		if tool.Original == agentPlanTool || tool.Original == agentNotesTool {
			continue
		}
		out = append(out, tool)
	}
	return out
}
