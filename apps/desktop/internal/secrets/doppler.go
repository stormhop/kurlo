package secrets

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const dopplerDefaultAddress = "https://api.doppler.com"

type dopplerProvider struct {
	config      ProviderConfig
	credentials Credentials
	env         Environment
	client      *http.Client
	tokens      tokenCache
}

func newDopplerProvider(config ProviderConfig, credentials Credentials, env Environment) *dopplerProvider {
	return &dopplerProvider{config: config, credentials: credentials, env: env, client: newRESTClient(config)}
}

func (p *dopplerProvider) base() string {
	if p.config.Address != "" {
		return strings.TrimRight(p.config.Address, "/")
	}
	return dopplerDefaultAddress
}

func (p *dopplerProvider) token(ctx context.Context) (string, string, error) {
	if token, ok := p.credentials("token"); ok && strings.TrimSpace(token) != "" {
		return strings.TrimSpace(token), "token saved on this device", nil
	}
	if token, ok := p.env.Getenv("DOPPLER_TOKEN"); ok && strings.TrimSpace(token) != "" {
		return strings.TrimSpace(token), "DOPPLER_TOKEN", nil
	}
	if token, source, ok := p.tokens.get(p.env.Now()); ok {
		return token, source, nil
	}
	path, err := p.env.LookPath("doppler")
	if err != nil {
		return "", "", newError(KindNotAuthenticated, p.config.ID, "no Doppler token: set DOPPLER_TOKEN, run doppler login, or save a token for this provider")
	}
	stdout, stderr, err := p.env.Run(ctx, path, []string{"configure", "get", "token", "--plain", "--scope", "/"}, nil)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", "", newError(KindTimeout, p.config.ID, "doppler did not answer before the timeout")
		}
		return "", "", newError(KindNotAuthenticated, p.config.ID, "%s", toolMessage(stderr, err))
	}
	token := strings.TrimSpace(string(stdout))
	if token == "" {
		return "", "", newError(KindNotAuthenticated, p.config.ID, "the Doppler CLI is not signed in; run doppler login")
	}
	p.tokens.set(token, "doppler CLI", p.env.Now().Add(DefaultCacheTTL))
	return token, "doppler CLI", nil
}

func (p *dopplerProvider) get(ctx context.Context, route string, query url.Values, path string) ([]byte, error) {
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
	var decoded struct {
		Messages []string `json:"messages"`
	}
	_ = json.Unmarshal(data, &decoded)
	if err := statusKindError(p.config.ID, status, shortText(strings.Join(decoded.Messages, "; ")), path); err != nil {
		return nil, err
	}
	return data, nil
}

func dopplerSegments(path string) []string {
	var out []string
	for _, segment := range strings.Split(strings.Trim(strings.TrimSpace(path), "/"), "/") {
		if segment != "" {
			out = append(out, segment)
		}
	}
	return out
}

func (p *dopplerProvider) Fetch(ctx context.Context, path, _ string) (Secret, error) {
	segments := dopplerSegments(path)
	switch {
	case len(segments) == 2:
		data, err := p.get(ctx, "/v3/configs/config/secrets/download", url.Values{"project": {segments[0]}, "config": {segments[1]}, "format": {"json"}}, path)
		if err != nil {
			return Secret{}, err
		}
		var values map[string]any
		if err := json.Unmarshal(data, &values); err != nil {
			return Secret{}, newError(KindUnavailable, p.config.ID, "unexpected answer for %s", path)
		}
		return Secret{Fields: stringifyFields(values)}, nil
	case len(segments) >= 3:
		name := strings.Join(segments[2:], "/")
		data, err := p.get(ctx, "/v3/configs/config/secret", url.Values{"project": {segments[0]}, "config": {segments[1]}, "name": {name}}, path)
		if err != nil {
			return Secret{}, err
		}
		var decoded struct {
			Value struct {
				Computed *string `json:"computed"`
				Raw      *string `json:"raw"`
			} `json:"value"`
		}
		if err := json.Unmarshal(data, &decoded); err != nil {
			return Secret{}, newError(KindUnavailable, p.config.ID, "unexpected answer for %s", path)
		}
		switch {
		case decoded.Value.Computed != nil:
			return Secret{Raw: *decoded.Value.Computed}, nil
		case decoded.Value.Raw != nil:
			return Secret{Raw: *decoded.Value.Raw}, nil
		default:
			return Secret{}, newError(KindNotFound, p.config.ID, "no secret at %s", path)
		}
	default:
		return Secret{}, newError(KindInvalidRef, p.config.ID, "use project/config and a field, or project/config/SECRET_NAME")
	}
}

