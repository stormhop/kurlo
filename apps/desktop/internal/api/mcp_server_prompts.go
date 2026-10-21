package api

import (
	"encoding/json"
	"fmt"
	"strings"
)

type mcpPromptArgument struct {
	name        string
	description string
	required    bool
}

type mcpPrompt struct {
	name        string
	title       string
	description string
	arguments   []mcpPromptArgument
	writes      bool
	render      func(args map[string]string) string
}

func mcpServerPrompts(readOnly bool) []mcpPrompt {
	prompts := []mcpPrompt{
		{
			name:        "sync_collection",
			title:       "Sync the collection with the code",
			description: "Find the HTTP routes in this project's code and add a saved request with tests for each one the Kurlo collection is missing.",
			arguments: []mcpPromptArgument{
				{name: "collection", description: "Collection to keep in sync. Defaults to the only one, or a new one named after the service."},
				{name: "source", description: "Folder or glob where the routes are defined, for example src/routes. Defaults to the whole project."},
			},
			writes: true,
			render: mcpSyncCollectionPrompt,
		},
		{
			name:        "cover_endpoint",
			title:       "Cover one endpoint",
			description: "Add a saved request, tests and an example response for one endpoint of this project's API.",
			arguments: []mcpPromptArgument{
				{name: "endpoint", description: "Method and path, for example POST /orders or GET /users/{id}.", required: true},
				{name: "collection", description: "Collection to put the request in."},
			},
			writes: true,
			render: mcpCoverEndpointPrompt,
		},
		{
			name:        "debug_last_failure",
			title:       "Why did my request fail?",
			description: "Explain why the last failed request sent from Kurlo failed and propose a fix.",
			arguments: []mcpPromptArgument{
				{name: "entry", description: "History entry id from list_history. Defaults to the most recent failure."},
			},
			render: mcpDebugLastFailurePrompt,
		},
	}
	if !readOnly {
		return prompts
	}
	kept := prompts[:0]
	for _, prompt := range prompts {
		if !prompt.writes {
			kept = append(kept, prompt)
		}
	}
	return kept
}

func (p mcpPrompt) definition() map[string]any {
	arguments := make([]map[string]any, 0, len(p.arguments))
	for _, arg := range p.arguments {
		entry := map[string]any{"name": arg.name, "description": arg.description}
		if arg.required {
			entry["required"] = true
		}
		arguments = append(arguments, entry)
	}
	return map[string]any{"name": p.name, "title": p.title, "description": p.description, "arguments": arguments}
}

func (s *mcpServer) listPrompts(params json.RawMessage) map[string]any {
	prompts := mcpServerPrompts(s.opts.readOnly)
	definitions := make([]map[string]any, 0, len(prompts))
	for _, prompt := range prompts {
		definitions = append(definitions, prompt.definition())
	}
	result := map[string]any{"prompts": definitions}
	if mcpServerStateless(params) {
		result["resultType"] = "complete"
		result["ttlMs"] = mcpServerListTTLMs
		result["cacheScope"] = "public"
	}
	return result
}

func (s *mcpServer) getPrompt(params json.RawMessage) (map[string]any, error) {
	var payload struct {
		Name      string            `json:"name"`
		Arguments map[string]string `json:"arguments"`
	}
	if err := json.Unmarshal(params, &payload); err != nil {
		return nil, &mcpServerError{code: mcpRPCInvalidParams, message: "invalid prompts/get params: " + err.Error()}
	}
	var prompt *mcpPrompt
	prompts := mcpServerPrompts(s.opts.readOnly)
	for i := range prompts {
		if prompts[i].name == payload.Name {
			prompt = &prompts[i]
		}
	}
	if prompt == nil {
		return nil, &mcpServerError{code: mcpRPCInvalidParams, message: "unknown prompt: " + payload.Name}
	}
	args := map[string]string{}
	for _, arg := range prompt.arguments {
		value := strings.TrimSpace(payload.Arguments[arg.name])
		if value == "" && arg.required {
			return nil, &mcpServerError{code: mcpRPCInvalidParams, message: fmt.Sprintf("prompt %s needs the %s argument", prompt.name, arg.name)}
		}
		args[arg.name] = value
	}
	result := map[string]any{
		"description": prompt.description,
		"messages": []map[string]any{{
			"role":    "user",
			"content": map[string]any{"type": "text", "text": prompt.render(args)},
		}},
	}
	if mcpServerStateless(params) {
		result["resultType"] = "complete"
	}
	return result, nil
}

