package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	openRouterAPIBase = "https://openrouter.ai/api/v1"
	anthropicAPIBase  = "https://api.anthropic.com/v1"
	openAIAPIBase     = "https://api.openai.com/v1"
)

type savedAiConnection struct {
	ID           string `json:"id"`
	Kind         string `json:"kind"`
	Label        string `json:"label,omitempty"`
	BaseURL      string `json:"baseUrl,omitempty"`
	Model        string `json:"model,omitempty"`
	KeyEncrypted string `json:"keyEncrypted,omitempty"`
	KeyHint      string `json:"keyHint,omitempty"`
	Default      bool   `json:"default,omitempty"`
}

var aiConnectionsMu sync.Mutex

var errAiConnectionNotFound = errors.New("this AI connection no longer exists")

const aiConnectionLimit = 10

var errAiConnectionLimit = fmt.Errorf("You can keep up to %d AI connections. Remove one to add another", aiConnectionLimit)

func aiConnectionKindKnown(kind string) bool {
	switch kind {
	case model.AiConnectionOpenRouter, model.AiConnectionAnthropic, model.AiConnectionOpenAI,
		model.AiConnectionCompatible, model.AiConnectionLocal:
		return true
	}
	return false
}

func aiConnectionDefaultLabel(kind string) string {
	switch kind {
	case model.AiConnectionOpenRouter:
		return "OpenRouter"
	case model.AiConnectionAnthropic:
		return "Anthropic"
	case model.AiConnectionOpenAI:
		return "OpenAI"
	case model.AiConnectionLocal:
		return "Local model"
	}
	return "OpenAI-compatible"
}

func aiConnectionDefaultBaseURL(kind string) string {
	switch kind {
	case model.AiConnectionOpenRouter:
		return openRouterAPIBase
	case model.AiConnectionAnthropic:
		return anthropicAPIBase
	case model.AiConnectionOpenAI:
		return openAIAPIBase
	}
	return ""
}

func aiConnectionNeedsKey(kind string) bool {
	switch kind {
	case model.AiConnectionOpenRouter, model.AiConnectionAnthropic, model.AiConnectionOpenAI:
		return true
	}
	return false
}

func aiConnectionProvider(kind string) string {
	if kind == model.AiConnectionAnthropic {
		return model.AiProviderAnthropic
	}
	return model.AiProviderOpenAI
}

func aiConnectionKeyHint(key string) string {
	key = strings.TrimSpace(key)
	if key == "" {
		return ""
	}
	if len(key) < 12 {
		return "…" + key[len(key)-2:]
	}
	prefix := key[:6]
	if index := strings.LastIndexByte(key[:min(len(key)-4, 10)], '-'); index >= 2 {
		prefix = key[:index+1]
	}
	return prefix + "…" + key[len(key)-3:]
}

func normalizeAiBaseURL(raw string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", errors.New("Enter the base URL of the API")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", fmt.Errorf("%s is not an http or https URL", trimmed)
	}
	for _, suffix := range []string{"/chat/completions", "/messages", "/models"} {
		trimmed = strings.TrimSuffix(trimmed, suffix)
	}
	return trimmed, nil
}

func newAiConnectionID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buf)
}

func sealAiConnectionKey(key string) (string, error) {
	sealed, err := encryptRequestStorePayload([]byte(key))
	if err != nil {
		return "", fmt.Errorf("Kurlo could not encrypt the key, so it was not saved: %v", err)
	}
	return string(sealed), nil
}

func savedAiConnectionKey(saved savedAiConnection) (string, error) {
	if saved.KeyEncrypted == "" {
		return "", nil
	}
	plaintext, err := decryptRequestStorePayload([]byte(saved.KeyEncrypted))
	if err != nil {
		return "", fmt.Errorf("Kurlo could not read the saved key of %s; add it again: %v", savedAiConnectionLabel(saved), err)
	}
	return strings.TrimSpace(string(plaintext)), nil
}

func savedAiConnectionLabel(saved savedAiConnection) string {
	if strings.TrimSpace(saved.Label) != "" {
		return saved.Label
	}
	return aiConnectionDefaultLabel(saved.Kind)
}

func aiConnectionView(saved savedAiConnection) model.AiConnection {
	return model.AiConnection{
		ID:       saved.ID,
		Kind:     saved.Kind,
		Label:    savedAiConnectionLabel(saved),
		BaseURL:  saved.BaseURL,
		Model:    saved.Model,
		HasKey:   saved.KeyEncrypted != "",
		KeyHint:  saved.KeyHint,
		Default:  saved.Default,
		Provider: aiConnectionProvider(saved.Kind),
	}
}

