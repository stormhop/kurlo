package api

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const envImportLimit = 1 << 20

var dotEnvKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.]*$`)

type EnvFileValue struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type EnvFileImportResult struct {
	Path   string         `json:"path"`
	Values []EnvFileValue `json:"values"`
	Error  string         `json:"error"`
}

func readEnvFileForImport(path string) ([]EnvFileValue, error) {
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%s does not exist", path)
		}
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	if info.Size() > envImportLimit {
		return nil, fmt.Errorf("%s is larger than 1 MiB", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return parseDotEnv(string(data)), nil
}

func parseDotEnv(text string) []EnvFileValue {
	values := []EnvFileValue{}
	index := map[string]int{}
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "//") {
			continue
		}
		if rest, ok := strings.CutPrefix(trimmed, "export "); ok {
			trimmed = strings.TrimSpace(rest)
		}
		eq := strings.Index(trimmed, "=")
		if eq < 1 {
			continue
		}
		key := strings.TrimSpace(trimmed[:eq])
		if !dotEnvKeyPattern.MatchString(key) {
			continue
		}
		value := dotEnvValue(strings.TrimSpace(trimmed[eq+1:]))
		if at, seen := index[key]; seen {
			values[at].Value = value
			continue
		}
		index[key] = len(values)
		values = append(values, EnvFileValue{Key: key, Value: value})
	}
	return values
}

func dotEnvValue(raw string) string {
	if len(raw) >= 2 && raw[0] == '"' && raw[len(raw)-1] == '"' {
		inner := raw[1 : len(raw)-1]
		var out strings.Builder
		for i := 0; i < len(inner); i++ {
			if inner[i] == '\\' && i+1 < len(inner) {
				switch inner[i+1] {
				case 'n':
					out.WriteByte('\n')
					i++
					continue
				case 't':
					out.WriteByte('\t')
					i++
					continue
				case '"', '\\':
					out.WriteByte(inner[i+1])
					i++
					continue
				}
			}
			out.WriteByte(inner[i])
		}
		return out.String()
	}
	if len(raw) >= 2 && raw[0] == '\'' && raw[len(raw)-1] == '\'' {
		return raw[1 : len(raw)-1]
	}
	if hash := strings.Index(raw, " #"); hash >= 0 {
		return strings.TrimSpace(raw[:hash])
	}
	return raw
}

func (a *App) ChooseEnvFileToImport() EnvFileImportResult {
	result := EnvFileImportResult{Values: []EnvFileValue{}}
	if a.ctx == nil {
		return result
	}
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:           "Import a .env file",
		ShowHiddenFiles: true,
	})
	if err != nil || path == "" {
		return result
	}
	result.Path = path
	values, err := readEnvFileForImport(path)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.Values = values
	return result
}
