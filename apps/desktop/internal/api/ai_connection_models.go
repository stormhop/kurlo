package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	aiConnectionTimeout      = 20 * time.Second
	aiLocalProbeTimeout      = 1200 * time.Millisecond
	aiModelListLimit         = 8 << 20
	aiLocalCapabilityLimit   = 40
	anthropicVersionHeader   = "2023-06-01"
	openRouterRefererHeader  = "https://kurlo.dev"
	openRouterTitleHeader    = "Kurlo"
	aiLocalOllamaName        = "Ollama"
	aiLocalLMStudioName      = "LM Studio"
	aiLocalOllamaDefaultBase = "http://127.0.0.1:11434"
	aiLocalLMStudioBase      = "http://127.0.0.1:1234"
)

var aiConnectionHTTPClient = &http.Client{
	Timeout:   aiConnectionTimeout,
	Transport: &http.Transport{Proxy: http.ProxyFromEnvironment},
}

type aiLocalCandidate struct {
	name   string
	root   string
	ollama bool
}

var aiLocalCandidates = []aiLocalCandidate{
	{name: aiLocalOllamaName, root: aiLocalOllamaDefaultBase, ollama: true},
	{name: aiLocalLMStudioName, root: aiLocalLMStudioBase},
}

var aiRecommendedModelMarkers = []string{"claude-sonnet", "claude-opus", "claude-haiku", "gpt-5", "gpt-4.1", "gpt-4o"}

func aiModelRecommended(id string) bool {
	lower := strings.ToLower(id)
	for _, marker := range aiRecommendedModelMarkers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func aiConnectionHeaders(kind, key string) http.Header {
	headers := http.Header{}
	headers.Set("Accept", "application/json")
	switch kind {
	case model.AiConnectionAnthropic:
		if key != "" {
			headers.Set("x-api-key", key)
		}
		headers.Set("anthropic-version", anthropicVersionHeader)
	default:
		if key != "" {
			headers.Set("Authorization", "Bearer "+key)
		}
	}
	if kind == model.AiConnectionOpenRouter {
		headers.Set("HTTP-Referer", openRouterRefererHeader)
		headers.Set("X-Title", openRouterTitleHeader)
	}
	return headers
}

type aiHTTPError struct {
	status  int
	message string
}

func (e *aiHTTPError) Error() string { return e.message }

func aiConnectionGet(ctx context.Context, client *http.Client, target string, headers http.Header) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header = headers.Clone()
	return aiConnectionDo(client, req)
}

func aiConnectionPost(ctx context.Context, client *http.Client, target string, headers http.Header, payload any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header = headers.Clone()
	req.Header.Set("Content-Type", "application/json")
	return aiConnectionDo(client, req)
}

func aiConnectionDo(client *http.Client, req *http.Request) ([]byte, error) {
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Could not reach %s: %v", req.URL.Host, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, aiModelListLimit))
	if err != nil {
		return nil, fmt.Errorf("Could not read the answer of %s: %v", req.URL.Host, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return body, &aiHTTPError{status: resp.StatusCode, message: aiConnectionStatusMessage(resp.StatusCode, body)}
	}
	return body, nil
}

func aiConnectionStatusMessage(status int, body []byte) string {
	detail := strings.TrimSpace(aiErrorMessage(body))
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		if detail != "" {
			return "The API key was not accepted: " + detail
		}
		return "The API key was not accepted"
	case status == http.StatusNotFound:
		return "This server has no model list at the base URL; check the URL"
	}
	if detail != "" {
		return fmt.Sprintf("The provider answered %d: %s", status, detail)
	}
	return fmt.Sprintf("The provider answered %d %s", status, http.StatusText(status))
}

type aiModelListEntry struct {
	ID                  string   `json:"id"`
	Name                string   `json:"name"`
	DisplayName         string   `json:"display_name"`
	SupportedParameters []string `json:"supported_parameters"`
}

