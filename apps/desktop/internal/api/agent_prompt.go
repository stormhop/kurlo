package api

import (
	"fmt"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const agentPromptListLimit = 40

var agentCommonTasks = []string{
	"Why did my request fail? Read the failed history entry with diagnose_last_failure and propose one fix.",
	"Run a collection and explain every failure, with a fix for each; change nothing until the user agrees.",
	"Cover an endpoint: save a request with {{baseUrl}} and {{variables}}, write tests with generate_tests and save example responses; ask for anything you cannot infer.",
	"Write tests for a saved request from a real response with generate_tests.",
}

func agentWorkspaceSummary(s *mcpServer) []string {
	ws, err := s.loadWorkspace()
	if err != nil {
		return []string{"- Kurlo could not read the workspace: " + err.Error()}
	}
	counts := map[string]int{}
	for _, req := range ws.requests {
		counts[req.CollectionID]++
	}
	var lines []string
	if len(ws.collections) == 0 {
		lines = append(lines, "- Collections: none yet.")
	} else {
		lines = append(lines, "- Collections:")
		for index, collection := range ws.collections {
			if index == agentPromptListLimit {
				lines = append(lines, fmt.Sprintf("  - and %d more; call list_requests to see them.", len(ws.collections)-index))
				break
			}
			lines = append(lines, fmt.Sprintf("  - %s (%d requests)", collection.Name, counts[collection.ID]))
		}
	}
	if len(ws.environments) == 0 {
		lines = append(lines, "- Environments: none yet.")
	} else {
		names := make([]string, 0, len(ws.environments))
		for index, env := range ws.environments {
			if index == agentPromptListLimit {
				names = append(names, fmt.Sprintf("and %d more", len(ws.environments)-index))
				break
			}
			name := env.Name
			if env.Protected {
				name += " (protected)"
			}
			names = append(names, name)
		}
		lines = append(lines, "- Environments: "+strings.Join(names, ", "))
	}
	return lines
}

func agentSystemPrompt(s *mcpServer, chat model.AgentChat) string {
	lines := []string{
		"You are the Kurlo agent. You work inside Kurlo, an API client, on the user's workspace at " + s.opts.workspace + ". Kurlo's tools let you read, run and change its saved requests, collections and environments.",
		"",
		"Rules:",
		"- Look before you act: call list_requests or get_request before you run or change a request you have not seen.",
		"- Reading tools and requests that only send GET, HEAD or OPTIONS run at once. Requests with other methods and every change to the workspace files wait for the user's approval in the chat. When the user declines, do not repeat the call: ask what they want instead.",
		"- Never write a secret into the workspace: use a {{variable}} and ask the user to set the value in Kurlo. Secret values show as [secret].",
		"- Protected environments are not available to you; ask the user to run those requests in Kurlo.",
		"- Never point an environment at production unless the user asks for it.",
		"- When a request fails, find out why with diagnose_last_failure, get_history_entry or the test results before you guess.",
		"- Keep answers short. After a change, say what changed and in which request or environment.",
		"",
		"Workspace:",
	}
	lines = append(lines, agentWorkspaceSummary(s)...)
	if collection := strings.TrimSpace(chat.Collection); collection != "" {
		lines = append(lines, "- The user chose the collection "+collection+": work in it unless they name another.")
	}
	if env := strings.TrimSpace(chat.Environment); env != "" {
		lines = append(lines, "- The user chose the environment "+env+": tool calls use it unless they name another.")
	}
	lines = append(lines, "", "Common tasks:")
	for _, task := range agentCommonTasks {
		lines = append(lines, "- "+task)
	}
	return strings.Join(lines, "\n")
}
