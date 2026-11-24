package secrets

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/auth"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

var (
	gcpTokenURL    = "https://oauth2.googleapis.com/token"
	gcpSecretsHost = "https://secretmanager.googleapis.com"
)

const gcpScope = "https://www.googleapis.com/auth/cloud-platform"

type gcpProvider struct {
	config      ProviderConfig
	credentials Credentials
	env         Environment
	client      *http.Client
	tokens      tokenCache
}

type gcpCredentialFile struct {
	Type         string `json:"type"`
	ClientEmail  string `json:"client_email"`
	PrivateKey   string `json:"private_key"`
	PrivateKeyID string `json:"private_key_id"`
	TokenURI     string `json:"token_uri"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	RefreshToken string `json:"refresh_token"`
}

func newGCPProvider(config ProviderConfig, credentials Credentials, env Environment) *gcpProvider {
	return &gcpProvider{config: config, credentials: credentials, env: env, client: newRESTClient(config)}
}

func (p *gcpProvider) base() string {
	if p.config.Endpoint != "" {
		return strings.TrimRight(p.config.Endpoint, "/")
	}
	return gcpSecretsHost
}

func (p *gcpProvider) secretName(path string) (string, string, error) {
	path = strings.Trim(strings.TrimSpace(path), "/")
	if path == "" {
		return "", "", newError(KindInvalidRef, p.config.ID, "path is empty")
	}
	version := ""
	if head, tail, ok := strings.Cut(path, "/versions/"); ok {
		path, version = head, tail
	}
	if strings.HasPrefix(path, "projects/") {
		return path, version, nil
	}
	if strings.Contains(path, "/") {
		return "", "", newError(KindInvalidRef, p.config.ID, "use a secret name like db-password or projects/<project>/secrets/<name>")
	}
	return "projects/" + p.config.Project + "/secrets/" + path, version, nil
}

func (p *gcpProvider) accessToken(ctx context.Context) (string, string, error) {
	if token, source, ok := p.tokens.get(p.env.Now()); ok {
		return token, source, nil
	}
	token, source, expiresIn, err := p.lookupToken(ctx)
	if err != nil {
		return "", "", err
	}
	p.tokens.set(token, source, expiryWithMargin(p.env.Now(), expiresIn))
	return token, source, nil
}

func (p *gcpProvider) lookupToken(ctx context.Context) (string, string, int64, error) {
	if key, ok := p.credentials("serviceAccountKey"); ok && strings.TrimSpace(key) != "" {
		return p.tokenFromFile(ctx, []byte(key), "service account key saved on this device")
	}
	if key, ok := p.env.Getenv(GCPServiceAccountKeyEnv); ok && strings.TrimSpace(key) != "" {
		return p.tokenFromFile(ctx, []byte(strings.TrimSpace(key)), GCPServiceAccountKeyEnv)
	}
	if path, ok := p.env.Getenv("GOOGLE_APPLICATION_CREDENTIALS"); ok && strings.TrimSpace(path) != "" {
		data, err := p.env.ReadFile(strings.TrimSpace(path))
		if err != nil {
			return "", "", 0, newError(KindNotAuthenticated, p.config.ID, "cannot read GOOGLE_APPLICATION_CREDENTIALS: %v", err)
		}
		return p.tokenFromFile(ctx, data, "GOOGLE_APPLICATION_CREDENTIALS")
	}
	if path := p.adcPath(); path != "" {
		if data, err := p.env.ReadFile(path); err == nil {
			return p.tokenFromFile(ctx, data, "application default credentials")
		}
	}
	return p.gcloudToken(ctx)
}

func (p *gcpProvider) adcPath() string {
	return gcpADCPath(runtime.GOOS, p.env)
}

func gcpADCPath(goos string, env Environment) string {
	if dir, ok := env.Getenv("CLOUDSDK_CONFIG"); ok && dir != "" {
		return filepath.Join(dir, "application_default_credentials.json")
	}
	if goos == "windows" {
		if appData, ok := env.Getenv("APPDATA"); ok && appData != "" {
			return filepath.Join(appData, "gcloud", "application_default_credentials.json")
		}
		return ""
	}
	home, err := env.HomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "gcloud", "application_default_credentials.json")
}

func (p *gcpProvider) tokenFromFile(ctx context.Context, data []byte, source string) (string, string, int64, error) {
	var file gcpCredentialFile
	if err := json.Unmarshal(data, &file); err != nil {
		return "", "", 0, newError(KindNotAuthenticated, p.config.ID, "%s is not a Google credentials JSON file", source)
	}
	tokenURL := gcpTokenURL
	if file.TokenURI != "" {
		tokenURL = file.TokenURI
	}
	form := url.Values{}
	switch file.Type {
	case "service_account":
		if file.ClientEmail == "" || file.PrivateKey == "" {
			return "", "", 0, newError(KindNotAuthenticated, p.config.ID, "the service account key in %s has no client_email or private_key", source)
		}
		now := p.env.Now()
		claims, _ := json.Marshal(map[string]any{"iss": file.ClientEmail, "scope": gcpScope, "aud": tokenURL, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()})
		headers := "{}"
		if file.PrivateKeyID != "" {
			encoded, _ := json.Marshal(map[string]string{"kid": file.PrivateKeyID})
			headers = string(encoded)
		}
		assertion, err := auth.SignJWTBearer(model.AuthConfig{JWTAlgorithm: "RS256", JWTPrivateKey: file.PrivateKey, JWTPayload: string(claims), JWTHeaders: headers}, now)
		if err != nil {
			return "", "", 0, newError(KindNotAuthenticated, p.config.ID, "cannot sign with the service account key: %v", err)
		}
		form.Set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
		form.Set("assertion", assertion)
		source = file.ClientEmail + " (" + source + ")"
	case "authorized_user":
		if file.RefreshToken == "" {
			return "", "", 0, newError(KindNotAuthenticated, p.config.ID, "%s has no refresh token; run gcloud auth application-default login", source)
		}
		form.Set("grant_type", "refresh_token")
		form.Set("client_id", file.ClientID)
		form.Set("client_secret", file.ClientSecret)
		form.Set("refresh_token", file.RefreshToken)
	default:
		return "", "", 0, newError(KindNotAuthenticated, p.config.ID, "%s has credentials of type %q; use a service account key or gcloud", source, file.Type)
	}
	response, err := postTokenForm(ctx, p.client, p.config.ID, tokenURL, form)
	if err != nil {
		return "", "", 0, err
	}
	return response.AccessToken, source, response.expiresIn(), nil
}

func (p *gcpProvider) gcloudToken(ctx context.Context) (string, string, int64, error) {
	path, err := p.env.LookPath("gcloud")
	if err != nil {
		return "", "", 0, newError(KindNotAuthenticated, p.config.ID, "no Google credentials: set GOOGLE_APPLICATION_CREDENTIALS, run gcloud auth application-default login, or save a service account key for this provider")
	}
	stdout, stderr, err := p.env.Run(ctx, path, []string{"auth", "print-access-token"}, nil)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", "", 0, newError(KindTimeout, p.config.ID, "gcloud did not answer before the timeout")
		}
		return "", "", 0, newError(KindNotAuthenticated, p.config.ID, "%s", toolMessage(stderr, err))
	}
	token := strings.TrimSpace(string(stdout))
	if token == "" {
		return "", "", 0, newError(KindNotAuthenticated, p.config.ID, "gcloud returned no access token; run gcloud auth login")
	}
	return token, "gcloud", 0, nil
}

type gcpErrorBody struct {
	Error struct {
		Message string `json:"message"`
		Status  string `json:"status"`
	} `json:"error"`
}

func (p *gcpProvider) get(ctx context.Context, endpoint, path string) ([]byte, error) {
	token, _, err := p.accessToken(ctx)
	if err != nil {
		return nil, err
	}
	data, status, err := restCall(ctx, p.client, p.config.ID, http.MethodGet, endpoint, map[string]string{"Authorization": "Bearer " + token, "X-Goog-User-Project": p.config.Project}, nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized {
		p.tokens.clear()
	}
	var decoded gcpErrorBody
	_ = json.Unmarshal(data, &decoded)
	if err := statusKindError(p.config.ID, status, shortText(decoded.Error.Message), path); err != nil {
		return nil, err
	}
	return data, nil
}

func (p *gcpProvider) Fetch(ctx context.Context, path, version string) (Secret, error) {
	name, pathVersion, err := p.secretName(path)
	if err != nil {
		return Secret{}, err
	}
	if version == "" {
		version = pathVersion
	}
	if version == "" {
		version = "latest"
	}
	data, err := p.get(ctx, p.base()+"/v1/"+escapeVaultPath(name)+"/versions/"+url.PathEscape(version)+":access", path)
	if err != nil {
		return Secret{}, err
	}
	var decoded struct {
		Payload struct {
			Data string `json:"data"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return Secret{}, newError(KindUnavailable, p.config.ID, "unexpected answer for %s", path)
	}
	value, err := base64.StdEncoding.DecodeString(decoded.Payload.Data)
	if err != nil {
		return Secret{}, newError(KindUnavailable, p.config.ID, "unexpected payload for %s", path)
	}
	return Secret{Raw: string(value)}, nil
}

