package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	agentNotesFile        = "kurlo-agent.md"
	agentNotesTool        = "update_agent_notes"
	agentNotesMaxBytes    = 32 * 1024
	agentNotesPromptRunes = 12_000
	agentTemplatesHeading = "templates"
	agentMaxTemplates     = 30
)

func agentNotesPath(root string) string {
	return filepath.Join(root, agentNotesFile)
}

func readAgentNotes(root string) (string, bool, error) {
	data, err := os.ReadFile(agentNotesPath(root))
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if len(data) > agentNotesMaxBytes {
		data = data[:agentNotesMaxBytes]
	}
	return strings.ToValidUTF8(string(data), ""), true, nil
}

func agentNotesForPrompt(root string) string {
	notes, ok, err := readAgentNotes(root)
	if err != nil || !ok || strings.TrimSpace(notes) == "" {
		return ""
	}
	if utf8.RuneCountInString(notes) > agentNotesPromptRunes {
		notes = string([]rune(notes)[:agentNotesPromptRunes]) + "\n[the rest of kurlo-agent.md was left out]"
	}
	return notes
}

func parseAgentTemplates(notes string) []model.AgentTemplate {
	templates := []model.AgentTemplate{}
	inSection := false
	var current *model.AgentTemplate
	var body []string
	flush := func() {
		if current == nil {
			return
		}
		current.Text = strings.TrimSpace(strings.Join(body, "\n"))
		if current.Title != "" && current.Text != "" && len(templates) < agentMaxTemplates {
			templates = append(templates, *current)
		}
		current = nil
		body = nil
	}
	scanner := bufio.NewScanner(strings.NewReader(notes))
	scanner.Buffer(make([]byte, 64*1024), agentNotesMaxBytes)
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "## ") && !strings.HasPrefix(trimmed, "### "):
			flush()
			inSection = strings.EqualFold(strings.TrimSpace(strings.TrimPrefix(trimmed, "## ")), agentTemplatesHeading)
		case strings.HasPrefix(trimmed, "# "):
			flush()
			inSection = false
		case inSection && strings.HasPrefix(trimmed, "### "):
			flush()
			current = &model.AgentTemplate{Title: strings.TrimSpace(strings.TrimPrefix(trimmed, "### "))}
		case inSection && current != nil:
			body = append(body, line)
		}
	}
	flush()
	return templates
}

func readAgentNotesFile(root string) (string, bool, error) {
	data, err := os.ReadFile(agentNotesPath(root))
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return string(data), true, nil
}

func agentWorkspaceNotes(root string) model.AgentWorkspaceNotes {
	out := model.AgentWorkspaceNotes{Path: agentNotesPath(root), Templates: []model.AgentTemplate{}}
	raw, ok, err := readAgentNotesFile(root)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.Exists = ok
	out.Content = strings.ToValidUTF8(raw, "")
	if len(raw) > agentNotesMaxBytes {
		out.TooLarge = true
		out.Content = ""
		raw = raw[:agentNotesMaxBytes]
	}
	out.Templates = parseAgentTemplates(strings.ToValidUTF8(raw, ""))
	return out
}

func (a *App) AgentWorkspaceNotes() model.AgentWorkspaceNotes {
	return agentWorkspaceNotes(fileWorkspaceStorePath())
}

func (a *App) SaveAgentWorkspaceNotes(content, base string, baseExists bool) model.AgentNotesSaveResult {
	return saveAgentWorkspaceNotes(fileWorkspaceStorePath(), content, base, baseExists)
}

func saveAgentWorkspaceNotes(root, content, base string, baseExists bool) model.AgentNotesSaveResult {
	if strings.TrimSpace(root) == "" {
		return model.AgentNotesSaveResult{Error: "Open a workspace folder first."}
	}
	if strings.TrimSpace(content) == "" {
		return model.AgentNotesSaveResult{Error: "The notes are empty. Write something or cancel."}
	}
	content = strings.TrimRight(content, " \n\t") + "\n"
	if len(content) > agentNotesMaxBytes {
		return model.AgentNotesSaveResult{Error: fmt.Sprintf("kurlo-agent.md can be at most %d KB.", agentNotesMaxBytes/1024)}
	}
	if !utf8.ValidString(content) {
		return model.AgentNotesSaveResult{Error: "The notes must be UTF-8 text."}
	}
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		return model.AgentNotesSaveResult{Error: err.Error()}
	}
	defer unlock()
	current, exists, err := readAgentNotesFile(root)
	if err != nil {
		return model.AgentNotesSaveResult{Error: err.Error()}
	}
	if exists != baseExists || current != base {
		result := model.AgentNotesSaveResult{Conflict: true, CurrentExists: exists, Error: "kurlo-agent.md changed outside this editor since you opened it."}
		if len(current) <= agentNotesMaxBytes {
			result.Current = current
		}
		return result
	}
	if err := writeTextFileAtomic(agentNotesPath(root), []byte(content)); err != nil {
		return model.AgentNotesSaveResult{Error: err.Error()}
	}
	return model.AgentNotesSaveResult{Ok: true, Notes: agentWorkspaceNotes(root)}
}

