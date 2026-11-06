package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	agentPlanTool     = "propose_plan"
	agentPlanMaxSteps = 30
	agentPlanMaxCalls = 40
)

var agentPlanNever = map[string]bool{
	"git_push":         true,
	"authorize_oauth2": true,
	agentPlanTool:      true,
	agentNotesTool:     true,
}

type agentPlanGrant struct {
	call model.AgentPlanCall
	used bool
}

func agentPlanDefinition() map[string]any {
	return map[string]any{
		"name":        agentPlanTool,
		"description": "Show the user a plan before a task with several changes or unsafe requests. List the steps in plain words and, in calls, every write tool or request with POST, PUT, PATCH or DELETE you will make, each with its target: the request path (Collection/Folder/Request), environment, variable key, collection or URL. Once the user approves, exactly those calls run without asking again; a call with an empty target is allowed once.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"summary": map[string]any{"type": "string", "description": "One sentence on what the plan does."},
				"steps":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				"calls": map[string]any{"type": "array", "items": map[string]any{
					"type":       "object",
					"properties": map[string]any{"tool": map[string]any{"type": "string"}, "target": map[string]any{"type": "string"}},
					"required":   []string{"tool"},
				}},
			},
			"required": []string{"summary", "steps"},
		},
	}
}

func agentParsePlan(input string) (model.AgentPlan, error) {
	var plan model.AgentPlan
	if err := json.Unmarshal(aiInputObject(input), &plan); err != nil {
		return plan, fmt.Errorf("The plan is not valid JSON: %v", err)
	}
	plan.Summary = strings.TrimSpace(plan.Summary)
	steps := plan.Steps[:0]
	for _, step := range plan.Steps {
		if step = strings.TrimSpace(step); step != "" {
			steps = append(steps, step)
		}
	}
	plan.Steps = steps
	calls := plan.Calls[:0]
	for _, call := range plan.Calls {
		call.Tool = strings.TrimSpace(call.Tool)
		call.Target = strings.TrimSpace(call.Target)
		if call.Tool != "" {
			calls = append(calls, call)
		}
	}
	plan.Calls = calls
	switch {
	case plan.Summary == "" || len(plan.Steps) == 0:
		return plan, fmt.Errorf("A plan needs a summary and at least one step.")
	case len(plan.Steps) > agentPlanMaxSteps:
		return plan, fmt.Errorf("A plan can have at most %d steps.", agentPlanMaxSteps)
	case len(plan.Calls) > agentPlanMaxCalls:
		return plan, fmt.Errorf("A plan can list at most %d calls.", agentPlanMaxCalls)
	}
	for _, call := range plan.Calls {
		if agentPlanNever[call.Tool] {
			return plan, fmt.Errorf("%s cannot be part of a plan: it always waits for the user. Leave it out and call it when the user asks.", call.Tool)
		}
	}
	return plan, nil
}

func (b *agentToolBridge) proposePlan(ctx context.Context, input, toolUseID string) (string, bool) {
	plan, err := agentParsePlan(input)
	if err != nil {
		return err.Error(), true
	}
	reason := plan.Summary
	if len(plan.Calls) == 0 {
		reason += " It lists no changes, so every change still waits for approval."
	}
	if err := b.ask(ctx, model.AgentApproval{ToolUseID: toolUseID, Tool: agentPlanTool, Kind: model.AgentToolWrite, Arguments: string(aiInputObject(input)), Reason: reason, Plan: &plan}); err != nil {
		if ctx.Err() != nil {
			return "Cancelled before the plan was approved.", true
		}
		if declined, ok := err.(*mcpDeclinedError); ok && strings.Contains(declined.message, "declined") {
			return "The user declined the plan. Ask what they want changed before you continue.", true
		}
		return err.Error(), true
	}
	b.mu.Lock()
	b.plan = b.plan[:0]
	for _, call := range plan.Calls {
		b.plan = append(b.plan, &agentPlanGrant{call: call})
	}
	b.mu.Unlock()
	if len(plan.Calls) == 0 {
		return "The user approved the plan. It lists no changes, so each change still needs approval.", false
	}
	return fmt.Sprintf("The user approved the plan. These %d %s now run without asking: %s. Anything else still needs approval.", len(plan.Calls), agentPlural(len(plan.Calls), "call", "calls"), agentPlanCallsText(plan.Calls)), false
}

func agentPlanCallsText(calls []model.AgentPlanCall) string {
	parts := make([]string, 0, len(calls))
	for _, call := range calls {
		if call.Target == "" {
			parts = append(parts, call.Tool+" (once)")
		} else {
			parts = append(parts, call.Tool+" "+call.Target)
		}
	}
	return strings.Join(parts, ", ")
}

func agentArgumentStrings(value any, out *[]string) {
	switch typed := value.(type) {
	case string:
		*out = append(*out, strings.TrimSpace(typed))
	case map[string]any:
		for _, item := range typed {
			agentArgumentStrings(item, out)
		}
	case []any:
		for _, item := range typed {
			agentArgumentStrings(item, out)
		}
	}
}

func agentTargetMatches(target string, values []string) bool {
	target = strings.Trim(strings.ToLower(target), "/ ")
	for _, value := range values {
		value = strings.Trim(strings.ToLower(value), "/ ")
		if value == "" {
			continue
		}
		if value == target || strings.HasSuffix(value, "/"+target) || strings.HasSuffix(target, "/"+value) {
			return true
		}
	}
	return false
}

func agentPlanTargetValues(tool string, arguments json.RawMessage) []string {
	var parsed map[string]any
	if json.Unmarshal(arguments, &parsed) != nil {
		return nil
	}
	var values []string
	agentArgumentStrings(parsed, &values)
	collection, _ := parsed["collection"].(string)
	for _, key := range []string{"name", "request", "folder"} {
		if name, ok := parsed[key].(string); ok && collection != "" && strings.TrimSpace(name) != "" {
			values = append(values, strings.TrimSpace(collection)+"/"+strings.TrimSpace(name))
		}
	}
	return values
}

func (b *agentToolBridge) planCovers(tool string, arguments json.RawMessage) bool {
	if agentPlanNever[tool] {
		return false
	}
	values := agentPlanTargetValues(tool, arguments)
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, grant := range b.plan {
		if grant.call.Tool != tool {
			continue
		}
		if grant.call.Target == "" {
			if grant.used {
				continue
			}
			grant.used = true
			return true
		}
		if agentTargetMatches(grant.call.Target, values) {
			return true
		}
	}
	return false
}
