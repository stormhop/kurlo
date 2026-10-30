package api

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func frontendSource(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join("..", "..", "frontend", "src", "lib", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("frontend sources unavailable: %v", err)
	}
	return string(data)
}

func objectKeys(t *testing.T, source, declaration string) []string {
	t.Helper()
	start := strings.Index(source, declaration)
	if start < 0 {
		t.Fatalf("could not find %q in the frontend source", declaration)
	}
	depth, end := 0, -1
	for i := start; i < len(source); i++ {
		switch source[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				end = i
			}
		}
		if end >= 0 {
			break
		}
	}
	if end < 0 {
		t.Fatalf("unbalanced braces after %q", declaration)
	}
	var keys []string
	for _, m := range regexp.MustCompile(`(?m)^\s{2,4}([A-Za-z][A-Za-z0-9]*)\??\s*:`).FindAllStringSubmatch(source[start:end], -1) {
		keys = append(keys, m[1])
	}
	if len(keys) == 0 {
		t.Fatalf("found no properties in %q", declaration)
	}
	return keys
}

func jsonFieldNames(value any) []string {
	typ := reflect.TypeOf(value)
	names := make([]string, 0, typ.NumField())
	for i := 0; i < typ.NumField(); i++ {
		tag := typ.Field(i).Tag.Get("json")
		if tag == "" || tag == "-" {
			continue
		}
		names = append(names, strings.Split(tag, ",")[0])
	}
	return names
}

func missingFrom(want, have []string) []string {
	present := make(map[string]bool, len(have))
	for _, name := range have {
		present[name] = true
	}
	var missing []string
	for _, name := range want {
		if !present[name] {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	return missing
}

func TestRequestSettingListsCoverTheFrontendModel(t *testing.T) {
	settings := objectKeys(t, frontendSource(t, "constants.ts"), "export const DEFAULT_REQUEST_SETTINGS")

	alwaysWritten := map[string]bool{
		"scriptTimeoutMs":   true,
		"allowSendRequest":  true,
		"clientCertPath":    true,
		"clientKeyPath":     true,
		"clientKeyPassword": true,
	}

	var unknown []string
	for _, name := range settings {
		if alwaysWritten[name] {
			continue
		}
		if _, ok := savedRequestSettingDefaults[name]; !ok {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) > 0 {
		t.Errorf("settings with no entry in savedRequestSettingDefaults, so a non-default value is written to the workspace on every save: %s",
			strings.Join(unknown, ", "))
	}

	known := make(map[string]bool, len(settings))
	for _, name := range settings {
		known[name] = true
	}
	var stale []string
	for name := range savedRequestSettingDefaults {
		if !known[name] {
			stale = append(stale, name)
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("savedRequestSettingDefaults names settings the frontend no longer has: %s", strings.Join(stale, ", "))
	}
}

func TestCLIStructsCoverTheAuthModel(t *testing.T) {
	authState := objectKeys(t, frontendSource(t, "utils.ts"), "export function emptyAuthState()")
	declared := jsonFieldNames(cliAuth{})

	skip := map[string]string{
		"oauth2TokenExpiry":        "a run fetches its own token, so the app's expiry stamp is irrelevant",
		"oauth2RedirectURL":        "the loopback redirect is built by the Go side at authorize time",
		"oauth2InsecureSkipVerify": "covered by the run's --insecure flag",
	}
	var want []string
	for _, name := range authState {
		if _, skipped := skip[name]; !skipped {
			want = append(want, name)
		}
	}

	if missing := missingFrom(want, declared); len(missing) > 0 {
		t.Errorf("cliAuth cannot decode these auth fields, so `kurlo run` ignores them: %s\n"+
			"add them to cliAuth and map them in buildHTTPRequest, or add them to the skip list with a reason",
			strings.Join(missing, ", "))
	}
}

func TestCLIStructsCoverTheSettingsModel(t *testing.T) {
	settings := objectKeys(t, frontendSource(t, "constants.ts"), "export const DEFAULT_REQUEST_SETTINGS")
	declared := jsonFieldNames(cliSettings{})

	skip := regexp.MustCompile(`^(ws|sio|sse|grpc)`)
	notWiredYet := map[string]bool{
		"browserEmulation":          true,
		"browserOrigin":             true,
		"browserWithCredentials":    true,
		"browserEnforceCORS":        true,
		"browserEnforceCSP":         true,
		"browserCSP":                true,
		"followAuthorizationHeader": true,
		"removeRefererHeader":       true,
	}

	var want []string
	for _, name := range settings {
		if skip.MatchString(name) || notWiredYet[name] {
			continue
		}
		want = append(want, name)
	}

	if missing := missingFrom(want, declared); len(missing) > 0 {
		t.Errorf("cliSettings cannot decode these settings, so `kurlo run` behaves differently from the app: %s",
			strings.Join(missing, ", "))
	}
}

func TestEventPayloadsMatchTheirHandWrittenTypes(t *testing.T) {
	wire := frontendSource(t, "wire.ts")

	cases := []struct {
		tsType string
		goType any
	}{
		{"GrpcHeadersEvent", model.GrpcHeadersEvent{}},
		{"GrpcMessageEvent", model.GrpcMessageEvent{}},
		{"GrpcTrailersEvent", model.GrpcTrailersEvent{}},
		{"GrpcDoneEvent", model.GrpcDoneEvent{}},
		{"OAuth2DevicePrompt", model.OAuth2DevicePrompt{}},
	}

	for _, testCase := range cases {
		t.Run(testCase.tsType, func(t *testing.T) {
			declared := objectKeys(t, wire, fmt.Sprintf("export type %s = {", testCase.tsType))
			goFields := jsonFieldNames(testCase.goType)

			if missing := missingFrom(goFields, declared); len(missing) > 0 {
				t.Errorf("%s in wire.ts is missing fields the Go struct emits: %s", testCase.tsType, strings.Join(missing, ", "))
			}
			if extra := missingFrom(declared, goFields); len(extra) > 0 {
				t.Errorf("%s in wire.ts declares fields the Go struct does not emit: %s", testCase.tsType, strings.Join(extra, ", "))
			}
		})
	}
}

func TestCLILoadCollectionsDecodePersistedTests(t *testing.T) {
	fields := jsonFieldNames(cliCollection{})
	if missing := missingFrom([]string{"id", "workspaceId", "filesystemName", "loadTests", "defaults"}, fields); len(missing) > 0 {
		t.Fatalf("CLI collections drop load-test fields: %v", missing)
	}
	field, ok := reflect.TypeOf(cliCollection{}).FieldByName("LoadTests")
	if !ok || field.Type != reflect.TypeOf([]model.LoadTest{}) {
		t.Fatal("CLI collections must use the shared load-test model")
	}
	if missing := missingFrom([]string{"workspaceId", "name", "values"}, jsonFieldNames(cliEnvironment{})); len(missing) > 0 {
		t.Fatalf("CLI environments cannot be scoped to the test's workspace: %v", missing)
	}
}
