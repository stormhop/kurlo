package secrets

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

type Secret struct {
	Raw       string
	Fields    map[string]string
	ExpiresAt time.Time
}

type Status struct {
	Detail    string   `json:"detail,omitempty"`
	ExpiresIn int64    `json:"expiresInSeconds,omitempty"`
	Policies  []string `json:"policies,omitempty"`
}

type Provider interface {
	Fetch(ctx context.Context, path, version string) (Secret, error)
	Check(ctx context.Context) (Status, error)
}

type Credentials func(name string) (string, bool)

type Environment struct {
	Getenv   func(string) (string, bool)
	HomeDir  func() (string, error)
	ReadFile func(string) ([]byte, error)
	Now      func() time.Time
	LookPath func(string) (string, error)
	Run      func(ctx context.Context, path string, args []string, env []string) ([]byte, []byte, error)

	OpenBrowser func(string) error
}

func SystemEnvironment() Environment {
	return Environment{Getenv: os.LookupEnv, HomeDir: os.UserHomeDir, ReadFile: os.ReadFile, Now: time.Now, LookPath: systemLookPath, Run: systemRun}
}

func (e Environment) withDefaults() Environment {
	system := SystemEnvironment()
	if e.Getenv == nil {
		e.Getenv = system.Getenv
	}
	if e.HomeDir == nil {
		e.HomeDir = system.HomeDir
	}
	if e.ReadFile == nil {
		e.ReadFile = system.ReadFile
	}
	if e.Now == nil {
		e.Now = system.Now
	}
	if e.LookPath == nil {
		e.LookPath = system.LookPath
	}
	if e.Run == nil {
		e.Run = system.Run
	}
	return e
}

func NewProvider(config ProviderConfig, credentials Credentials, env Environment) (Provider, error) {
	env = env.withDefaults()
	if credentials == nil {
		credentials = func(string) (string, bool) { return "", false }
	}
	switch config.Type {
	case TypeEnv:
		return &envProvider{config: config, env: env}, nil
	case TypeVault:
		return newVaultProvider(config, credentials, env)
	case TypeOnePassword:
		return &onePasswordProvider{config: config, credentials: credentials, env: env}, nil
	case TypeAWSSecretsManager, TypeAWSParameterStore:
		return newAWSProvider(config, credentials, env), nil
	case TypeGCPSecretManager:
		return newGCPProvider(config, credentials, env), nil
	case TypeAzureKeyVault:
		return newAzureProvider(config, credentials, env), nil
	case TypeBitwarden:
		return &bitwardenProvider{config: config, credentials: credentials, env: env}, nil
	case TypeDoppler:
		return newDopplerProvider(config, credentials, env), nil
	case TypeInfisical:
		return newInfisicalProvider(config, credentials, env), nil
	case TypeCommand:
		return &commandProvider{config: config, env: env}, nil
	default:
		return nil, newError(KindInvalidRef, config.ID, "unsupported provider type %q", config.Type)
	}
}

func (s Secret) Value(provider string, ref Ref) (string, error) {
	if ref.Field == "" {
		if s.Fields == nil {
			return checkedSecretValue(provider, ref, s.Raw)
		}
		if len(s.Fields) == 1 {
			for _, value := range s.Fields {
				return checkedSecretValue(provider, ref, value)
			}
		}
		return "", newError(KindInvalidRef, provider, "%s has %d fields, choose one: %s", ref.Path, len(s.Fields), strings.Join(s.FieldNames(), ", "))
	}
	if s.Fields == nil {
		fields, ok := jsonFields(s.Raw)
		if !ok {
			return "", newError(KindInvalidRef, provider, "%s is not JSON, remove the field %q", ref.Path, ref.Field)
		}
		s.Fields = fields
	}
	value, ok := s.Fields[ref.Field]
	if !ok {
		return "", newError(KindNotFound, provider, "%s has no field %q", ref.Path, ref.Field)
	}
	return checkedSecretValue(provider, ref, value)
}

func checkedSecretValue(provider string, ref Ref, value string) (string, error) {
	if value == "" {
		return "", newError(KindInvalidRef, provider, "%s has an empty value", ref.String())
	}
	return value, nil
}

func (s Secret) FieldNames() []string {
	fields := s.Fields
	if fields == nil {
		fields, _ = jsonFields(s.Raw)
	}
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func jsonFields(raw string) (map[string]string, bool) {
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, false
	}
	return stringifyFields(decoded), true
}

func stringifyFields(values map[string]any) map[string]string {
	out := make(map[string]string, len(values))
	for key, value := range values {
		switch typed := value.(type) {
		case string:
			out[key] = typed
		case nil:
			out[key] = ""
		default:
			encoded, err := json.Marshal(typed)
			if err != nil {
				out[key] = fmt.Sprint(typed)
			} else {
				out[key] = string(encoded)
			}
		}
	}
	return out
}

type envProvider struct {
	config ProviderConfig
	env    Environment
}

func (p *envProvider) Fetch(_ context.Context, path, _ string) (Secret, error) {
	value, ok := p.env.Getenv(path)
	if !ok {
		return Secret{}, newError(KindNotFound, p.config.ID, "environment variable %s is not set", path)
	}
	return Secret{Raw: value}, nil
}

func (p *envProvider) Check(context.Context) (Status, error) {
	return Status{Detail: "Reads environment variables of the Kurlo process"}, nil
}
