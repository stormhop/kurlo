package secrets

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/auth"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type awsCredentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	Expires         time.Time
	Source          string
}

type awsProvider struct {
	config      ProviderConfig
	credentials Credentials
	env         Environment
	client      *http.Client

	mu     sync.Mutex
	cached *awsCredentials
}

func newAWSProvider(config ProviderConfig, credentials Credentials, env Environment) *awsProvider {
	return &awsProvider{config: config, credentials: credentials, env: env, client: &http.Client{Timeout: config.Timeout}}
}

func (p *awsProvider) endpoint(service string) string {
	if p.config.Endpoint != "" {
		return strings.TrimRight(p.config.Endpoint, "/") + "/"
	}
	suffix := "amazonaws.com"
	if strings.HasPrefix(p.config.Region, "cn-") {
		suffix = "amazonaws.com.cn"
	}
	return "https://" + service + "." + p.config.Region + "." + suffix + "/"
}

func (p *awsProvider) profileName() string {
	if p.config.Profile != "" {
		return p.config.Profile
	}
	if profile, ok := p.env.Getenv("AWS_PROFILE"); ok && strings.TrimSpace(profile) != "" {
		return strings.TrimSpace(profile)
	}
	return "default"
}

func (p *awsProvider) resolveCredentials(ctx context.Context) (awsCredentials, error) {
	p.mu.Lock()
	if p.cached != nil && (p.cached.Expires.IsZero() || p.env.Now().Before(p.cached.Expires.Add(-time.Minute))) {
		cached := *p.cached
		p.mu.Unlock()
		return cached, nil
	}
	p.mu.Unlock()
	creds, err := p.lookupCredentials(ctx)
	if err != nil {
		return awsCredentials{}, err
	}
	p.mu.Lock()
	p.cached = &creds
	p.mu.Unlock()
	return creds, nil
}

func (p *awsProvider) forgetCredentials() {
	p.mu.Lock()
	p.cached = nil
	p.mu.Unlock()
}

func (p *awsProvider) lookupCredentials(ctx context.Context) (awsCredentials, error) {
	base, err := p.baseCredentials(ctx)
	if err != nil || p.config.RoleARN == "" {
		return base, err
	}
	return p.assumeRole(ctx, base)
}

func (p *awsProvider) mfaCode() string {
	if code, ok := p.credentials("mfaCode"); ok && strings.TrimSpace(code) != "" {
		return strings.TrimSpace(code)
	}
	if code, ok := p.env.Getenv("AWS_MFA_CODE"); ok {
		return strings.TrimSpace(code)
	}
	return ""
}