func aiConnectionsState(saved []savedAiConnection, err error) model.AiConnectionsState {
	state := model.AiConnectionsState{Connections: []model.AiConnection{}}
	for _, connection := range saved {
		state.Connections = append(state.Connections, aiConnectionView(connection))
	}
	if err != nil {
		state.Error = err.Error()
	}
	return state
}

func ensureOneDefaultAiConnection(connections []savedAiConnection) {
	found := false
	for i := range connections {
		if connections[i].Default {
			if found {
				connections[i].Default = false
			}
			found = true
		}
	}
	if !found && len(connections) > 0 {
		connections[0].Default = true
	}
}

func buildSavedAiConnection(input model.AiConnectionInput, existing *savedAiConnection) (savedAiConnection, error) {
	kind := strings.TrimSpace(input.Kind)
	if existing != nil && kind == "" {
		kind = existing.Kind
	}
	if !aiConnectionKindKnown(kind) {
		return savedAiConnection{}, fmt.Errorf("unknown AI connection type %q", kind)
	}
	saved := savedAiConnection{Kind: kind}
	if existing != nil {
		if existing.Kind != kind {
			return savedAiConnection{}, errors.New("the type of a saved AI connection cannot change; add a new connection instead")
		}
		saved = *existing
	} else {
		saved.ID = newAiConnectionID()
	}
	saved.Label = strings.TrimSpace(input.Label)
	saved.Model = strings.TrimSpace(input.Model)

	base := strings.TrimSpace(input.BaseURL)
	if base == "" {
		base = aiConnectionDefaultBaseURL(kind)
	}
	normalized, err := normalizeAiBaseURL(base)
	if err != nil {
		return savedAiConnection{}, err
	}
	saved.BaseURL = normalized

	key := strings.TrimSpace(input.Key)
	if key != "" {
		sealed, err := sealAiConnectionKey(key)
		if err != nil {
			return savedAiConnection{}, err
		}
		saved.KeyEncrypted = sealed
		saved.KeyHint = aiConnectionKeyHint(key)
	}
	if saved.KeyEncrypted == "" && aiConnectionNeedsKey(kind) {
		return savedAiConnection{}, errors.New("Enter the API key")
	}
	return saved, nil
}

func loadSavedAiConnections() ([]savedAiConnection, error) {
	preferences, err := loadAppPreferences()
	if err != nil {
		return nil, fmt.Errorf("Kurlo could not read its settings: %v", err)
	}
	return preferences.AiConnections, nil
}

func updateSavedAiConnections(change func([]savedAiConnection) ([]savedAiConnection, error)) ([]savedAiConnection, error) {
	aiConnectionsMu.Lock()
	defer aiConnectionsMu.Unlock()
	preferences, err := loadAppPreferences()
	if err != nil {
		return nil, fmt.Errorf("Kurlo could not read its settings: %v", err)
	}
	next, err := change(append([]savedAiConnection(nil), preferences.AiConnections...))
	if err != nil {
		return preferences.AiConnections, err
	}
	ensureOneDefaultAiConnection(next)
	preferences.AiConnections = next
	if err := saveAppPreferences(preferences); err != nil {
		return preferences.AiConnections, fmt.Errorf("Kurlo could not save its settings: %v", err)
	}
	return next, nil
}

func upsertAiConnection(input model.AiConnectionInput) (savedAiConnection, []savedAiConnection, error) {
	var result savedAiConnection
	connections, err := updateSavedAiConnections(func(connections []savedAiConnection) ([]savedAiConnection, error) {
		id := strings.TrimSpace(input.ID)
		if id == "" {
			if len(connections) >= aiConnectionLimit {
				return nil, errAiConnectionLimit
			}
			saved, err := buildSavedAiConnection(input, nil)
			if err != nil {
				return nil, err
			}
			result = saved
			return append(connections, saved), nil
		}
		for i := range connections {
			if connections[i].ID != id {
				continue
			}
			saved, err := buildSavedAiConnection(input, &connections[i])
			if err != nil {
				return nil, err
			}
			connections[i] = saved
			result = saved
			return connections, nil
		}
		return nil, errAiConnectionNotFound
	})
	return result, connections, err
}

func findSavedAiConnection(id string) (savedAiConnection, error) {
	connections, err := loadSavedAiConnections()
	if err != nil {
		return savedAiConnection{}, err
	}
	for _, connection := range connections {
		if connection.ID == id {
			return connection, nil
		}
	}
	return savedAiConnection{}, errAiConnectionNotFound
}

