package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	secretmgr "github.com/stormhop/kurlo/apps/desktop/internal/secrets"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type SecretEnvVariable struct {
	Name       string `json:"name"`
	Credential string `json:"credential"`
	Saved      bool   `json:"saved"`
}

type SecretEnvExportResult struct {
	Ok        bool                `json:"ok"`
	Error     string              `json:"error,omitempty"`
	Path      string              `json:"path,omitempty"`
	Variables []SecretEnvVariable `json:"variables"`
}

var secretEnvSaveDialog = func(a *App, defaultName string) (string, error) {
	if a.ctx == nil {
		return "", fmt.Errorf("the save dialog is available in the desktop app")
	}
	return runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{DefaultFilename: defaultName, Title: "Export credentials for CI"})
}

func (a *App) PreviewSecretProviderEnv(workspaceID, providerID string) SecretEnvExportResult {
	_, variables, _, err := secretProviderEnv(workspaceID, providerID)
	if err != nil {
		return SecretEnvExportResult{Error: err.Error(), Variables: []SecretEnvVariable{}}
	}
	return SecretEnvExportResult{Ok: true, Variables: variables}
}

func (a *App) ExportSecretProviderEnv(workspaceID, providerID string) SecretEnvExportResult {
	config, variables, content, err := secretProviderEnv(workspaceID, providerID)
	if err != nil {
		return SecretEnvExportResult{Error: err.Error(), Variables: []SecretEnvVariable{}}
	}
	path, err := secretEnvSaveDialog(a, config.ID+".ci.env")
	if err != nil {
		return SecretEnvExportResult{Error: err.Error(), Variables: variables}
	}
	if path == "" {
		return SecretEnvExportResult{Variables: variables}
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return SecretEnvExportResult{Error: fmt.Sprintf("cannot write %s: %v", path, err), Variables: variables}
	}
	_ = os.Chmod(path, 0o600)
	return SecretEnvExportResult{Ok: true, Path: path, Variables: variables}
}

func secretProviderEnv(workspaceID, providerID string) (secretmgr.ProviderConfig, []SecretEnvVariable, string, error) {
	config, err := linkedSecrets.manager.Config(workspaceID, providerID)
	if err != nil {
		return config, nil, "", err
	}
	names := secretmgr.CredentialEnvNames(config)
	if len(names) == 0 {
		return config, nil, "", fmt.Errorf("%s needs no credentials in CI: it signs in with the machine's own tools", config.DisplayName())
	}
	credentials := linkedSecrets.Credentials(workspaceID, providerID)
	variables := make([]SecretEnvVariable, 0, len(names))
	var b strings.Builder
	for _, item := range names {
		value, ok := credentials(item.Credential)
		value = strings.TrimSpace(value)
		if item.Credential == "password" {
			value, _ = credentials(item.Credential)
		}
		if item.Credential == "serviceAccountKey" && value != "" {
			var compact bytes.Buffer
			if json.Compact(&compact, []byte(value)) == nil {
				value = compact.String()
			}
		}
		variables = append(variables, SecretEnvVariable{Name: item.Env, Credential: item.Credential, Saved: ok && value != ""})
		if !ok || value == "" {
			if item.Credential == "sessionToken" {
				continue
			}
			value = ""
		}
		b.WriteString(item.Env)
		b.WriteByte('=')
		b.WriteString(dotenvValue(value))
		b.WriteByte('\n')
	}
	return config, variables, b.String(), nil
}

func dotenvValue(value string) string {
	if value == "" || !strings.ContainsAny(value, " \t\r\n\"'#$\\`=") {
		return value
	}
	if !strings.ContainsAny(value, "'\r\n") {
		return "'" + value + "'"
	}
	replacer := strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "$", "\\$", "`", "\\`", "\r", "", "\n", "\\n")
	return "\"" + replacer.Replace(value) + "\""
}