func (p *awsProvider) assumeRole(ctx context.Context, base awsCredentials) (awsCredentials, error) {
	form := url.Values{}
	form.Set("Action", "AssumeRole")
	form.Set("Version", "2011-06-15")
	form.Set("RoleArn", p.config.RoleARN)
	form.Set("RoleSessionName", "kurlo")
	form.Set("DurationSeconds", "3600")
	if p.config.ExternalID != "" {
		form.Set("ExternalId", p.config.ExternalID)
	}
	if p.config.MFASerial != "" {
		code := p.mfaCode()
		if code == "" {
			return awsCredentials{}, newError(KindNotAuthenticated, p.config.ID, "enter the MFA code for %s under On this device, or set AWS_MFA_CODE", p.config.MFASerial)
		}
		form.Set("SerialNumber", p.config.MFASerial)
		form.Set("TokenCode", code)
	}
	data, err := p.signedCall(ctx, base, "sts", "application/x-www-form-urlencoded; charset=utf-8", "", []byte(form.Encode()), "sts")
	if err != nil {
		var typed *Error
		if errors.As(err, &typed) && (typed.Kind == KindForbidden || typed.Kind == KindNotAuthenticated) {
			return awsCredentials{}, newError(KindNotAuthenticated, p.config.ID, "cannot assume %s: %s", p.config.RoleARN, typed.Message)
		}
		return awsCredentials{}, err
	}
	var decoded struct {
		Response struct {
			Result struct {
				Credentials struct {
					AccessKeyID     string  `json:"AccessKeyId"`
					SecretAccessKey string  `json:"SecretAccessKey"`
					SessionToken    string  `json:"SessionToken"`
					Expiration      float64 `json:"Expiration"`
				} `json:"Credentials"`
			} `json:"AssumeRoleResult"`
		} `json:"AssumeRoleResponse"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil || decoded.Response.Result.Credentials.AccessKeyID == "" {
		return awsCredentials{}, newError(KindUnavailable, p.config.ID, "AssumeRole returned no credentials")
	}
	creds := decoded.Response.Result.Credentials
	out := awsCredentials{AccessKeyID: creds.AccessKeyID, SecretAccessKey: creds.SecretAccessKey, SessionToken: creds.SessionToken, Source: "role " + p.config.RoleARN + " via " + base.Source}
	if creds.Expiration > 0 {
		out.Expires = time.Unix(int64(creds.Expiration), 0)
	} else {
		out.Expires = p.env.Now().Add(time.Hour)
	}
	return out, nil
}

func (p *awsProvider) baseCredentials(ctx context.Context) (awsCredentials, error) {
	key, keyOK := p.credentials("accessKeyId")
	secret, secretOK := p.credentials("secretAccessKey")
	if keyOK && secretOK && key != "" && secret != "" {
		token, _ := p.credentials("sessionToken")
		return awsCredentials{AccessKeyID: key, SecretAccessKey: secret, SessionToken: token, Source: "saved on this device"}, nil
	}
	if p.config.Profile == "" {
		key, keyOK := p.env.Getenv("AWS_ACCESS_KEY_ID")
		secret, secretOK := p.env.Getenv("AWS_SECRET_ACCESS_KEY")
		if keyOK && secretOK && key != "" && secret != "" {
			token, _ := p.env.Getenv("AWS_SESSION_TOKEN")
			return awsCredentials{AccessKeyID: key, SecretAccessKey: secret, SessionToken: token, Source: "AWS_ACCESS_KEY_ID"}, nil
		}
	}
	if creds, ok := p.sharedCredentials(); ok {
		return creds, nil
	}
	return p.cliCredentials(ctx)
}

func (p *awsProvider) sharedCredentials() (awsCredentials, bool) {
	path, ok := p.env.Getenv("AWS_SHARED_CREDENTIALS_FILE")
	if !ok || strings.TrimSpace(path) == "" {
		home, err := p.env.HomeDir()
		if err != nil {
			return awsCredentials{}, false
		}
		path = filepath.Join(home, ".aws", "credentials")
	}
	data, err := p.env.ReadFile(path)
	if err != nil {
		return awsCredentials{}, false
	}
	section := parseINISection(data, p.profileName())
	if section["aws_access_key_id"] == "" || section["aws_secret_access_key"] == "" {
		return awsCredentials{}, false
	}
	return awsCredentials{
		AccessKeyID:     section["aws_access_key_id"],
		SecretAccessKey: section["aws_secret_access_key"],
		SessionToken:    section["aws_session_token"],
		Source:          "~/.aws/credentials [" + p.profileName() + "]",
	}, true
}

func parseINISection(data []byte, name string) map[string]string {
	values := map[string]string{}
	current := ""
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			current = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line[1:len(line)-1]), "profile "))
			continue
		}
		if current != name {
			continue
		}
		if key, value, ok := strings.Cut(line, "="); ok {
			values[strings.ToLower(strings.TrimSpace(key))] = strings.TrimSpace(value)
		}
	}
	return values
}

func (p *awsProvider) cliCredentials(ctx context.Context) (awsCredentials, error) {
	path, err := p.env.LookPath("aws")
	if err != nil {
		if id, _ := p.env.Getenv("AWS_ACCESS_KEY_ID"); strings.TrimSpace(id) != "" {
			return awsCredentials{}, newError(KindNotAuthenticated, p.config.ID, "no AWS credentials: AWS_ACCESS_KEY_ID is set but AWS_SECRET_ACCESS_KEY is empty")
		}
		return awsCredentials{}, newError(KindNotAuthenticated, p.config.ID, "no AWS credentials: set AWS_ACCESS_KEY_ID, add profile %q to ~/.aws/credentials, or install the AWS CLI for SSO profiles", p.profileName())
	}
	args := []string{"configure", "export-credentials", "--format", "process"}
	if p.config.Profile != "" {
		args = append(args, "--profile", p.config.Profile)
	}
	stdout, stderr, err := p.env.Run(ctx, path, args, nil)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return awsCredentials{}, newError(KindTimeout, p.config.ID, "the AWS CLI did not answer before the timeout")
		}
		return awsCredentials{}, newError(KindNotAuthenticated, p.config.ID, "%s", toolMessage(stderr, err))
	}
	var exported struct {
		AccessKeyID     string `json:"AccessKeyId"`
		SecretAccessKey string `json:"SecretAccessKey"`
		SessionToken    string `json:"SessionToken"`
		Expiration      string `json:"Expiration"`
	}
	if err := json.Unmarshal(stdout, &exported); err != nil || exported.AccessKeyID == "" || exported.SecretAccessKey == "" {
		return awsCredentials{}, newError(KindNotAuthenticated, p.config.ID, "the AWS CLI returned no credentials for profile %q", p.profileName())
	}
	creds := awsCredentials{AccessKeyID: exported.AccessKeyID, SecretAccessKey: exported.SecretAccessKey, SessionToken: exported.SessionToken, Source: "aws configure export-credentials"}
	if exported.Expiration != "" {
		if expires, err := time.Parse(time.RFC3339, exported.Expiration); err == nil {
			creds.Expires = expires
		}
	}
	return creds, nil
}

type awsErrorBody struct {
	Type         string `json:"__type"`
	Message      string `json:"message"`
	MessageUpper string `json:"Message"`
	Error        *struct {
		Code    string `json:"Code"`
		Message string `json:"Message"`
	} `json:"Error"`
}

func (p *awsProvider) call(ctx context.Context, service, contentType, target string, body []byte, path string) ([]byte, error) {
	creds, err := p.resolveCredentials(ctx)
	if err != nil {
		return nil, err
	}
	return p.signedCall(ctx, creds, service, contentType, target, body, path)
}

func (p *awsProvider) signedCall(ctx context.Context, creds awsCredentials, service, contentType, target string, body []byte, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint(service), bytes.NewReader(body))
	if err != nil {
		return nil, newError(KindInvalidRef, p.config.ID, "invalid endpoint")
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "application/json")
	if target != "" {
		req.Header.Set("X-Amz-Target", target)
	}
	if err := auth.Sign(req, model.AuthConfig{AWSAccessKey: creds.AccessKeyID, AWSSecretKey: creds.SecretAccessKey, AWSSessionToken: creds.SessionToken, AWSRegion: p.config.Region, AWSService: service}); err != nil {
		return nil, newError(KindUnavailable, p.config.ID, "cannot sign the request: %v", err)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, transportError(p.config.ID, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxVaultResponseBytes))
	if err != nil {
		return nil, transportError(p.config.ID, err)
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return data, nil
	}
	var decoded awsErrorBody
	_ = json.Unmarshal(data, &decoded)
	code := decoded.Type
	message := decoded.Message
	if message == "" {
		message = decoded.MessageUpper
	}
	if decoded.Error != nil {
		code, message = decoded.Error.Code, decoded.Error.Message
	}
	if index := strings.LastIndex(code, "#"); index >= 0 {
		code = code[index+1:]
	}
	if message == "" {
		message = code
	}
	if message == "" {
		message = resp.Status
	}
	switch code {
	case "ResourceNotFoundException", "ParameterNotFound", "ParameterVersionNotFound":
		return nil, newError(KindNotFound, p.config.ID, "no secret at %s", path)
	case "AccessDeniedException", "AccessDenied":
		return nil, newError(KindForbidden, p.config.ID, "%s", message)
	case "UnrecognizedClientException", "ExpiredTokenException", "InvalidSignatureException", "InvalidClientTokenId", "SignatureDoesNotMatch", "ExpiredToken":
		p.forgetCredentials()
		return nil, newError(KindNotAuthenticated, p.config.ID, "%s", message)
	}
	if resp.StatusCode == http.StatusForbidden {
		return nil, newError(KindForbidden, p.config.ID, "%s", message)
	}
	return nil, newError(KindUnavailable, p.config.ID, "%s", message)
}

func (p *awsProvider) Fetch(ctx context.Context, path, version string) (Secret, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return Secret{}, newError(KindInvalidRef, p.config.ID, "path is empty")
	}
	if p.config.Type == TypeAWSParameterStore {
		name := path
		if version != "" {
			name += ":" + version
		}
		body, _ := json.Marshal(map[string]any{"Name": name, "WithDecryption": true})
		data, err := p.call(ctx, "ssm", "application/x-amz-json-1.1", "AmazonSSM.GetParameter", body, path)
		if err != nil {
			return Secret{}, err
		}
		var decoded struct {
			Parameter struct {
				Value string `json:"Value"`
			} `json:"Parameter"`
		}
		if err := json.Unmarshal(data, &decoded); err != nil {
			return Secret{}, newError(KindUnavailable, p.config.ID, "unexpected answer for %s", path)
		}
		return Secret{Raw: decoded.Parameter.Value}, nil
	}
	request := map[string]any{"SecretId": path}
	if version != "" {
		if isAWSVersionID(version) {
			request["VersionId"] = version
		} else {
			request["VersionStage"] = version
		}
	}
	body, _ := json.Marshal(request)
	data, err := p.call(ctx, "secretsmanager", "application/x-amz-json-1.1", "secretsmanager.GetSecretValue", body, path)
	if err != nil && version != "" && isAWSVersionID(version) && KindOf(err) == KindNotFound {
		delete(request, "VersionId")
		request["VersionStage"] = version
		body, _ = json.Marshal(request)
		data, err = p.call(ctx, "secretsmanager", "application/x-amz-json-1.1", "secretsmanager.GetSecretValue", body, path)
	}
	if err != nil {
		return Secret{}, err
	}
	var decoded struct {
		SecretString *string `json:"SecretString"`
		SecretBinary string  `json:"SecretBinary"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return Secret{}, newError(KindUnavailable, p.config.ID, "unexpected answer for %s", path)
	}
	if decoded.SecretString != nil {
		return Secret{Raw: *decoded.SecretString}, nil
	}
	binary, err := base64.StdEncoding.DecodeString(decoded.SecretBinary)
	if err != nil {
		return Secret{}, newError(KindUnavailable, p.config.ID, "unexpected binary secret for %s", path)
	}
	return Secret{Raw: string(binary)}, nil
}

