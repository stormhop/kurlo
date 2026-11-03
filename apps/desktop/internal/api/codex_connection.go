package api

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type codexLogin struct {
	client   *codexClient
	cancel   context.CancelFunc
	path     string
	url      string
	id       string
	mu       sync.Mutex
	finished chan struct{}
}

func savedCodexConnection() (model.CodexConnection, bool, error) {
	aiConnectionsMu.Lock()
	defer aiConnectionsMu.Unlock()
	preferences, err := loadAppPreferences()
	if err != nil {
		return model.CodexConnection{}, false, err
	}
	if preferences.Codex == nil {
		return model.CodexConnection{}, false, nil
	}
	return *preferences.Codex, true, nil
}

func codexReadStatus(ctx context.Context, client *codexClient, status *model.CodexStatus) error {
	var account struct {
		Account *struct {
			Type  string `json:"type"`
			Email string `json:"email"`
			Plan  string `json:"planType"`
		} `json:"account"`
	}
	if err := client.call(ctx, "account/read", map[string]any{"refreshToken": false}, &account); err != nil {
		return err
	}
	status.Authenticated = account.Account != nil
	if account.Account != nil {
		status.AuthType = account.Account.Type
		status.Account = account.Account.Email
		if status.AuthType == "apiKey" {
			status.Account = "API key"
		}
		if account.Account.Plan != "" {
			status.Account = strings.TrimSpace(status.Account + " · " + account.Account.Plan)
		}
	}
	if !status.Authenticated {
		return nil
	}
	var config struct {
		Config struct {
			Effort string `json:"model_reasoning_effort"`
		} `json:"config"`
	}
	if err := client.call(ctx, "config/read", map[string]any{"includeLayers": false}, &config); err != nil {
		return err
	}
	cursor := ""
	for page := 0; page < 10; page++ {
		var models struct {
			Data []struct {
				ID            string `json:"id"`
				Model         string `json:"model"`
				Name          string `json:"displayName"`
				Default       bool   `json:"isDefault"`
				DefaultEffort string `json:"defaultReasoningEffort"`
				Efforts       []struct {
					Effort string `json:"reasoningEffort"`
				} `json:"supportedReasoningEfforts"`
			} `json:"data"`
			Next string `json:"nextCursor"`
		}
		params := map[string]any{"limit": 100}
		if cursor != "" {
			params["cursor"] = cursor
		}
		if err := client.call(ctx, "model/list", params, &models); err != nil {
			return fmt.Errorf("Could not load Codex models: %w", err)
		}
		for _, m := range models.Data {
			id := m.Model
			if id == "" {
				id = m.ID
			}
			entry := model.AiConnectionModel{ID: id, Name: m.Name, Recommended: m.Default, DefaultEffort: m.DefaultEffort}
			for _, option := range m.Efforts {
				entry.Efforts = append(entry.Efforts, option.Effort)
				if option.Effort == config.Config.Effort {
					entry.DefaultEffort = config.Config.Effort
				}
			}
			status.Models = append(status.Models, entry)
			if status.Model == "" && m.Default {
				status.Model = id
			}
		}
		if models.Next == "" || models.Next == cursor {
			break
		}
		cursor = models.Next
	}
	if status.Model == "" && len(status.Models) > 0 {
		status.Model = status.Models[0].ID
	}
	status.RateLimits = codexReadRateLimits(ctx, client)
	return nil
}

func (a *App) CodexStatus(path string) model.CodexStatus {
	status := model.CodexStatus{Models: []model.AiConnectionModel{}}
	saved, connected, err := savedCodexConnection()
	if err != nil {
		status.Error = err.Error()
		return status
	}
	status.Connected = connected
	if strings.TrimSpace(path) == "" {
		path = saved.Path
	}
	status.Model = saved.Model
	resolved, err := codexExecutable(path)
	if err != nil {
		status.Error = err.Error()
		return status
	}
	status.Path = resolved
	status.Installed = true
	base := a.ctx
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithTimeout(base, 20*time.Second)
	defer cancel()
	version, err := codexCommand(ctx, resolved, "--version").Output()
	if err != nil {
		status.Error = "Could not read the Codex CLI version."
		return status
	}
	status.Version = strings.TrimSpace(string(version))
	rt := a.agentRuntime()
	rt.mu.Lock()
	login := rt.codexLogin
	rt.mu.Unlock()
	if login != nil && login.path == resolved {
		login.mu.Lock()
		err = codexReadStatus(ctx, login.client, &status)
		status.AuthURL = login.url
		status.Waiting = !status.Authenticated && err == nil
		login.mu.Unlock()
	} else {
		var client *codexClient
		client, err = startCodexClient(ctx, resolved)
		if err == nil {
			defer client.close()
			err = codexReadStatus(ctx, client, &status)
		}
	}
	if err != nil {
		status.Error = err.Error()
	}
	return status
}