func (p *dopplerProvider) Check(ctx context.Context) (Status, error) {
	data, err := p.get(ctx, "/v3/me", nil, "/v3/me")
	if err != nil {
		return Status{}, err
	}
	var decoded struct {
		Name      string `json:"name"`
		Type      string `json:"type"`
		Workplace struct {
			Name string `json:"name"`
		} `json:"workplace"`
	}
	_ = json.Unmarshal(data, &decoded)
	_, source, _ := p.token(ctx)
	parts := []string{}
	if decoded.Workplace.Name != "" {
		parts = append(parts, "Workplace "+decoded.Workplace.Name)
	}
	if decoded.Type != "" {
		parts = append(parts, strings.ReplaceAll(decoded.Type, "_", " "))
	}
	parts = append(parts, "token from "+source)
	return Status{Detail: strings.Join(parts, " · ")}, nil
}

func (p *dopplerProvider) List(ctx context.Context, prefix string) ([]Entry, error) {
	segments := dopplerSegments(prefix)
	var entries []Entry
	switch len(segments) {
	case 0:
		for page := 1; len(entries) < maxEntries; page++ {
			query := url.Values{"page": {strconv.Itoa(page)}, "per_page": {"100"}}
			data, err := p.get(ctx, "/v3/projects", query, "projects")
			if err != nil {
				return nil, err
			}
			var decoded struct {
				Projects []struct {
					Slug string `json:"slug"`
					Name string `json:"name"`
				} `json:"projects"`
			}
			if err := json.Unmarshal(data, &decoded); err != nil {
				return nil, newError(KindUnavailable, p.config.ID, "unexpected answer when listing projects")
			}
			for _, project := range decoded.Projects {
				entries = append(entries, Entry{Name: project.Name, Browse: project.Slug, Detail: "project"})
			}
			if len(decoded.Projects) < 100 {
				break
			}
		}
	case 1:
		for page := 1; len(entries) < maxEntries; page++ {
			query := url.Values{"project": {segments[0]}, "page": {strconv.Itoa(page)}, "per_page": {"100"}}
			data, err := p.get(ctx, "/v3/configs", query, segments[0])
			if err != nil {
				return nil, err
			}
			var decoded struct {
				Configs []struct {
					Name        string `json:"name"`
					Environment string `json:"environment"`
				} `json:"configs"`
			}
			if err := json.Unmarshal(data, &decoded); err != nil {
				return nil, newError(KindUnavailable, p.config.ID, "unexpected answer when listing configs")
			}
			for _, config := range decoded.Configs {
				path := segments[0] + "/" + config.Name
				entries = append(entries, Entry{Name: config.Name, Path: path, Browse: path, Detail: config.Environment})
			}
			if len(decoded.Configs) < 100 {
				break
			}
		}
	default:
		data, err := p.get(ctx, "/v3/configs/config/secrets/names", url.Values{"project": {segments[0]}, "config": {segments[1]}}, prefix)
		if err != nil {
			return nil, err
		}
		var decoded struct {
			Names []string `json:"names"`
		}
		if err := json.Unmarshal(data, &decoded); err != nil {
			return nil, newError(KindUnavailable, p.config.ID, "unexpected answer when listing secret names")
		}
		path := segments[0] + "/" + segments[1]
		for _, name := range decoded.Names {
			entries = append(entries, Entry{Name: name, Path: path, Field: name})
		}
	}
	return capEntries(entries), nil
}