func parseAiConnectionModels(body []byte) ([]model.AiConnectionModel, error) {
	var payload struct {
		Data   []aiModelListEntry `json:"data"`
		Models []aiModelListEntry `json:"models"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, errors.New("The provider answered with something that is not a model list")
	}
	entries := payload.Data
	if len(entries) == 0 {
		entries = payload.Models
	}
	models := make([]model.AiConnectionModel, 0, len(entries))
	seen := map[string]bool{}
	for _, entry := range entries {
		id := strings.TrimSpace(entry.ID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		name := strings.TrimSpace(entry.DisplayName)
		if name == "" {
			name = strings.TrimSpace(entry.Name)
		}
		if name == "" {
			name = id
		}
		weak := entry.SupportedParameters != nil && !containsFold(entry.SupportedParameters, "tools")
		models = append(models, model.AiConnectionModel{
			ID:          id,
			Name:        name,
			Recommended: !weak && aiModelRecommended(id),
			WeakTools:   weak,
		})
	}
	sortAiConnectionModels(models)
	return models, nil
}

func sortAiConnectionModels(models []model.AiConnectionModel) {
	rank := func(m model.AiConnectionModel) int {
		switch {
		case m.Recommended:
			return 0
		case m.WeakTools:
			return 2
		}
		return 1
	}
	sort.SliceStable(models, func(i, j int) bool { return rank(models[i]) < rank(models[j]) })
}

func containsFold(values []string, want string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), want) {
			return true
		}
	}
	return false
}

func checkOpenRouterKey(ctx context.Context, client *http.Client, base, key string) error {
	headers := aiConnectionHeaders(model.AiConnectionOpenRouter, key)
	_, err := aiConnectionGet(ctx, client, base+"/key", headers)
	var httpErr *aiHTTPError
	if errors.As(err, &httpErr) && httpErr.status == http.StatusNotFound {
		_, err = aiConnectionGet(ctx, client, base+"/auth/key", headers)
	}
	if errors.As(err, &httpErr) && httpErr.status == http.StatusNotFound {
		return errors.New("OpenRouter could not check this key; check the base URL")
	}
	return err
}

func redactAiKey(message, key string) string {
	key = strings.TrimSpace(key)
	if len(key) < 4 {
		return message
	}
	return strings.ReplaceAll(message, key, "[your key]")
}

func listAiConnectionModels(ctx context.Context, client *http.Client, kind, base, key string) model.AiConnectionTestResult {
	result := listAiConnectionModelsRaw(ctx, client, kind, base, key)
	result.Error = redactAiKey(result.Error, key)
	return result
}

func listAiConnectionModelsRaw(ctx context.Context, client *http.Client, kind, base, key string) model.AiConnectionTestResult {
	if kind == model.AiConnectionOpenRouter {
		if err := checkOpenRouterKey(ctx, client, base, key); err != nil {
			return model.AiConnectionTestResult{Models: []model.AiConnectionModel{}, Error: err.Error()}
		}
	}
	body, err := aiConnectionGet(ctx, client, base+"/models", aiConnectionHeaders(kind, key))
	if err != nil {
		return model.AiConnectionTestResult{Models: []model.AiConnectionModel{}, Error: err.Error()}
	}
	models, err := parseAiConnectionModels(body)
	if err != nil {
		return model.AiConnectionTestResult{Models: []model.AiConnectionModel{}, Error: err.Error()}
	}
	if kind == model.AiConnectionLocal {
		if root, ok := ollamaRootFor(base); ok {
			markOllamaToolSupport(ctx, client, root, models)
		}
	}
	return model.AiConnectionTestResult{OK: true, Models: models}
}

func ollamaRootFor(base string) (string, bool) {
	for _, candidate := range aiLocalCandidates {
		if candidate.ollama && strings.TrimSuffix(base, "/v1") == candidate.root {
			return candidate.root, true
		}
	}
	return "", false
}

func markOllamaToolSupport(ctx context.Context, client *http.Client, root string, models []model.AiConnectionModel) {
	var wg sync.WaitGroup
	for i := range models {
		if i >= aiLocalCapabilityLimit {
			break
		}
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			body, err := aiConnectionPost(ctx, client, root+"/api/show", http.Header{}, map[string]string{"model": models[index].ID})
			if err != nil {
				return
			}
			var show struct {
				Capabilities []string `json:"capabilities"`
			}
			if json.Unmarshal(body, &show) != nil || show.Capabilities == nil {
				return
			}
			tools := containsFold(show.Capabilities, "tools")
			models[index].WeakTools = !tools
			models[index].Recommended = false
		}(i)
	}
	wg.Wait()
	sortAiConnectionModels(models)
}

func discoverLocalAiServers(ctx context.Context, client *http.Client) model.AiLocalDiscovery {
	servers := make([]*model.AiLocalServer, len(aiLocalCandidates))
	var wg sync.WaitGroup
	for i, candidate := range aiLocalCandidates {
		wg.Add(1)
		go func(index int, candidate aiLocalCandidate) {
			defer wg.Done()
			probeCtx, cancel := context.WithTimeout(ctx, aiLocalProbeTimeout)
			defer cancel()
			base := candidate.root + "/v1"
			body, err := aiConnectionGet(probeCtx, client, base+"/models", aiConnectionHeaders(model.AiConnectionLocal, ""))
			if err != nil {
				return
			}
			models, err := parseAiConnectionModels(body)
			if err != nil {
				return
			}
			if candidate.ollama {
				showCtx, cancelShow := context.WithTimeout(ctx, 4*time.Second)
				markOllamaToolSupport(showCtx, client, candidate.root, models)
				cancelShow()
			}
			servers[index] = &model.AiLocalServer{Name: candidate.name, BaseURL: base, Models: models}
		}(i, candidate)
	}
	wg.Wait()
	result := model.AiLocalDiscovery{Servers: []model.AiLocalServer{}}
	for _, server := range servers {
		if server != nil {
			result.Servers = append(result.Servers, *server)
		}
	}
	return result
}

func (a *App) appContext() context.Context {
	if a.ctx != nil {
		return a.ctx
	}
	return context.Background()
}

func (a *App) TestAiConnection(input model.AiConnectionInput) model.AiConnectionTestResult {
	kind := strings.TrimSpace(input.Kind)
	key := strings.TrimSpace(input.Key)
	base := strings.TrimSpace(input.BaseURL)
	if id := strings.TrimSpace(input.ID); id != "" {
		saved, err := findSavedAiConnection(id)
		if err != nil {
			return model.AiConnectionTestResult{Models: []model.AiConnectionModel{}, Error: err.Error()}
		}
		if kind == "" {
			kind = saved.Kind
		}
		if base == "" {
			base = saved.BaseURL
		}
		if key == "" {
			if key, err = savedAiConnectionKey(saved); err != nil {
				return model.AiConnectionTestResult{Models: []model.AiConnectionModel{}, Error: err.Error()}
			}
		}
	}
	if !aiConnectionKindKnown(kind) {
		return model.AiConnectionTestResult{Models: []model.AiConnectionModel{}, Error: fmt.Sprintf("unknown AI connection type %q", kind)}
	}
	if base == "" {
		base = aiConnectionDefaultBaseURL(kind)
	}
	normalized, err := normalizeAiBaseURL(base)
	if err != nil {
		return model.AiConnectionTestResult{Models: []model.AiConnectionModel{}, Error: err.Error()}
	}
	if key == "" && aiConnectionNeedsKey(kind) {
		return model.AiConnectionTestResult{Models: []model.AiConnectionModel{}, Error: "Enter the API key"}
	}
	return listAiConnectionModels(a.appContext(), aiConnectionHTTPClient, kind, normalized, key)
}

func (a *App) DiscoverLocalAiServers() model.AiLocalDiscovery {
	return discoverLocalAiServers(a.appContext(), aiConnectionHTTPClient)
}