func agentNotesDefinition() map[string]any {
	return map[string]any{
		"name":        agentNotesTool,
		"description": "Propose a change to kurlo-agent.md, the workspace notes shared with the team in Git: conventions, naming, which environment to use, templates under '## Templates' with '### Title' entries. Send the whole new file in content. Only call it when you learned a convention worth keeping; the user always reviews the diff.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"content": map[string]any{"type": "string", "description": "The complete new contents of kurlo-agent.md in Markdown."},
				"reason":  map[string]any{"type": "string", "description": "One sentence on what you add or change and why."},
			},
			"required": []string{"content"},
		},
	}
}

func (b *agentToolBridge) updateAgentNotes(ctx context.Context, input, toolUseID string) (string, bool) {
	var args struct {
		Content string `json:"content"`
		Reason  string `json:"reason"`
	}
	arguments := aiInputObject(input)
	if err := json.Unmarshal(arguments, &args); err != nil {
		return "The arguments are not valid JSON: " + err.Error(), true
	}
	content := strings.TrimRight(args.Content, " \n\t") + "\n"
	if strings.TrimSpace(args.Content) == "" {
		return "content is empty; send the whole new kurlo-agent.md.", true
	}
	if len(content) > agentNotesMaxBytes {
		return fmt.Sprintf("kurlo-agent.md can be at most %d KB.", agentNotesMaxBytes/1024), true
	}
	if !utf8.ValidString(content) {
		return "content must be UTF-8 text.", true
	}
	root := b.server.opts.workspace
	record := &mcpCallRecord{}
	before, existed, err := readAgentNotes(root)
	if err != nil {
		b.server.logCall(agentNotesTool, arguments, record, nil, err)
		return err.Error(), true
	}
	if existed && before == content {
		return "kurlo-agent.md already has this content.", false
	}
	change := model.AgentFileChange{Path: agentNotesFile, After: &content}
	if existed {
		change.Before = &before
	}
	reason := strings.TrimSpace(args.Reason)
	if reason == "" {
		reason = "Updates the team notes in kurlo-agent.md, shared through Git."
	}
	if err := b.ask(ctx, model.AgentApproval{ToolUseID: toolUseID, Tool: agentNotesTool, Kind: model.AgentToolWrite, Arguments: string(arguments), Reason: reason, Changes: []model.AgentFileChange{change}}); err != nil {
		b.server.logCall(agentNotesTool, arguments, record, nil, err)
		if ctx.Err() != nil {
			return "Cancelled before kurlo-agent.md was changed.", true
		}
		return err.Error(), true
	}
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		return err.Error(), true
	}
	current, stillExists, err := readAgentNotes(root)
	if err == nil && (stillExists != existed || current != before) {
		err = errors.New("kurlo-agent.md changed while waiting for approval, so nothing was written; read it again and retry")
	}
	if err == nil {
		err = writeTextFileAtomic(agentNotesPath(root), []byte(content))
	}
	unlock()
	if err != nil {
		b.server.logCall(agentNotesTool, arguments, record, nil, err)
		return err.Error(), true
	}
	record.changes = []model.AgentFileChange{change}
	if b.server.onWrite != nil {
		b.server.onWrite(root, record.changes)
	}
	text := "Saved kurlo-agent.md. Commit it so the team gets it."
	if committed := b.commitOwnBranch(agentNotesTool, record); committed != "" {
		text = "Saved kurlo-agent.md. " + committed
	}
	b.server.logCall(agentNotesTool, arguments, record, mcpToolText(text, false), nil)
	return text, false
}
