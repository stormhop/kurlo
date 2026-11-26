package secrets

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	TypeEnv               = "env"
	TypeVault             = "vault"
	TypeOnePassword       = "1password"
	TypeAWSSecretsManager = "aws-secrets-manager"
	TypeAWSParameterStore = "aws-ssm"
	TypeGCPSecretManager  = "gcp-secret-manager"
	TypeAzureKeyVault     = "azure-key-vault"
	TypeBitwarden         = "bitwarden"
	TypeDoppler           = "doppler"
	TypeInfisical         = "infisical"
	TypeCommand           = "command"
	TypeKeePassXC         = "keepassxc"

	DefaultCacheTTL = 5 * time.Minute
	DefaultTimeout  = 10 * time.Second
	MaxCacheTTL     = 24 * time.Hour
	MinTimeout      = time.Second
	MaxTimeout      = 10 * time.Minute
	maxNameLength   = 80
)

var (
	providerIDPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	awsRegionPattern    = regexp.MustCompile(`^[a-z]{2}(-[a-z]+)+-\d$`)
	gcpProjectPattern   = regexp.MustCompile(`^[a-z][a-z0-9-]{4,28}[a-z0-9]$|^[0-9]{6,20}$`)
	vaultMountPattern   = regexp.MustCompile(`^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$`)
	awsRoleARNPattern   = regexp.MustCompile(`^arn:aws[a-z-]*:iam::\d{12}:role/[\w+=,.@/-]+$`)
	awsMFASerialPattern = regexp.MustCompile(`^arn:aws[a-z-]*:iam::\d{12}:mfa/[\w+=,.@/-]+$|^[A-Z0-9]{9,64}$`)
	guidPattern         = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$`)
	domainPattern       = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$`)
)

const (
	defaultKubernetesTokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token"
	defaultOIDCRedirectURI     = "http://localhost:8250/oidc/callback"
)

type AuthConfig struct {
	Method      string `json:"method,omitempty" yaml:"method,omitempty"`
	RoleID      string `json:"roleId,omitempty" yaml:"roleId,omitempty"`
	Role        string `json:"role,omitempty" yaml:"role,omitempty"`
	Mount       string `json:"mount,omitempty" yaml:"mount,omitempty"`
	TokenPath   string `json:"tokenPath,omitempty" yaml:"tokenPath,omitempty"`
	RedirectURI string `json:"redirectUri,omitempty" yaml:"redirectUri,omitempty"`
	TenantID    string `json:"tenantId,omitempty" yaml:"tenantId,omitempty"`
	ClientID    string `json:"clientId,omitempty" yaml:"clientId,omitempty"`
	Username    string `json:"username,omitempty" yaml:"username,omitempty"`
}

type ProviderConfig struct {
	ID            string        `json:"id"`
	Type          string        `json:"type"`
	Name          string        `json:"name,omitempty"`
	Address       string        `json:"address,omitempty"`
	Namespace     string        `json:"namespace,omitempty"`
	CACert        string        `json:"caCert,omitempty"`
	SkipTLSVerify bool          `json:"skipTlsVerify,omitempty"`
	Account       string        `json:"account,omitempty"`
	Region        string        `json:"region,omitempty"`
	Profile       string        `json:"profile,omitempty"`
	Endpoint      string        `json:"endpoint,omitempty"`
	Project       string        `json:"project,omitempty"`
	Command       []string      `json:"command,omitempty"`
	RoleARN       string        `json:"roleArn,omitempty"`
	ExternalID    string        `json:"externalId,omitempty"`
	MFASerial     string        `json:"mfaSerial,omitempty"`
	Auth          AuthConfig    `json:"auth"`
	CacheTTL      time.Duration `json:"-"`
	Timeout       time.Duration `json:"-"`
}

func (c ProviderConfig) DisplayName() string {
	if strings.TrimSpace(c.Name) != "" {
		return c.Name
	}
	return c.ID
}

