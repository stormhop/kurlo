package secrets

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
)

const infisicalDefaultAddress = "https://app.infisical.com"

type infisicalProvider struct {
	config      ProviderConfig
	credentials Credentials
	env         Environment
	client      *http.Client
	tokens      tokenCache
}

func newInfisicalProvider(config ProviderConfig, credentials Credentials, env Environment) *infisicalProvider {
	return &infisicalProvider{config: config, credentials: credentials, env: env, client: newRESTClient(config)}
}

func (p *infisicalProvider) base() string {
	if p.config.Address != "" {
		return strings.TrimRight(p.config.Address, "/")
	}
	return infisicalDefaultAddress
}

type infisicalMessage struct {
	Message string `json:"message"`
}

func (p *infisicalProvider) token(ctx context.Context) (string, string, error) {
	if p.config.Auth.Method != "universal" {
		if token, ok := p.credentials("token"); ok && strings.TrimSpace(token) != "" {
			return strings.TrimSpace(token), "token saved on this device", nil
		}
		if token, ok := p.env.Getenv("INFISICAL_TOKEN"); ok && strings.TrimSpace(token) != "" {
			return strings.TrimSpace(token), "INFISICAL_TOKEN", nil
		}
		return "", "", newError(KindNotAuthenticated, p.config.ID, "no Infisical token: set INFISICAL_TOKEN or save a token for this provider")
	}
	if token, source, ok := p.tokens.get(p.env.Now()); ok {
		return token, source, nil
	}
	secret, ok := p.credentials("clientSecret")
	if !ok || strings.TrimSpace(secret) == "" {
		secret, ok = p.env.Getenv("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET")
	}
	if !ok || strings.TrimSpace(secret) == "" {
		return "", "", newError(KindNotAuthenticated, p.config.ID, "no client secret: set INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET or save it for this provider")
	}
	payload, _ := json.Marshal(map[string]string{"clientId": p.config.Auth.ClientID, "clientSecret": strings.TrimSpace(secret)})
	data, status, err := restCall(ctx, p.client, p.config.ID, http.MethodPost, p.base()+"/api/v1/auth/universal-auth/login", map[string]string{"Content-Type": "application/json"}, bytes.NewReader(payload))
	if err != nil {
		return "", "", err
	}
	var decoded struct {
		AccessToken string `json:"accessToken"`
		ExpiresIn   int64  `json:"expiresIn"`
		Message     string `json:"message"`
	}
	_ = json.Unmarshal(data, &decoded)
	if status < 200 || status >= 300 || decoded.AccessToken == "" {
		message := shortText(decoded.Message)
		if message == "" {
			message = "HTTP " + http.StatusText(status)
		}
		if status >= 500 {
			return "", "", newError(KindUnavailable, p.config.ID, "login failed: %s", message)
		}
		return "", "", newError(KindNotAuthenticated, p.config.ID, "login failed: %s", message)
	}
	source := "machine identity " + p.config.Auth.ClientID
	p.tokens.set(decoded.AccessToken, source, expiryWithMargin(p.env.Now(), decoded.ExpiresIn))
	return decoded.AccessToken, source, nil
}

func (p *infisicalProvider) get(ctx context.Context, route string, query url.Values, path string) ([]byte, error) {
	token, _, err := p.token(ctx)
	if err != nil {
		return nil, err
	}
	endpoint := p.base() + route
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	data, status, err := restCall(ctx, p.client, p.config.ID, http.MethodGet, endpoint, map[string]string{"Authorization": "Bearer " + token}, nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized {
		p.tokens.clear()
	}
	var decoded infisicalMessage
	_ = json.Unmarshal(data, &decoded)
	if err := statusKindError(p.config.ID, status, shortText(decoded.Message), path); err != nil {
		return nil, err
	}
	return data, nil
}

func infisicalLocation(path string) (string, string) {
	trimmed := strings.Trim(strings.TrimSpace(path), "/")
	environment, folder, _ := strings.Cut(trimmed, "/")
	return environment, "/" + folder
}

func (p *infisicalProvider) Fetch(ctx context.Context, path, _ string) (Secret, error) {
	environment, folder := infisicalLocation(path)
	if environment == "" {
		return Secret{}, newError(KindInvalidRef, p.config.ID, "use an environment slug and an optional folder, like prod or prod/backend")
	}
	data, err := p.get(ctx, "/api/v3/secrets/raw", url.Values{
		"workspaceId":            {p.config.Project},
		"environment":            {environment},
		"secretPath":             {folder},
		"expandSecretReferences": {"true"},
	}, path)
	if err != nil {
		return Secret{}, err
	}
	var decoded struct {
		Secrets []struct {
			Key   string `json:"secretKey"`
			Value string `json:"secretValue"`
		} `json:"secrets"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return Secret{}, newError(KindUnavailable, p.config.ID, "unexpected answer for %s", path)
	}
	fields := make(map[string]string, len(decoded.Secrets))
	for _, secret := range decoded.Secrets {
		fields[secret.Key] = secret.Value
	}
	return Secret{Fields: fields}, nil
}

type infisicalProject struct {
	Workspace struct {
		Name         string `json:"name"`
		Environments []struct {
			Name string `json:"name"`
			Slug string `json:"slug"`
		} `json:"environments"`
	} `json:"workspace"`
}

func (p *infisicalProvider) project(ctx context.Context) (infisicalProject, error) {
	data, err := p.get(ctx, "/api/v1/workspace/"+url.PathEscape(p.config.Project), nil, "project "+p.config.Project)
	if err != nil {
		return infisicalProject{}, err
	}
	var decoded infisicalProject
	if err := json.Unmarshal(data, &decoded); err != nil {
		return infisicalProject{}, newError(KindUnavailable, p.config.ID, "unexpected answer for project %s", p.config.Project)
	}
	return decoded, nil
}

func (p *infisicalProvider) Check(ctx context.Context) (Status, error) {
	project, err := p.project(ctx)
	if err != nil {
		return Status{}, err
	}
	_, source, _ := p.token(ctx)
	name := project.Workspace.Name
	if name == "" {
		name = p.config.Project
	}
	return Status{Detail: "Project " + name + " · " + source}, nil
}

func (p *infisicalProvider) List(ctx context.Context, prefix string) ([]Entry, error) {
	environment, folder := infisicalLocation(prefix)
	if environment == "" {
		project, err := p.project(ctx)
		if err != nil {
			return nil, err
		}
		entries := make([]Entry, 0, len(project.Workspace.Environments))
		for _, item := range project.Workspace.Environments {
			entries = append(entries, Entry{Name: item.Slug, Path: item.Slug, Browse: item.Slug, Detail: item.Name})
		}
		return entries, nil
	}
	location := strings.Trim(environment+folder, "/")
	data, err := p.get(ctx, "/api/v1/folders", url.Values{"workspaceId": {p.config.Project}, "environment": {environment}, "path": {folder}}, location)
	if err != nil {
		return nil, err
	}
	var decoded struct {
		Folders []struct {
			Name string `json:"name"`
		} `json:"folders"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return nil, newError(KindUnavailable, p.config.ID, "unexpected answer when listing folders")
	}
	var entries []Entry
	for _, item := range decoded.Folders {
		path := location + "/" + item.Name
		entries = append(entries, Entry{Name: item.Name + "/", Path: path, Browse: path, Detail: "folder"})
	}
	secret, err := p.Fetch(ctx, location, "")
	if err != nil {
		return nil, err
	}
	for _, name := range secret.FieldNames() {
		entries = append(entries, Entry{Name: name, Path: location, Field: name})
	}
	return capEntries(entries), nil
}