func (a *App) ConnectCodex(input model.CodexConnection) model.CodexStatus {
	status := a.CodexStatus(input.Path)
	if status.Error != "" {
		return status
	}
	if !status.Authenticated {
		status.Error = "Sign in to Codex before connecting it."
		return status
	}
	if input.Model != "" {
		found := false
		for _, m := range status.Models {
			if m.ID == input.Model {
				found = true
				break
			}
		}
		if !found {
			status.Error = "This model is not available in your Codex account."
			return status
		}
		status.Model = input.Model
	}
	aiConnectionsMu.Lock()
	preferences, err := loadAppPreferences()
	if err == nil {
		preferences.Codex = &model.CodexConnection{Path: status.Path, Model: status.Model}
		err = saveAppPreferences(preferences)
	}
	aiConnectionsMu.Unlock()
	if err != nil {
		status.Error = err.Error()
		return status
	}
	status.Connected = true
	status.Waiting = false
	status.AuthURL = ""
	a.CancelCodexLogin()
	return status
}

func (a *App) RemoveCodexConnection() model.AgentResult {
	a.CancelCodexLogin()
	rt := a.agentRuntime()
	rt.mu.Lock()
	ids := make([]string, 0, len(rt.running))
	for id := range rt.running {
		ids = append(ids, id)
	}
	rt.mu.Unlock()
	for _, id := range ids {
		if chat, err := loadAgentChat(id); err == nil && chat.Driver == "codex" {
			a.StopAgent(id)
		}
	}
	aiConnectionsMu.Lock()
	defer aiConnectionsMu.Unlock()
	preferences, err := loadAppPreferences()
	if err == nil {
		preferences.Codex = nil
		err = saveAppPreferences(preferences)
	}
	if err != nil {
		return model.AgentResult{Error: err.Error()}
	}
	return model.AgentResult{Ok: true}
}

func (a *App) StartCodexLogin(path string) model.CodexStatus {
	a.CancelCodexLogin()
	resolved, err := codexExecutable(path)
	if err != nil {
		return model.CodexStatus{Models: []model.AiConnectionModel{}, Error: err.Error()}
	}
	base := a.ctx
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithTimeout(base, 5*time.Minute)
	client, err := startCodexClient(ctx, resolved)
	if err != nil {
		cancel()
		return model.CodexStatus{Models: []model.AiConnectionModel{}, Error: err.Error()}
	}
	var result struct {
		URL string `json:"authUrl"`
		ID  string `json:"loginId"`
	}
	if err = client.call(ctx, "account/login/start", map[string]any{"type": "chatgpt"}, &result); err != nil || result.URL == "" {
		cancel()
		client.close()
		if err == nil {
			err = errors.New("Codex did not provide a sign-in URL.")
		}
		return model.CodexStatus{Models: []model.AiConnectionModel{}, Error: err.Error()}
	}
	login := &codexLogin{client: client, cancel: cancel, path: resolved, url: result.URL, id: result.ID, finished: make(chan struct{})}
	rt := a.agentRuntime()
	rt.mu.Lock()
	rt.codexLogin = login
	rt.mu.Unlock()
	go func() {
		<-ctx.Done()
		defer close(login.finished)
		rt.mu.Lock()
		if rt.codexLogin == login {
			rt.codexLogin = nil
		}
		rt.mu.Unlock()
		login.mu.Lock()
		client.close()
		login.mu.Unlock()
	}()
	return model.CodexStatus{Installed: true, Path: resolved, Waiting: true, AuthURL: result.URL, Models: []model.AiConnectionModel{}}
}

func (a *App) CancelCodexLogin() {
	rt := a.agentRuntime()
	rt.mu.Lock()
	login := rt.codexLogin
	rt.codexLogin = nil
	rt.mu.Unlock()
	if login != nil {
		login.cancel()
		<-login.finished
	}
}

func codexReadRateLimits(ctx context.Context, client *codexClient) []model.CodexRateLimit {
	var response struct {
		Limits model.CodexRateLimit            `json:"rateLimits"`
		ByID   map[string]model.CodexRateLimit `json:"rateLimitsByLimitId"`
	}
	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := client.call(requestCtx, "account/rateLimits/read", map[string]any{}, &response); err != nil {
		return nil
	}
	limits := []model.CodexRateLimit{}
	keys := make([]string, 0, len(response.ByID))
	for key := range response.ByID {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		limit := response.ByID[key]
		if limit.ID == "" {
			limit.ID = key
		}
		if limit.Primary != nil || limit.Secondary != nil {
			limits = append(limits, limit)
		}
	}
	if len(limits) == 0 && (response.Limits.Primary != nil || response.Limits.Secondary != nil) {
		limits = append(limits, response.Limits)
	}
	return limits
}
