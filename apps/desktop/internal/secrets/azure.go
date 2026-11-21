package secrets

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var azureAuthorityHost = "https://login.microsoftonline.com"

const (
	azureVaultResource = "https://vault.azure.net"
	azureAPIVersion    = "7.4"
)

type azureProvider struct {
	config      ProviderConfig
	credentials Credentials
	env         Environment
	client      *http.Client
	tokens      tokenCache
}

func newAzureProvider(config ProviderConfig, credentials Credentials, env Environment) *azureProvider {
	return &azureProvider{config: config, credentials: credentials, env: env, client: newRESTClient(config)}
}

func (p *azureProvider) vaultURL() string {
	return strings.TrimRight(p.config.Address, "/")
}

func (p *azureProvider) accessToken(ctx context.Context) (string, string, error) {
	if token, source, ok := p.tokens.get(p.env.Now()); ok {
		return token, source, nil
	}
	var token, source string
	var expires time.Time
	var err error
	if p.config.Auth.Method == "client-secret" {
		token, source, expires, err = p.clientSecretToken(ctx)
	} else {
		token, source, expires, err = p.cliToken(ctx)
	}
	if err != nil {
		return "", "", err
	}
	p.tokens.set(token, source, expires)
	return token, source, nil
}

func (p *azureProvider) clientSecretToken(ctx context.Context) (string, string, time.Time, error) {
	secret, ok := p.credentials("clientSecret")
	if !ok || strings.TrimSpace(secret) == "" {
		secret, ok = p.env.Getenv("AZURE_CLIENT_SECRET")
	}
	if !ok || strings.TrimSpace(secret) == "" {
		return "", "", time.Time{}, newError(KindNotAuthenticated, p.config.ID, "no client secret: set AZURE_CLIENT_SECRET or save it for this provider")
	}
	form := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {p.config.Auth.ClientID},
		"client_secret": {strings.TrimSpace(secret)},
		"scope":         {azureVaultResource + "/.default"},
	}
	endpoint := strings.TrimRight(azureAuthorityHost, "/") + "/" + url.PathEscape(p.config.Auth.TenantID) + "/oauth2/v2.0/token"
	response, err := postTokenForm(ctx, p.client, p.config.ID, endpoint, form)
	if err != nil {
		return "", "", time.Time{}, err
	}
	return response.AccessToken, "client " + p.config.Auth.ClientID, expiryWithMargin(p.env.Now(), response.expiresIn()), nil
}

func (p *azureProvider) cliToken(ctx context.Context) (string, string, time.Time, error) {
	path, err := p.env.LookPath("az")
	if err != nil {
		return "", "", time.Time{}, newError(KindToolMissing, p.config.ID, "the Azure CLI (az) is not installed or not in PATH")
	}
	args := []string{"account", "get-access-token", "--resource", azureVaultResource, "--output", "json"}
	if p.config.Auth.TenantID != "" {
		args = append(args, "--tenant", p.config.Auth.TenantID)
	}
	stdout, stderr, err := p.env.Run(ctx, path, args, nil)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", "", time.Time{}, newError(KindTimeout, p.config.ID, "az did not answer before the timeout")
		}
		message := toolMessage(stderr, err)
		lower := strings.ToLower(message)
		if strings.Contains(lower, "az login") || strings.Contains(lower, "expired") || strings.Contains(lower, "no subscription") || strings.Contains(lower, "aadsts") {
			return "", "", time.Time{}, newError(KindNotAuthenticated, p.config.ID, "%s", message)
		}
		return "", "", time.Time{}, newError(KindUnavailable, p.config.ID, "%s", message)
	}
	var decoded struct {
		AccessToken string `json:"accessToken"`
		ExpiresOn   int64  `json:"expires_on"`
	}
	if err := json.Unmarshal(stdout, &decoded); err != nil || decoded.AccessToken == "" {
		return "", "", time.Time{}, newError(KindNotAuthenticated, p.config.ID, "az returned no access token; run az login")
	}
	expires := p.env.Now().Add(10 * time.Minute)
	if decoded.ExpiresOn > 0 {
		expires = time.Unix(decoded.ExpiresOn, 0).Add(-time.Minute)
	}
	return decoded.AccessToken, "Azure CLI", expires, nil
}

type azureErrorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (p *azureProvider) get(ctx context.Context, endpoint, path string) ([]byte, error) {
	if !strings.HasPrefix(endpoint, p.vaultURL()+"/") {
		return nil, newError(KindUnavailable, p.config.ID, "the vault answered with a link to another host")
	}
	token, _, err := p.accessToken(ctx)
	if err != nil {
		return nil, err
	}
	data, status, err := restCall(ctx, p.client, p.config.ID, http.MethodGet, endpoint, map[string]string{"Authorization": "Bearer " + token}, nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized {
		p.tokens.clear()
	}
	var decoded azureErrorBody
	_ = json.Unmarshal(data, &decoded)
	if err := statusKindError(p.config.ID, status, shortText(decoded.Error.Message), path); err != nil {
		return nil, err
	}
	return data, nil
}

func (p *azureProvider) Fetch(ctx context.Context, path, version string) (Secret, error) {
	name := strings.Trim(strings.TrimSpace(path), "/")
	if name == "" {
		return Secret{}, newError(KindInvalidRef, p.config.ID, "path is empty")
	}
	if strings.Contains(name, "/") {
		return Secret{}, newError(KindInvalidRef, p.config.ID, "use the secret name, like db-password; put a version in the version field")
	}
	endpoint := p.vaultURL() + "/secrets/" + url.PathEscape(name)
	if version != "" && version != "latest" {
		endpoint += "/" + url.PathEscape(version)
	}
	data, err := p.get(ctx, endpoint+"?api-version="+azureAPIVersion, name)
	if err != nil {
		return Secret{}, err
	}
	var decoded struct {
		Value *string `json:"value"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil || decoded.Value == nil {
		return Secret{}, newError(KindUnavailable, p.config.ID, "unexpected answer for %s", name)
	}
	return Secret{Raw: *decoded.Value}, nil
}

func (p *azureProvider) Check(ctx context.Context) (Status, error) {
	if _, err := p.get(ctx, p.vaultURL()+"/secrets?api-version="+azureAPIVersion+"&maxresults=1", "secrets"); err != nil {
		if KindOf(err) == KindForbidden {
			return Status{}, listPermissionError(p.config.ID, err)
		}
		return Status{}, err
	}
	_, source, _ := p.tokens.get(p.env.Now())
	return Status{Detail: "Signed in with " + source}, nil
}

func (p *azureProvider) List(ctx context.Context, _ string) ([]Entry, error) {
	var entries []Entry
	next := p.vaultURL() + "/secrets?api-version=" + azureAPIVersion + "&maxresults=25"
	for page := 0; page < 40 && next != "" && len(entries) < maxEntries; page++ {
		data, err := p.get(ctx, next, "secrets")
		if err != nil {
			return nil, err
		}
		var decoded struct {
			Value []struct {
				ID         string `json:"id"`
				Attributes struct {
					Enabled bool `json:"enabled"`
				} `json:"attributes"`
				ContentType string `json:"contentType"`
			} `json:"value"`
			NextLink string `json:"nextLink"`
		}
		if err := json.Unmarshal(data, &decoded); err != nil {
			return nil, newError(KindUnavailable, p.config.ID, "unexpected answer when listing secrets")
		}
		for _, item := range decoded.Value {
			name := item.ID[strings.LastIndex(item.ID, "/")+1:]
			detail := item.ContentType
			if !item.Attributes.Enabled {
				detail = strings.TrimSpace("disabled " + detail)
			}
			entries = append(entries, Entry{Name: name, Path: name, Detail: detail})
		}
		next = decoded.NextLink
	}
	return capEntries(entries), nil
}
