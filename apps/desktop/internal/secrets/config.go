package secrets

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

	DefaultCacheTTL = 5 * time.Minute
	DefaultTimeout  = 10 * time.Second
)

var (
	providerIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	awsRegionPattern  = regexp.MustCompile(`^[a-z]{2}(-[a-z]+)+-\d$`)
	gcpProjectPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{4,28}[a-z0-9]$|^[0-9]{6,20}$`)
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
	}{c.Type, strings.TrimRight(strings.TrimSpace(c.Address), "/"), strings.TrimSpace(c.Namespace), strings.TrimSpace(c.CACert), c.SkipTLSVerify, c.Account, c.Region, c.Profile, strings.TrimRight(c.Endpoint, "/"), c.Project, c.Command, c.Auth}
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
		}
	}
	if !providerIDPattern.MatchString(config.ID) {
		return config, fmt.Errorf("id %q must be lowercase letters, digits, - or _", config.ID)
	}
	if ttl, ok, err := durationField(item, "cacheTtl"); err != nil {
		return config, err
	} else if ok {
		config.CacheTTL = ttl
	}
	if timeout, ok, err := durationField(item, "timeout"); err != nil {
		return config, err
	} else if ok && timeout > 0 {
		config.Timeout = timeout
	}
	switch config.Type {
	case TypeEnv:
	case TypeVault:
		if err := requireURL(config, config.Address, "address", true); err != nil {
			return config, err
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
		default:
			return config, fmt.Errorf("provider %q: unsupported auth method %q", config.ID, config.Auth.Method)
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
	case TypeCommand:
		if len(config.Command) == 0 || strings.TrimSpace(config.Command[0]) == "" {
			return config, fmt.Errorf("provider %q: command is required, like [pass, show, \"{path}\"]", config.ID)
		}
	case "":
		return config, fmt.Errorf("provider %q: type is required", config.ID)
	default:
		return config, fmt.Errorf("provider %q: unsupported type %q", config.ID, config.Type)
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
	if !strings.HasPrefix(value, "https://") && !strings.HasPrefix(value, "http://") {
		return fmt.Errorf("provider %q: %s must start with https:// or http://", config.ID, field)
	}
	return nil
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
			return -1, true, nil
		}
		if seconds, err := strconv.Atoi(text); err == nil {
			return time.Duration(seconds) * time.Second, true, nil
		}
		duration, err := time.ParseDuration(text)
		if err != nil || duration < 0 {
			return 0, false, fmt.Errorf("%s %q is not a duration like 30s, 5m or session", key, text)
		}
		return duration, true, nil
	case int:
		return time.Duration(value) * time.Second, true, nil
	case float64:
		return time.Duration(value * float64(time.Second)), true, nil
	default:
		return 0, false, fmt.Errorf("%s must be a duration like 30s, 5m or session", key)
	}
}