const mcpPromptBaseURLRules = "If no environment sets baseUrl, look for the address in the project (.env, docker-compose.yml, launch settings, README) and ask the user before calling set_variable; never point an environment at production. " +
	"When the server is not running anywhere, still save the requests and call generate_tests with from: example and the response the code returns, so the mock server can serve it and the tests run once the server is up."

func mcpSyncCollectionPrompt(args map[string]string) string {
	target := "the workspace's collection"
	if args["collection"] != "" {
		target = "the Kurlo collection " + args["collection"]
	}
	where := "this project's code"
	if args["source"] != "" {
		where = "the code under " + args["source"]
	}
	collectionArg := ""
	if args["collection"] != "" {
		collectionArg = " with collection: " + args["collection"]
	}
	return strings.Join([]string{
		"Bring " + target + " in line with the HTTP API defined in " + where + ".",
		"",
		"1. Find the routes: read the router and controller definitions (Express or Fastify routers, FastAPI or Flask decorators, Go handlers registered on net/http, chi, gin or echo, Spring mappings, Rails routes, ASP.NET controllers). For each route note the method, path, path and query parameters, and the request and response body types.",
		"2. Call list_requests" + collectionArg + " and match each route to a saved request by method and path. Treat {{baseUrl}}, :id and {id} placeholders as equal.",
		"3. For each route without a request, call save_request with the URL {{baseUrl}}/path, path parameters as {{variables}}, a JSON body built from the request type, and auth left as inherit unless the route needs something else. Put it in a folder named after the resource.",
		"4. Call generate_tests for each new request: from: run when list_environments shows an environment whose baseUrl answers, otherwise from: example with the status and body the code returns.",
		"5. Delete nothing. List the saved requests that match no route and ask the user what to do with them.",
		"6. " + mcpPromptBaseURLRules,
		"",
		"Finish with a short table of route, saved request, tests and what is left to do.",
	}, "\n")
}

func mcpCoverEndpointPrompt(args map[string]string) string {
	collection := ""
	if args["collection"] != "" {
		collection = " in the collection " + args["collection"]
	}
	return strings.Join([]string{
		"Add " + args["endpoint"] + " of this project's API to Kurlo" + collection + ".",
		"",
		"1. Find the handler for " + args["endpoint"] + " in the code and read its parameters, request body type, the responses it returns and the auth it needs.",
		"2. Call list_requests to check it is not saved already. If it is, change that request with save_request instead of adding a second one.",
		"3. Call save_request with the URL {{baseUrl}}/path, path parameters as {{variables}} and a realistic JSON body built from the request type.",
		"4. Call generate_tests on it: from: run when an environment's baseUrl answers, otherwise from: example with the success response the code returns. Then add the main error responses (validation, not found, unauthorized) with save_example and the status and body the code returns for them.",
		"5. " + mcpPromptBaseURLRules,
		"",
		"Finish with the request's path, its tests and its examples.",
	}, "\n")
}

func mcpDebugLastFailurePrompt(args map[string]string) string {
	call := "Call diagnose_last_failure."
	if args["entry"] != "" {
		call = "Call diagnose_last_failure with entry: " + args["entry"] + "."
	}
	return strings.Join([]string{
		call,
		"Explain in plain words why the request failed, using its hints, failed tests, unresolved variables and the difference from the saved example.",
		"Propose one fix: a change to the request, a variable to set, or a request to run first, such as a login. Apply it only after the user agrees.",
		"If the cause is in this project's server code, name the file and line. If you need to see the request again, run_request sends it with the same environment.",
	}, "\n")
}
