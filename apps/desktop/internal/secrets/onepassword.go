package secrets

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

type onePasswordProvider struct {
	config      ProviderConfig
	credentials Credentials
	env         Environment
}

type onePasswordItem struct {
	Fields []struct {
		ID      string `json:"id"`
		Label   string `json:"label"`
		Value   any    `json:"value"`
		Section struct {
			ID    string `json:"id"`
			Label string `json:"label"`
		} `json:"section"`
	} `json:"fields"`
}

func (p *onePasswordProvider) run(ctx context.Context, args ...string) ([]byte, error) {
	path, err := p.env.LookPath("op")
	if err != nil {
		return nil, newError(KindToolMissing, p.config.ID, "the 1Password CLI (op) is not installed or not in PATH")
	}
	if p.config.Account != "" {
		args = append([]string{"--account", p.config.Account}, args...)
	}
	var extra []string
	if token, ok := p.credentials("token"); ok && strings.TrimSpace(token) != "" {
		extra = append(extra, "OP_SERVICE_ACCOUNT_TOKEN="+strings.TrimSpace(token))
	}
	stdout, stderr, err := p.env.Run(ctx, path, args, extra)
	if err == nil {
		return stdout, nil
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, newError(KindTimeout, p.config.ID, "op did not answer before the timeout; unlock 1Password and try again")
	}
	message := toolMessage(stderr, err)
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "not currently signed in"), strings.Contains(lower, "not signed in"), strings.Contains(lower, "authorization prompt dismissed"),
		strings.Contains(lower, "session expired"), strings.Contains(lower, "no accounts configured"), strings.Contains(lower, "invalid token"):
		return nil, newError(KindNotAuthenticated, p.config.ID, "%s", message)
	case strings.Contains(lower, "isn't an item"), strings.Contains(lower, "could not find"), strings.Contains(lower, "isn't a vault"),
		strings.Contains(lower, "no item found"), strings.Contains(lower, "does not have a field"), strings.Contains(lower, "not found"):
		return nil, newError(KindNotFound, p.config.ID, "%s", message)
	case strings.Contains(lower, "forbidden"), strings.Contains(lower, "not authorized"), strings.Contains(lower, "permission"):
		return nil, newError(KindForbidden, p.config.ID, "%s", message)
	default:
		return nil, newError(KindUnavailable, p.config.ID, "%s", message)
	}
}

func onePasswordSegments(path string) []string {
	trimmed := strings.TrimPrefix(strings.TrimSpace(path), "op://")
	var segments []string
	for _, segment := range strings.Split(trimmed, "/") {
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	return segments
}

func (p *onePasswordProvider) Fetch(ctx context.Context, path, _ string) (Secret, error) {
	segments := onePasswordSegments(path)
	switch {
	case len(segments) >= 3:
		stdout, err := p.run(ctx, "read", "--no-newline", "op://"+strings.Join(segments, "/"))
		if err != nil {
			return Secret{}, err
		}
		return Secret{Raw: string(stdout)}, nil
	case len(segments) == 2:
		stdout, err := p.run(ctx, "item", "get", segments[1], "--vault", segments[0], "--format", "json")
		if err != nil {
			return Secret{}, err
		}
		var item onePasswordItem
		if err := json.Unmarshal(stdout, &item); err != nil {
			return Secret{}, newError(KindUnavailable, p.config.ID, "unexpected answer from op item get")
		}
		fields := map[string]any{}
		labelCounts := map[string]int{}
		for _, field := range item.Fields {
			label := field.Label
			if label == "" {
				label = field.ID
			}
			labelCounts[label]++
		}
		for _, field := range item.Fields {
			if field.Value == nil {
				continue
			}
			name := field.Label
			if name == "" {
				name = field.ID
			}
			section := field.Section.Label
			if section == "" {
				section = field.Section.ID
			}
			if section != "" && labelCounts[name] > 1 {
				name = section + "/" + name
			}
			if _, exists := fields[name]; !exists {
				fields[name] = field.Value
			}
		}
		return Secret{Fields: stringifyFields(fields)}, nil
	default:
		return Secret{}, newError(KindInvalidRef, p.config.ID, "use a path like op://Vault/Item or op://Vault/Item/field")
	}
}

func (p *onePasswordProvider) Check(ctx context.Context) (Status, error) {
	stdout, err := p.run(ctx, "whoami", "--format", "json")
	if err != nil {
		return Status{}, err
	}
	var who struct {
		URL         string `json:"url"`
		Email       string `json:"email"`
		UserType    string `json:"user_type"`
		ServiceName string `json:"service_account_name"`
	}
	_ = json.Unmarshal(stdout, &who)
	detail := "Signed in"
	switch {
	case who.Email != "" && who.URL != "":
		detail = "Signed in as " + who.Email + " on " + who.URL
	case who.URL != "":
		detail = "Signed in on " + who.URL
	}
	return Status{Detail: detail}, nil
}

func (p *onePasswordProvider) List(ctx context.Context, prefix string) ([]Entry, error) {
	segments := onePasswordSegments(prefix)
	var entries []Entry
	switch len(segments) {
	case 0:
		stdout, err := p.run(ctx, "vault", "list", "--format", "json")
		if err != nil {
			return nil, err
		}
		var vaults []struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(stdout, &vaults); err != nil {
			return nil, newError(KindUnavailable, p.config.ID, "unexpected answer from op vault list")
		}
		for _, vault := range vaults {
			entries = append(entries, Entry{Name: vault.Name, Browse: "op://" + vault.Name + "/", Detail: "vault"})
		}
	case 1:
		stdout, err := p.run(ctx, "item", "list", "--vault", segments[0], "--format", "json")
		if err != nil {
			return nil, err
		}
		var items []struct {
			Title    string `json:"title"`
			Category string `json:"category"`
		}
		if err := json.Unmarshal(stdout, &items); err != nil {
			return nil, newError(KindUnavailable, p.config.ID, "unexpected answer from op item list")
		}
		for _, item := range items {
			if strings.Contains(item.Title, "/") {
				continue
			}
			path := "op://" + segments[0] + "/" + item.Title
			entries = append(entries, Entry{Name: item.Title, Path: path, Browse: path + "/", Detail: strings.ToLower(strings.ReplaceAll(item.Category, "_", " "))})
		}
	default:
		secret, err := p.Fetch(ctx, "op://"+segments[0]+"/"+segments[1], "")
		if err != nil {
			return nil, err
		}
		item := "op://" + segments[0] + "/" + segments[1]
		for _, name := range secret.FieldNames() {
			label := strings.ReplaceAll(name, "/", " · ")
			entries = append(entries, Entry{Name: label, Path: item, Field: name})
		}
	}
	sortEntries(entries)
	return capEntries(entries), nil
}