func (c ProviderConfig) Hash() string {
	material := struct {
		Type          string     `json:"type"`
		Address       string     `json:"address"`
		Namespace     string     `json:"namespace"`
		CACert        string     `json:"caCert"`
		SkipTLSVerify bool       `json:"skipTlsVerify"`
		Account       string     `json:"account,omitempty"`
		Region        string     `json:"region,omitempty"`
		Profile       string     `json:"profile,omitempty"`
		Endpoint      string     `json:"endpoint,omitempty"`
		Project       string     `json:"project,omitempty"`
		Command       []string   `json:"command,omitempty"`
		Auth          AuthConfig `json:"auth"`
		RoleARN       string     `json:"roleArn,omitempty"`
		ExternalID    string     `json:"externalId,omitempty"`
		MFASerial     string     `json:"mfaSerial,omitempty"`
	}{c.Type, strings.TrimRight(strings.TrimSpace(c.Address), "/"), strings.TrimSpace(c.Namespace), strings.TrimSpace(c.CACert), c.SkipTLSVerify, c.Account, c.Region, c.Profile, strings.TrimRight(c.Endpoint, "/"), c.Project, c.Command, c.Auth, c.RoleARN, c.ExternalID, c.MFASerial}
	encoded, _ := json.Marshal(material)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func ParseProviders(raw []map[string]any) ([]ProviderConfig, []error) {
	var configs []ProviderConfig
	var problems []error
	seen := map[string]bool{}
	for index, item := range raw {
		config, err := ParseProvider(item)
		if err != nil {
			problems = append(problems, fmt.Errorf("secretProviders[%d]: %w", index, err))
			continue
		}
		if seen[config.ID] {
			problems = append(problems, fmt.Errorf("secretProviders[%d]: duplicate id %q", index, config.ID))
			continue
		}
		seen[config.ID] = true
		configs = append(configs, config)
	}
	return configs, problems
}

func ParseProvider(item map[string]any) (ProviderConfig, error) {
	config := ProviderConfig{
		ID:            strings.TrimSpace(stringField(item, "id")),
		Type:          strings.TrimSpace(stringField(item, "type")),
		Name:          strings.TrimSpace(stringField(item, "name")),
		Address:       strings.TrimSpace(stringField(item, "address")),
		Namespace:     strings.TrimSpace(stringField(item, "namespace")),
		CACert:        strings.TrimSpace(stringField(item, "caCert")),
		SkipTLSVerify: boolField(item, "skipTlsVerify"),
		Account:       strings.TrimSpace(stringField(item, "account")),
		Region:        strings.TrimSpace(stringField(item, "region")),
		Profile:       strings.TrimSpace(stringField(item, "profile")),
		Endpoint:      strings.TrimSpace(stringField(item, "endpoint")),
		Project:       strings.TrimSpace(stringField(item, "project")),
		Command:       stringListField(item, "command"),
		RoleARN:       strings.TrimSpace(stringField(item, "roleArn")),
		ExternalID:    strings.TrimSpace(stringField(item, "externalId")),
		MFASerial:     strings.TrimSpace(stringField(item, "mfaSerial")),
		CacheTTL:      DefaultCacheTTL,
		Timeout:       DefaultTimeout,
	}
	if auth, ok := item["auth"].(map[string]any); ok {
		config.Auth = AuthConfig{
			Method:      strings.TrimSpace(stringField(auth, "method")),
			RoleID:      strings.TrimSpace(stringField(auth, "roleId")),
			Role:        strings.TrimSpace(stringField(auth, "role")),
			Mount:       strings.Trim(strings.TrimSpace(stringField(auth, "mount")), "/"),
			TokenPath:   strings.TrimSpace(stringField(auth, "tokenPath")),
			RedirectURI: strings.TrimSpace(stringField(auth, "redirectUri")),
			TenantID:    strings.TrimSpace(stringField(auth, "tenantId")),
			ClientID:    strings.TrimSpace(stringField(auth, "clientId")),
			Username:    strings.TrimSpace(stringField(auth, "username")),
		}
	}
	if !providerIDPattern.MatchString(config.ID) {
		return config, fmt.Errorf("id %q must be lowercase letters, digits, - or _", config.ID)
	}
	if ttl, ok, err := durationField(item, "cacheTtl"); err != nil {
		return config, fmt.Errorf("provider %q: %w", config.ID, err)
	} else if ok {
		if ttl > MaxCacheTTL {
			return config, fmt.Errorf("provider %q: cacheTtl %s is longer than 24h; use session to keep values until Kurlo quits", config.ID, ttl)
		}
		config.CacheTTL = ttl
	}
	if timeout, ok, err := durationField(item, "timeout"); err != nil {
		return config, fmt.Errorf("provider %q: %w", config.ID, err)
	} else if ok {
		if timeout < MinTimeout || timeout > MaxTimeout {
			return config, fmt.Errorf("provider %q: timeout must be between 1s and 10m", config.ID)
		}
		config.Timeout = timeout
	}
	switch config.Type {
	case TypeEnv:
	case TypeVault:
		if err := requireURL(config, config.Address, "address", true); err != nil {
			return config, err
		}
		if strings.HasPrefix(config.Namespace, "/") || strings.HasSuffix(config.Namespace, "/") {
			return config, fmt.Errorf("provider %q: namespace %q must not start or end with /", config.ID, config.Namespace)
		}
		if config.Auth.Mount != "" && !vaultMountPattern.MatchString(config.Auth.Mount) {
			return config, fmt.Errorf("provider %q: auth.mount %q must be a path like approle or auth/team-a", config.ID, config.Auth.Mount)
		}
		switch config.Auth.Method {
		case "", "token":
			config.Auth.Method = "token"
		case "approle":
			if config.Auth.RoleID == "" {
				return config, fmt.Errorf("provider %q: auth.roleId is required for approle", config.ID)
			}
			if config.Auth.Mount == "" {
				config.Auth.Mount = "approle"
			}
		case "kubernetes":
			if config.Auth.Role == "" {
				return config, fmt.Errorf("provider %q: auth.role is required for kubernetes", config.ID)
			}
			if config.Auth.Mount == "" {
				config.Auth.Mount = "kubernetes"
			}
			if config.Auth.TokenPath == "" {
				config.Auth.TokenPath = defaultKubernetesTokenPath
			}
		case "ldap", "userpass":
			if config.Auth.Mount == "" {
				config.Auth.Mount = config.Auth.Method
			}
		case "oidc":
			if config.Auth.Mount == "" {
				config.Auth.Mount = "oidc"
			}
			if config.Auth.RedirectURI == "" {
				config.Auth.RedirectURI = defaultOIDCRedirectURI
			}
			if err := validLoopbackRedirect(config.Auth.RedirectURI); err != nil {
				return config, fmt.Errorf("provider %q: auth.redirectUri %w", config.ID, err)
			}
		default:
			return config, fmt.Errorf("provider %q: unsupported auth method %q", config.ID, config.Auth.Method)
		}
	case TypeOnePassword:
	case TypeAWSSecretsManager, TypeAWSParameterStore:
		if config.Region == "" {
			return config, fmt.Errorf("provider %q: region is required", config.ID)
		}
		if !awsRegionPattern.MatchString(config.Region) {
			return config, fmt.Errorf("provider %q: region %q is not an AWS region like eu-central-1", config.ID, config.Region)
		}
		if err := requireURL(config, config.Endpoint, "endpoint", false); err != nil {
			return config, err
		}
		if config.RoleARN != "" && !awsRoleARNPattern.MatchString(config.RoleARN) {
			return config, fmt.Errorf("provider %q: roleArn %q is not an IAM role ARN like arn:aws:iam::123456789012:role/name", config.ID, config.RoleARN)
		}
		if config.ExternalID != "" && (config.RoleARN == "" || len(config.ExternalID) < 2 || len(config.ExternalID) > 1224) {
			return config, fmt.Errorf("provider %q: externalId needs roleArn and must be 2-1224 characters", config.ID)
		}
		if config.MFASerial != "" && !awsMFASerialPattern.MatchString(config.MFASerial) {
			return config, fmt.Errorf("provider %q: mfaSerial %q is not an MFA device ARN like arn:aws:iam::123456789012:mfa/name", config.ID, config.MFASerial)
		}
	case TypeGCPSecretManager:
		if config.Project == "" {
			return config, fmt.Errorf("provider %q: project is required", config.ID)
		}
		if !gcpProjectPattern.MatchString(config.Project) {
			return config, fmt.Errorf("provider %q: project %q is not a Google Cloud project id or number", config.ID, config.Project)
		}
		if err := requireURL(config, config.Endpoint, "endpoint", false); err != nil {
			return config, err
		}
	case TypeAzureKeyVault:
		if err := requireURL(config, config.Address, "address", true); err != nil {
			return config, err
		}
		switch config.Auth.Method {
		case "", "cli":
			config.Auth.Method = "cli"
		case "client-secret":
			if config.Auth.TenantID == "" || config.Auth.ClientID == "" {
				return config, fmt.Errorf("provider %q: auth.tenantId and auth.clientId are required for client-secret", config.ID)
			}
			if !guidPattern.MatchString(config.Auth.ClientID) {
				return config, fmt.Errorf("provider %q: auth.clientId %q is not an application (client) ID like 00000000-0000-0000-0000-000000000000", config.ID, config.Auth.ClientID)
			}
		default:
			return config, fmt.Errorf("provider %q: unsupported auth method %q", config.ID, config.Auth.Method)
		}
		if config.Auth.TenantID != "" && !guidPattern.MatchString(config.Auth.TenantID) && !domainPattern.MatchString(config.Auth.TenantID) {
			return config, fmt.Errorf("provider %q: auth.tenantId %q is not a tenant ID or a domain like contoso.onmicrosoft.com", config.ID, config.Auth.TenantID)
		}
	case TypeBitwarden:
		if err := requireURL(config, config.Address, "address", false); err != nil {
			return config, err
		}
	case TypeDoppler:
		if err := requireURL(config, config.Address, "address", false); err != nil {
			return config, err
		}
	case TypeInfisical:
		if config.Project == "" {
			return config, fmt.Errorf("provider %q: project is required", config.ID)
		}
		if err := requireURL(config, config.Address, "address", false); err != nil {
			return config, err
		}
		switch config.Auth.Method {
		case "", "token":
			config.Auth.Method = "token"
		case "universal":
			if config.Auth.ClientID == "" {
				return config, fmt.Errorf("provider %q: auth.clientId is required for universal", config.ID)
			}
		default:
			return config, fmt.Errorf("provider %q: unsupported auth method %q", config.ID, config.Auth.Method)
		}
	case TypeKeePassXC:
	case TypeCommand:
		if len(config.Command) == 0 || strings.TrimSpace(config.Command[0]) == "" {
			return config, fmt.Errorf("provider %q: command is required, like [pass, show, \"{path}\"]", config.ID)
		}
	case "":
		return config, fmt.Errorf("provider %q: type is required", config.ID)
	default:
		return config, fmt.Errorf("provider %q: unsupported type %q", config.ID, config.Type)
	}
	if err := validateCommonFields(config); err != nil {
		return config, err
	}
	return config, nil
}

func stringField(item map[string]any, key string) string {
	switch value := item[key].(type) {
	case string:
		return value
	case nil:
		return ""
	default:
		return fmt.Sprint(value)
	}
}

func requireURL(config ProviderConfig, value, field string, required bool) error {
	if value == "" {
		if required {
			return fmt.Errorf("provider %q: %s is required", config.ID, field)
		}
		return nil
	}
	if problem := URLProblem(value); problem != "" {
		return fmt.Errorf("provider %q: %s %s", config.ID, field, problem)
	}
	return nil
}

func URLProblem(value string) string {
	if !strings.HasPrefix(value, "https://") && !strings.HasPrefix(value, "http://") {
		return "must start with https:// or http://"
	}
	if strings.ContainsAny(value, " \t\r\n") {
		return "must not contain spaces"
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Hostname() == "" {
		return "must be a URL with a host, like https://vault.example.com"
	}
	if parsed.User != nil {
		return "must not contain a user name or password; save credentials on this device instead"
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" || strings.ContainsAny(value, "?#") {
		return "must not contain ? or #"
	}
	if port := parsed.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return "has a port outside 1-65535"
		}
	}
	return ""
}

