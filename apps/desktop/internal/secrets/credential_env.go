package secrets

const GCPServiceAccountKeyEnv = "KURLO_GCP_SERVICE_ACCOUNT_KEY"

type CredentialEnv struct {
	Credential string `json:"credential"`
	Env        string `json:"env"`
}

func CredentialEnvNames(config ProviderConfig) []CredentialEnv {
	switch config.Type {
	case TypeVault:
		switch config.Auth.Method {
		case "token":
			return []CredentialEnv{{"token", "VAULT_TOKEN"}}
		case "approle":
			return []CredentialEnv{{"secretId", "VAULT_SECRET_ID"}}
		case "ldap", "userpass":
			out := []CredentialEnv{}
			if config.Auth.Username == "" {
				out = append(out, CredentialEnv{"username", "VAULT_USERNAME"})
			}
			return append(out, CredentialEnv{"password", "VAULT_PASSWORD"})
		}
	case TypeOnePassword:
		return []CredentialEnv{{"token", "OP_SERVICE_ACCOUNT_TOKEN"}}
	case TypeAWSSecretsManager, TypeAWSParameterStore:
		return []CredentialEnv{{"accessKeyId", "AWS_ACCESS_KEY_ID"}, {"secretAccessKey", "AWS_SECRET_ACCESS_KEY"}, {"sessionToken", "AWS_SESSION_TOKEN"}}
	case TypeGCPSecretManager:
		return []CredentialEnv{{"serviceAccountKey", GCPServiceAccountKeyEnv}}
	case TypeAzureKeyVault:
		if config.Auth.Method == "client-secret" {
			return []CredentialEnv{{"clientSecret", "AZURE_CLIENT_SECRET"}}
		}
	case TypeBitwarden:
		return []CredentialEnv{{"token", "BWS_ACCESS_TOKEN"}}
	case TypeDoppler:
		return []CredentialEnv{{"token", "DOPPLER_TOKEN"}}
	case TypeInfisical:
		if config.Auth.Method == "universal" {
			return []CredentialEnv{{"clientSecret", "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET"}}
		}
		return []CredentialEnv{{"token", "INFISICAL_TOKEN"}}
	}
	return nil
}