func (a *App) AiConnections() model.AiConnectionsState {
	return aiConnectionsState(loadSavedAiConnections())
}

func (a *App) SaveAiConnection(input model.AiConnectionInput) model.AiConnectionsState {
	_, connections, err := upsertAiConnection(input)
	return aiConnectionsState(connections, err)
}

func (a *App) RemoveAiConnection(id string) model.AiConnectionsState {
	return aiConnectionsState(updateSavedAiConnections(func(connections []savedAiConnection) ([]savedAiConnection, error) {
		next := connections[:0]
		for _, connection := range connections {
			if connection.ID != id {
				next = append(next, connection)
			}
		}
		return next, nil
	}))
}

func (a *App) SetDefaultAiConnection(id string) model.AiConnectionsState {
	return aiConnectionsState(updateSavedAiConnections(func(connections []savedAiConnection) ([]savedAiConnection, error) {
		found := false
		for i := range connections {
			connections[i].Default = connections[i].ID == id
			found = found || connections[i].Default
		}
		if !found {
			return nil, errAiConnectionNotFound
		}
		return connections, nil
	}))
}

func defaultSavedAiConnection() (savedAiConnection, error) {
	connections, err := loadSavedAiConnections()
	if err != nil {
		return savedAiConnection{}, err
	}
	for _, connection := range connections {
		if connection.Default {
			return connection, nil
		}
	}
	if len(connections) > 0 {
		return connections[0], nil
	}
	return savedAiConnection{}, errors.New("No AI connection yet: connect a model in Settings → AI to use the Kurlo connection")
}

func resolveKurloAiRequest(req model.AiRequest) (model.AiRequest, string, error) {
	var connection savedAiConnection
	var err error
	if id := strings.TrimSpace(req.ConnectionID); id != "" {
		connection, err = findSavedAiConnection(id)
		if errors.Is(err, errAiConnectionNotFound) {
			err = errors.New("The AI connection this request uses no longer exists; pick another one in the request or in Settings → AI")
		}
	} else {
		connection, err = defaultSavedAiConnection()
	}
	if err != nil {
		return req, "", err
	}
	return resolveAiConnectionRequest(req, connection)
}

func resolveAiConnectionRequest(req model.AiRequest, connection savedAiConnection) (model.AiRequest, string, error) {
	key, err := savedAiConnectionKey(connection)
	if err != nil {
		return req, "", err
	}
	if key == "" && aiConnectionNeedsKey(connection.Kind) {
		return req, "", fmt.Errorf("%s has no key; add it again in Settings → AI", savedAiConnectionLabel(connection))
	}
	if strings.TrimSpace(req.Model) == "" {
		req.Model = connection.Model
	}
	if strings.TrimSpace(req.Model) == "" {
		return req, "", fmt.Errorf("Choose a model for this request or for %s in Settings → AI", savedAiConnectionLabel(connection))
	}
	req.Provider = aiConnectionProvider(connection.Kind)
	req.HTTP.URL = connection.BaseURL
	req.HTTP.Auth = model.AuthConfig{Type: "none"}
	headers := make([]model.KeyValue, 0, len(req.HTTP.Headers)+4)
	for _, header := range req.HTTP.Headers {
		switch strings.ToLower(strings.TrimSpace(header.Key)) {
		case "authorization", "x-api-key", "http-referer", "x-title":
			continue
		}
		headers = append(headers, header)
	}
	for name, values := range aiConnectionHeaders(connection.Kind, key) {
		if strings.EqualFold(name, "Accept") {
			continue
		}
		for _, value := range values {
			headers = append(headers, model.KeyValue{Key: name, Value: value, Enabled: true})
		}
	}
	req.HTTP.Headers = headers
	if key != "" {
		req.HTTP.SecretEnvironmentValues = append(append([]string(nil), req.HTTP.SecretEnvironmentValues...), key)
	}
	return req, key, nil
}

func redactAiResponseKey(out model.AiResponse, key string) model.AiResponse {
	key = strings.TrimSpace(key)
	if len(key) < 4 {
		return out
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return out
	}
	escaped, _ := json.Marshal(key)
	needle := strings.Trim(string(escaped), `"`)
	if !strings.Contains(string(encoded), needle) {
		return out
	}
	var redacted model.AiResponse
	if err := json.Unmarshal([]byte(strings.ReplaceAll(string(encoded), needle, "[your key]")), &redacted); err != nil {
		return out
	}
	return redacted
}