func validateCommonFields(config ProviderConfig) error {
	if len([]rune(config.Name)) > maxNameLength {
		return fmt.Errorf("provider %q: name is longer than %d characters", config.ID, maxNameLength)
	}
	if strings.ContainsAny(config.Name, "\r\n") {
		return fmt.Errorf("provider %q: name must be one line", config.ID)
	}
	for _, field := range []struct{ name, value string }{
		{"namespace", config.Namespace},
		{"account", config.Account},
		{"profile", config.Profile},
		{"project", config.Project},
		{"auth.roleId", config.Auth.RoleID},
		{"auth.role", config.Auth.Role},
		{"auth.mount", config.Auth.Mount},
		{"auth.tenantId", config.Auth.TenantID},
		{"auth.clientId", config.Auth.ClientID},
		{"auth.username", config.Auth.Username},
		{"externalId", config.ExternalID},
	} {
		if strings.ContainsAny(field.value, " \t\r\n") {
			return fmt.Errorf("provider %q: %s must not contain spaces", config.ID, field.name)
		}
	}
	for _, field := range []struct{ name, value string }{
		{"caCert", config.CACert},
		{"auth.tokenPath", config.Auth.TokenPath},
	} {
		if strings.ContainsAny(field.value, "\r\n") {
			return fmt.Errorf("provider %q: %s must be one line", config.ID, field.name)
		}
	}
	return nil
}