func (p *gcpProvider) Check(ctx context.Context) (Status, error) {
	if _, err := p.get(ctx, p.base()+"/v1/projects/"+url.PathEscape(p.config.Project)+"/secrets?pageSize=1", "projects/"+p.config.Project); err != nil {
		if KindOf(err) == KindForbidden {
			return Status{}, listPermissionError(p.config.ID, err)
		}
		return Status{}, err
	}
	_, source, _ := p.tokens.get(p.env.Now())
	return Status{Detail: "Project " + p.config.Project + " · credentials from " + source}, nil
}

func (p *gcpProvider) List(ctx context.Context, _ string) ([]Entry, error) {
	var entries []Entry
	pageToken := ""
	for page := 0; page < 10 && len(entries) < maxEntries; page++ {
		query := url.Values{"pageSize": {"250"}}
		if pageToken != "" {
			query.Set("pageToken", pageToken)
		}
		data, err := p.get(ctx, p.base()+"/v1/projects/"+url.PathEscape(p.config.Project)+"/secrets?"+query.Encode(), "projects/"+p.config.Project)
		if err != nil {
			return nil, err
		}
		var decoded struct {
			Secrets []struct {
				Name string `json:"name"`
			} `json:"secrets"`
			NextPageToken string `json:"nextPageToken"`
		}
		if err := json.Unmarshal(data, &decoded); err != nil {
			return nil, newError(KindUnavailable, p.config.ID, "unexpected answer when listing secrets")
		}
		for _, secret := range decoded.Secrets {
			name := secret.Name[strings.LastIndex(secret.Name, "/")+1:]
			entries = append(entries, Entry{Name: name, Path: name})
		}
		if decoded.NextPageToken == "" {
			break
		}
		pageToken = decoded.NextPageToken
	}
	return capEntries(entries), nil
}