func isAWSVersionID(version string) bool {
	return len(version) >= 32 && len(version) <= 64
}

func (p *awsProvider) Check(ctx context.Context) (Status, error) {
	creds, err := p.resolveCredentials(ctx)
	if err != nil {
		return Status{}, err
	}
	data, err := p.call(ctx, "sts", "application/x-www-form-urlencoded; charset=utf-8", "", []byte("Action=GetCallerIdentity&Version=2011-06-15"), "sts")
	if err != nil {
		return Status{}, err
	}
	var decoded struct {
		Response struct {
			Result struct {
				Arn string `json:"Arn"`
			} `json:"GetCallerIdentityResult"`
		} `json:"GetCallerIdentityResponse"`
	}
	_ = json.Unmarshal(data, &decoded)
	status := Status{Detail: "Credentials from " + creds.Source}
	if arn := decoded.Response.Result.Arn; arn != "" {
		status.Detail = "Signed in as " + arn + " · credentials from " + creds.Source
	}
	if !creds.Expires.IsZero() {
		status.ExpiresIn = int64(creds.Expires.Sub(p.env.Now()).Seconds())
	}
	return status, nil
}

func (p *awsProvider) List(ctx context.Context, _ string) ([]Entry, error) {
	var entries []Entry
	next := ""
	for page := 0; page < 20 && len(entries) < maxEntries; page++ {
		if p.config.Type == TypeAWSParameterStore {
			request := map[string]any{"MaxResults": 50}
			if next != "" {
				request["NextToken"] = next
			}
			body, _ := json.Marshal(request)
			data, err := p.call(ctx, "ssm", "application/x-amz-json-1.1", "AmazonSSM.DescribeParameters", body, "parameters")
			if err != nil {
				return nil, err
			}
			var decoded struct {
				Parameters []struct {
					Name string `json:"Name"`
					Type string `json:"Type"`
				} `json:"Parameters"`
				NextToken string `json:"NextToken"`
			}
			if err := json.Unmarshal(data, &decoded); err != nil {
				return nil, newError(KindUnavailable, p.config.ID, "unexpected answer when listing parameters")
			}
			for _, parameter := range decoded.Parameters {
				entries = append(entries, Entry{Name: parameter.Name, Path: parameter.Name, Detail: parameter.Type})
			}
			next = decoded.NextToken
		} else {
			request := map[string]any{"MaxResults": 100}
			if next != "" {
				request["NextToken"] = next
			}
			body, _ := json.Marshal(request)
			data, err := p.call(ctx, "secretsmanager", "application/x-amz-json-1.1", "secretsmanager.ListSecrets", body, "secrets")
			if err != nil {
				return nil, err
			}
			var decoded struct {
				SecretList []struct {
					Name        string `json:"Name"`
					Description string `json:"Description"`
				} `json:"SecretList"`
				NextToken string `json:"NextToken"`
			}
			if err := json.Unmarshal(data, &decoded); err != nil {
				return nil, newError(KindUnavailable, p.config.ID, "unexpected answer when listing secrets")
			}
			for _, secret := range decoded.SecretList {
				entries = append(entries, Entry{Name: secret.Name, Path: secret.Name, Detail: shortText(secret.Description)})
			}
			next = decoded.NextToken
		}
		if next == "" {
			break
		}
	}
	sortEntries(entries)
	return capEntries(entries), nil
}