func CredentialProblem(name, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if name == "serviceAccountKey" {
		var key struct {
			Type         string `json:"type"`
			ClientEmail  string `json:"client_email"`
			PrivateKey   string `json:"private_key"`
			RefreshToken string `json:"refresh_token"`
		}
		if err := json.Unmarshal([]byte(value), &key); err != nil {
			return "is not a JSON key file; paste the whole file downloaded from Google Cloud"
		}
		switch key.Type {
		case "service_account":
			if key.ClientEmail == "" || key.PrivateKey == "" {
				return "has no client_email or private_key"
			}
		case "authorized_user":
			if key.RefreshToken == "" {
				return "has no refresh_token"
			}
		default:
			return "must be a service_account or authorized_user key"
		}
		return ""
	}
	if name == "mfaCode" {
		if len(value) != 6 || strings.Trim(value, "0123456789") != "" {
			return "must be the 6 digits from your MFA device"
		}
		return ""
	}
	if name == "password" || name == "associationId" {
		if strings.ContainsAny(value, "\r\n") {
			return "must be one line"
		}
	} else if strings.ContainsAny(value, " \t\r\n") {
		return "must not contain spaces or line breaks"
	}
	if len(value) > 16384 {
		return "is too long"
	}
	return ""
}

func stringListField(item map[string]any, key string) []string {
	var out []string
	switch value := item[key].(type) {
	case []any:
		for _, part := range value {
			if part == nil {
				continue
			}
			if text, ok := part.(string); ok {
				out = append(out, text)
			} else {
				out = append(out, fmt.Sprint(part))
			}
		}
	case []string:
		out = append(out, value...)
	case string:
		out = strings.Fields(value)
	}
	return out
}

