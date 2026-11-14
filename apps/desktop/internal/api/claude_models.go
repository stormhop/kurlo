package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type claudeModelInfo struct {
	Value                 string   `json:"value"`
	ResolvedModel         string   `json:"resolvedModel"`
	DisplayName           string   `json:"displayName"`
	SupportsEffort        bool     `json:"supportsEffort"`
	SupportedEffortLevels []string `json:"supportedEffortLevels"`
}

func claudeModelList(entries []claudeModelInfo) ([]model.AiConnectionModel, string) {
	models := []model.AiConnectionModel{}
	defaultModel := ""
	indices := map[string]int{}
	for _, entry := range entries {
		id := strings.TrimSpace(entry.ResolvedModel)
		if id == "" {
			id = strings.TrimSpace(entry.Value)
		}
		if id == "" {
			continue
		}
		recommended := entry.Value == "default"
		if recommended {
			defaultModel = id
		}
		name := strings.TrimSpace(entry.DisplayName)
		if name == "" {
			name = id
		}
		m := model.AiConnectionModel{ID: id, Name: name, Recommended: recommended}
		if entry.SupportsEffort {
			for _, effort := range entry.SupportedEffortLevels {
				effort = strings.TrimSpace(effort)
				if effort != "" && !slices.Contains(m.Efforts, effort) {
					m.Efforts = append(m.Efforts, effort)
				}
			}
			if slices.Contains(m.Efforts, "high") {
				m.DefaultEffort = "high"
			} else if len(m.Efforts) > 0 {
				m.DefaultEffort = m.Efforts[0]
			}
		}
		if index, exists := indices[id]; exists {
			if recommended {
				models[index].Recommended = true
			} else if models[index].Recommended {
				m.Recommended = true
				models[index] = m
			}
			continue
		}
		indices[id] = len(models)
		models = append(models, m)
	}
	return models, defaultModel
}

func claudeChosenModel(saved, defaultModel string, models []model.AiConnectionModel) string {
	for _, m := range models {
		if m.ID == strings.TrimSpace(saved) {
			return m.ID
		}
	}
	if defaultModel != "" {
		return defaultModel
	}
	if len(models) > 0 {
		return models[0].ID
	}
	return strings.TrimSpace(saved)
}

func claudeEffortArg(id, effort string, models []model.AiConnectionModel) string {
	for _, m := range models {
		if m.ID == id {
			if slices.Contains(m.Efforts, effort) {
				return effort
			}
			return m.DefaultEffort
		}
	}
	return ""
}

func readClaudeModels(base context.Context, path string) ([]model.AiConnectionModel, string, error) {
	ctx, cancel := context.WithTimeout(base, 8*time.Second)
	defer cancel()
	dir, err := os.MkdirTemp("", "kurlo-claude-models-")
	if err != nil {
		return nil, "", err
	}
	defer os.RemoveAll(dir)
	cmd := exec.CommandContext(ctx, path, "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
		"--restricted", "--tools", "", "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`, "--no-session-persistence", "--setting-sources", "")
	configureAgentProcess(cmd)
	cmd.Dir = dir
	cmd.WaitDelay = time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, "", err
	}
	defer stdin.Close()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, "", err
	}
	defer stdout.Close()
	if err := cmd.Start(); err != nil {
		return nil, "", err
	}
	defer func() {
		cancel()
		_ = cmd.Wait()
	}()
	stopReading := context.AfterFunc(ctx, func() { _ = stdout.Close() })
	defer stopReading()
	request := map[string]any{"type": "control_request", "request_id": "kurlo-models", "request": map[string]any{"subtype": "initialize"}}
	if err := json.NewEncoder(stdin).Encode(request); err != nil {
		return nil, "", err
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		var event struct {
			Type     string `json:"type"`
			Response struct {
				Subtype   string `json:"subtype"`
				RequestID string `json:"request_id"`
				Error     string `json:"error"`
				Response  struct {
					Models []claudeModelInfo `json:"models"`
				} `json:"response"`
			} `json:"response"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil || event.Type != "control_response" || event.Response.RequestID != "kurlo-models" {
			continue
		}
		if event.Response.Subtype != "success" {
			return nil, "", fmt.Errorf("Could not load Claude Code models: %s", event.Response.Error)
		}
		models, defaultModel := claudeModelList(event.Response.Response.Models)
		if len(models) == 0 {
			return nil, "", errors.New("Claude Code returned no available models. Update the CLI and try again.")
		}
		return models, defaultModel, nil
	}
	if ctx.Err() != nil {
		return nil, "", fmt.Errorf("Could not load Claude Code models: %w", ctx.Err())
	}
	if scanner.Err() != nil {
		return nil, "", fmt.Errorf("Could not read Claude Code models: %w", scanner.Err())
	}
	return nil, "", errors.New("Claude Code did not return its available models. Update the CLI and try again.")
}
