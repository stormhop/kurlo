package api

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/loadtest"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	secretmgr "github.com/stormhop/kurlo/apps/desktop/internal/secrets"
)

type loadTestPayload struct {
	LoadTest    model.LoadTest    `json:"loadTest"`
	Collection  cliCollection     `json:"collection"`
	Requests    []cliSavedRequest `json:"requests"`
	Environment *cliEnvironment   `json:"environment"`
	Globals     []cliKV           `json:"globals"`
}

func (a *App) ValidateLoadTest(test model.LoadTest, requests []model.LoadTestRequest) []string {
	problems := loadtest.Validate(test, requests)
	if problems == nil {
		return []string{}
	}
	return problems
}

func (a *App) ExportLoadTestK6(payload string, inlineSecrets bool) model.K6ExportResult {
	plan, err := loadTestPlanFromPayload(payload, fileWorkspaceStorePath())
	if err != nil {
		return model.K6ExportResult{Warnings: []model.K6ExportWarning{}, Error: err.Error()}
	}
	result := loadtest.GenerateK6(plan, loadtest.Options{InlineSecrets: inlineSecrets})
	if result.Warnings == nil {
		result.Warnings = []model.K6ExportWarning{}
	}
	return result
}

func loadTestPlanFromPayload(payload, workspaceRoot string) (loadtest.Plan, error) {
	var decoded loadTestPayload
	if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
		return loadtest.Plan{}, fmt.Errorf("load test payload: %w", err)
	}
	plan := loadtest.Plan{
		Test:       decoded.LoadTest,
		Collection: decoded.Collection.Name,
		Requests:   map[string]loadtest.Request{},
		Variables:  loadTestVariables(decoded),
	}
	for _, saved := range decoded.Requests {
		if saved.IsDraft || saved.ID == "" {
			continue
		}
		plan.Requests[saved.ID] = loadTestRequest(saved, &decoded.Collection)
	}
	if data := decoded.LoadTest.Data; data != nil && strings.TrimSpace(data.Path) != "" {
		plan.Data, plan.DataError = loadTestData(workspaceRoot, data.Path)
	}
	return plan, nil
}

func loadTestVariables(payload loadTestPayload) []loadtest.Variable {
	order := []string{}
	byName := map[string]loadtest.Variable{}
	add := func(rows []cliKV) {
		for _, row := range rows {
			name := strings.TrimSpace(row.Key)
			if !row.Enabled || name == "" {
				continue
			}
			if _, exists := byName[name]; !exists {
				order = append(order, name)
			}
			if cliRowLinked(row) {
				byName[name] = loadtest.Variable{Name: name, Secret: true, Linked: true}
				continue
			}
			byName[name] = loadtest.Variable{Name: name, Value: row.Value, Secret: row.Secret}
		}
	}
	add(payload.Globals)
	add(payload.Collection.Defaults.Variables)
	if payload.Environment != nil {
		add(payload.Environment.Values)
	}
	variables := make([]loadtest.Variable, 0, len(order))
	for _, name := range order {
		variables = append(variables, byName[name])
	}
	return variables
}

func loadTestRequest(saved cliSavedRequest, collection *cliCollection) loadtest.Request {
	merged := applyCollectionDefaults(saved, collection)
	built := buildHTTPRequest(merged, nil, nil, 0)
	pairs := func(rows []model.KeyValue) []loadtest.Pair {
		out := make([]loadtest.Pair, 0, len(rows))
		for _, row := range rows {
			out = append(out, loadtest.Pair{Key: row.Key, Value: row.Value})
		}
		return out
	}
	form := make([]loadtest.FormField, 0, len(built.FormData))
	for _, field := range built.FormData {
		form = append(form, loadtest.FormField{Key: field.Key, Value: field.Value, IsFile: field.IsFile})
	}
	name := strings.TrimSpace(saved.Name)
	if name == "" {
		name = strings.TrimSpace(built.Method + " " + built.URL)
	}
	requestType := strings.ToLower(strings.TrimSpace(saved.RequestType))
	if requestType == "http" && strings.EqualFold(built.Method, "SSE") {
		requestType = "sse"
	}
	var redirects *int
	if !built.FollowRedirects {
		zero := 0
		redirects = &zero
	} else if built.MaxRedirects > 0 {
		redirects = &built.MaxRedirects
	}
	var variables []loadtest.Variable
	for _, row := range saved.Vars {
		if name := strings.TrimSpace(row.Key); row.Enabled && name != "" {
			variables = append(variables, loadtest.Variable{Name: name, Value: row.Value, Secret: row.Secret})
		}
	}
	return loadtest.Request{
		Redirects:  redirects,
		Variables:  variables,
		ID:         saved.ID,
		Name:       name,
		Type:       requestType,
		Method:     built.Method,
		URL:        built.URL,
		PathParams: pairs(built.PathParams),
		Query:      pairs(built.Params),
		Headers:    pairs(built.Headers),
		BodyType:   built.BodyType,
		Body:       built.Body,
		Form:       form,
		Auth:       built.Auth,
		TimeoutMs:  built.TimeoutMs,
		VerifyTLS:  built.EnableSSLVerification,
		HasScripts: strings.TrimSpace(built.PreRequestScript) != "" || strings.TrimSpace(built.TestScript) != "",
	}
}

func loadTestData(workspaceRoot, path string) ([]map[string]string, string) {
	if strings.TrimSpace(workspaceRoot) == "" {
		return nil, "the workspace is not stored in a folder"
	}
	abs, err := safeRepoRelativeFilePath(workspaceRoot, path)
	if err != nil {
		return nil, err.Error()
	}
	rows, err := loadDataFile(abs)
	if err != nil {
		return nil, err.Error()
	}
	return rows, ""
}

func resolveLoadTestLinkedSecrets(plan *loadtest.Plan, decoded loadTestPayload) error {
	if decoded.Environment == nil {
		return nil
	}
	rows := map[string]secretmgr.Ref{}
	for _, row := range decoded.Environment.Values {
		if ref, ok := secretmgr.RefFromMap(row.SecretRef); ok && row.Enabled && strings.TrimSpace(row.Key) != "" {
			rows[strings.TrimSpace(row.Key)] = ref
		}
	}
	for _, variable := range plan.Variables {
		if !variable.Linked {
			delete(rows, variable.Name)
		}
	}
	if len(rows) == 0 {
		return nil
	}
	linked := newAppLinkedSecrets(decoded.Collection.WorkspaceID)
	for _, request := range decoded.Requests {
		merged := applyCollectionDefaults(request, &decoded.Collection)
		linked.onlyFor(&merged)
	}
	linked.filtered = true
	linked.hint = "app"
	known := map[string]string{}
	for _, variable := range plan.Variables {
		if !variable.Linked {
			known[variable.Name] = variable.Value
		}
	}
	values, err := linked.fetch(decoded.Collection.WorkspaceID, rows, known)
	if err != nil {
		return err
	}
	for i := range plan.Variables {
		if value, ok := values[plan.Variables[i].Name]; ok && plan.Variables[i].Linked {
			plan.Variables[i].Value = value
		}
	}
	return nil
}