func boolField(item map[string]any, key string) bool {
	value, _ := item[key].(bool)
	return value
}

func durationField(item map[string]any, key string) (time.Duration, bool, error) {
	raw, ok := item[key]
	if !ok || raw == nil {
		return 0, false, nil
	}
	switch value := raw.(type) {
	case string:
		text := strings.TrimSpace(value)
		if text == "" {
			return 0, false, nil
		}
		if text == "session" {
			if key != "cacheTtl" {
				return 0, false, fmt.Errorf("%s must be a duration like 10s or 1m", key)
			}
			return -1, true, nil
		}
		if seconds, err := strconv.Atoi(text); err == nil {
			if seconds < 0 {
				return 0, false, fmt.Errorf("%s %q must not be negative", key, text)
			}
			return time.Duration(seconds) * time.Second, true, nil
		}
		duration, err := time.ParseDuration(text)
		if err != nil || duration < 0 {
			return 0, false, fmt.Errorf("%s %q is not a duration like 30s, 5m or session", key, text)
		}
		return duration, true, nil
	case int:
		if value < 0 {
			return 0, false, fmt.Errorf("%s must not be negative", key)
		}
		return time.Duration(value) * time.Second, true, nil
	case float64:
		if value < 0 {
			return 0, false, fmt.Errorf("%s must not be negative", key)
		}
		return time.Duration(value * float64(time.Second)), true, nil
	default:
		return 0, false, fmt.Errorf("%s must be a duration like 30s, 5m or session", key)
	}
}
