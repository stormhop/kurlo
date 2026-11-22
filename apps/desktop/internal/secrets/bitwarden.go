package secrets

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type bitwardenProvider struct {
	config      ProviderConfig
	credentials Credentials
	env         Environment
}

type bitwardenSecret struct {
	ID        string `json:"id"`
	Key       string `json:"key"`
	Value     string `json:"value"`
	ProjectID string `json:"projectId"`
}

func (p *bitwardenProvider) run(ctx context.Context, args ...string) ([]byte, error) {
	path, err := p.env.LookPath("bws")
	if err != nil {
		return nil, newError(KindToolMissing, p.config.ID, "the Bitwarden Secrets Manager CLI (bws) is not installed or not in PATH")
	}
	var extra []string
	if token, ok := p.credentials("token"); ok && strings.TrimSpace(token) != "" {
		extra = append(extra, "BWS_ACCESS_TOKEN="+strings.TrimSpace(token))
	} else if token, ok := p.env.Getenv("BWS_ACCESS_TOKEN"); !ok || strings.TrimSpace(token) == "" {
		return nil, newError(KindNotAuthenticated, p.config.ID, "no access token: set BWS_ACCESS_TOKEN or save a machine account token for this provider")
	}
	args = append(args, "--output", "json", "--color", "no")
	if p.config.Address != "" {
		args = append(args, "--server-url", p.config.Address)
	}
	stdout, stderr, err := p.env.Run(ctx, path, args, extra)
	if err == nil {
		return stdout, nil
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, newError(KindTimeout, p.config.ID, "bws did not answer before the timeout")
	}
	message := toolMessage(stderr, err)
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "401"), strings.Contains(lower, "unauthorized"), strings.Contains(lower, "access token"), strings.Contains(lower, "invalid_client"):
		return nil, newError(KindNotAuthenticated, p.config.ID, "%s", message)
	case strings.Contains(lower, "404"), strings.Contains(lower, "not found"):
		return nil, newError(KindNotFound, p.config.ID, "%s", message)
	case strings.Contains(lower, "403"), strings.Contains(lower, "forbidden"):
		return nil, newError(KindForbidden, p.config.ID, "%s", message)
	default:
		return nil, newError(KindUnavailable, p.config.ID, "%s", message)
	}
}

func (p *bitwardenProvider) list(ctx context.Context, projectID string) ([]bitwardenSecret, error) {
	args := []string{"secret", "list"}
	if projectID != "" {
		args = append(args, projectID)
	}
	stdout, err := p.run(ctx, args...)
	if err != nil {
		return nil, err
	}
	var secrets []bitwardenSecret
	if err := json.Unmarshal(stdout, &secrets); err != nil {
		return nil, newError(KindUnavailable, p.config.ID, "unexpected answer from bws secret list")
	}
	return secrets, nil
}

func (p *bitwardenProvider) Fetch(ctx context.Context, path, _ string) (Secret, error) {
	path = strings.Trim(strings.TrimSpace(path), "/")
	switch {
	case path == "":
		return Secret{}, newError(KindInvalidRef, p.config.ID, "path is empty")
	case strings.HasPrefix(path, "projects/"):
		projectID := strings.TrimPrefix(path, "projects/")
		if !uuidPattern.MatchString(projectID) {
			return Secret{}, newError(KindInvalidRef, p.config.ID, "use projects/<project id>")
		}
		secrets, err := p.list(ctx, projectID)
		if err != nil {
			return Secret{}, err
		}
		fields := map[string]string{}
		for _, secret := range secrets {
			if _, taken := fields[secret.Key]; !taken {
				fields[secret.Key] = secret.Value
			}
		}
		return Secret{Fields: fields}, nil
	case uuidPattern.MatchString(path):
		stdout, err := p.run(ctx, "secret", "get", path)
		if err != nil {
			return Secret{}, err
		}
		var secret bitwardenSecret
		if err := json.Unmarshal(stdout, &secret); err != nil {
			return Secret{}, newError(KindUnavailable, p.config.ID, "unexpected answer from bws secret get")
		}
		return Secret{Raw: secret.Value}, nil
	default:
		secrets, err := p.list(ctx, "")
		if err != nil {
			return Secret{}, err
		}
		var found []bitwardenSecret
		for _, secret := range secrets {
			if secret.Key == path {
				found = append(found, secret)
			}
		}
		switch len(found) {
		case 0:
			return Secret{}, newError(KindNotFound, p.config.ID, "no secret named %s that this machine account can read", path)
		case 1:
			return Secret{Raw: found[0].Value}, nil
		default:
			return Secret{}, newError(KindInvalidRef, p.config.ID, "%d secrets are named %s; use the secret id instead", len(found), path)
		}
	}
}

func (p *bitwardenProvider) Check(ctx context.Context) (Status, error) {
	stdout, err := p.run(ctx, "project", "list")
	if err != nil {
		return Status{}, err
	}
	var projects []json.RawMessage
	_ = json.Unmarshal(stdout, &projects)
	detail := "Machine account can read 1 project"
	if len(projects) != 1 {
		detail = "Machine account can read " + strconv.Itoa(len(projects)) + " projects"
	}
	return Status{Detail: detail}, nil
}

func (p *bitwardenProvider) List(ctx context.Context, prefix string) ([]Entry, error) {
	prefix = strings.Trim(strings.TrimSpace(prefix), "/")
	if prefix == "" {
		stdout, err := p.run(ctx, "project", "list")
		if err != nil {
			return nil, err
		}
		var projects []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(stdout, &projects); err != nil {
			return nil, newError(KindUnavailable, p.config.ID, "unexpected answer from bws project list")
		}
		entries := make([]Entry, 0, len(projects))
		for _, project := range projects {
			entries = append(entries, Entry{Name: project.Name, Path: "projects/" + project.ID, Browse: "projects/" + project.ID, Detail: "project"})
		}
		return capEntries(entries), nil
	}
	projectID := strings.TrimPrefix(prefix, "projects/")
	secrets, err := p.list(ctx, projectID)
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(secrets))
	for _, secret := range secrets {
		entries = append(entries, Entry{Name: secret.Key, Path: secret.ID, Detail: secret.ID})
	}
	return capEntries(entries), nil
}
