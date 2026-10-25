package loadtest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

var templateName = regexp.MustCompile(`\{\{([^{}]*)\}\}`)

var rawContentTypes = map[string]string{
	"json":       "application/json",
	"graphql":    "application/json",
	"text":       "text/plain",
	"javascript": "application/javascript",
	"xml":        "application/xml",
	"html":       "text/html",
}

var dynamicHelpers = map[string]string{
	"$guid":               "uuid",
	"$randomUUID":         "uuid",
	"$timestamp":          "() => String(Math.floor(Date.now() / 1000))",
	"$isoTimestamp":       "() => new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z')",
	"$randomInt":          "() => String(Math.floor(Math.random() * 1001))",
	"$randomBoolean":      "() => String(Math.random() < 0.5)",
	"$randomAlphaNumeric": "() => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.charAt(Math.floor(Math.random() * 62))",
	"$randomEmail":        "() => 'user' + Math.floor(Math.random() * 1e9) + '@example.com'",
	"$randomExampleEmail": "() => 'user' + Math.floor(Math.random() * 1e9) + '@example.com'",
}

var summaryTrendStats = []string{"avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"}

type generator struct {
	plan      Plan
	options   Options
	out       bytes.Buffer
	indent    int
	warnings  []model.K6ExportWarning
	warned    map[string]bool
	variables map[string]Variable
	columns   map[string]bool
	extracted map[string]bool
	defaults  map[string]string
	seen      map[string]bool
	dynamics  map[string]bool
	secrets   []string
	needs     map[string]bool
	tokens    []model.AuthConfig
	stepTags  map[string]string
	stepOrder []model.K6ExportStep
	insecure  bool
}

func GenerateK6(plan Plan, options Options) model.K6ExportResult {
	g := &generator{
		plan:      plan,
		options:   options,
		warned:    map[string]bool{},
		variables: map[string]Variable{},
		columns:   map[string]bool{},
		extracted: map[string]bool{},
		defaults:  map[string]string{},
		seen:      map[string]bool{},
		dynamics:  map[string]bool{},
		needs:     map[string]bool{},
		stepTags:  map[string]string{},
	}
	for _, variable := range plan.Variables {
		g.variables[variable.Name] = variable
	}
	for _, row := range plan.Data {
		for column := range row {
			g.columns[column] = true
		}
	}
	steps := g.steps()
	for _, step := range steps {
		for _, extract := range step.Extract {
			if extract.Var != "" {
				g.extracted[extract.Var] = true
			}
		}
	}
	g.insecure = plan.Test.Settings.Insecure
	body := g.defaultFunction(steps)
	g.writeScript(body)
	return model.K6ExportResult{
		Script:   g.out.String(),
		FileName: fileName(plan.Test.Name),
		Warnings: g.warnings,
		Steps:    g.stepOrder,
	}
}

func ThresholdKey(threshold model.LoadThreshold, tag string) string {
	if tag == "" {
		return threshold.Metric
	}
	return threshold.Metric + "{step:" + tag + "}"
}

func ThresholdExpression(threshold model.LoadThreshold) string {
	return threshold.Stat + threshold.Op + strconv.FormatFloat(threshold.Value, 'f', -1, 64)
}

func (g *generator) steps() []model.LoadStep {
	if len(g.plan.Test.Scenarios) == 0 {
		g.warn(0, "The load test has no flow, so the script sends no requests.")
		return nil
	}
	if len(g.plan.Test.Scenarios) > 1 {
		g.warn(0, "Only the first flow is exported.")
	}
	return g.plan.Test.Scenarios[0].Steps
}

func (g *generator) warn(step int, format string, args ...any) {
	message := fmt.Sprintf(format, args...)
	key := strconv.Itoa(step) + "|" + message
	if g.warned[key] {
		return
	}
	g.warned[key] = true
	g.warnings = append(g.warnings, model.K6ExportWarning{Level: "warn", Step: step, Message: message})
}

func (g *generator) info(format string, args ...any) {
	message := fmt.Sprintf(format, args...)
	if g.warned["info|"+message] {
		return
	}
	g.warned["info|"+message] = true
	g.warnings = append(g.warnings, model.K6ExportWarning{Level: "info", Message: message})
}

func jsString(value string) string {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return strings.TrimSuffix(buf.String(), "\n")
}

func jsValue(value any) string {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return strings.TrimSuffix(buf.String(), "\n")
}

func (g *generator) text(step int, value string) string {
	if !strings.Contains(value, "{{") {
		return jsString(value)
	}
	g.scan(step, value, 0)
	g.needs["t"] = true
	return "t(" + jsString(value) + ")"
}

func (g *generator) scan(step int, value string, depth int) {
	if depth > 10 {
		return
	}
	for _, match := range templateName.FindAllStringSubmatch(value, -1) {
		name := strings.TrimSpace(match[1])
		if name == "" {
			continue
		}
		if g.extracted[name] || g.columns[name] {
			continue
		}
		if strings.HasPrefix(name, "$") {
			if _, ok := dynamicHelpers[name]; ok {
				g.dynamics[name] = true
			} else {
				g.warn(step, "{{%s}} has no k6 equivalent and is sent as written.", name)
			}
			continue
		}
		variable, ok := g.variables[name]
		if !ok {
			g.warn(step, "{{%s}} is not set in the environment, the collection or globals. Pass it when running: k6 run -e %s=…", name, name)
			continue
		}
		if g.seen[name] {
			continue
		}
		g.seen[name] = true
		if variable.Secret && !g.options.InlineSecrets {
			g.secrets = append(g.secrets, name)
			continue
		}
		g.defaults[name] = variable.Value
		g.scan(step, variable.Value, depth+1)
	}
}

func fileName(name string) string {
	slug := slugify(name, "-")
	if slug == "" {
		slug = "load-test"
	}
	return slug + ".k6.js"
}

func slugify(value, separator string) string {
	var out strings.Builder
	pending := false
	for _, r := range strings.ToLower(value) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			if pending && out.Len() > 0 {
				out.WriteString(separator)
			}
			pending = false
			out.WriteRune(r)
			continue
		}
		pending = true
	}
	return out.String()
}

func (g *generator) line(format string, args ...any) {
	if format == "" {
		g.out.WriteByte('\n')
		return
	}
	g.out.WriteString(strings.Repeat("  ", g.indent))
	g.out.WriteString(fmt.Sprintf(format, args...))
	g.out.WriteByte('\n')
}

func (g *generator) stepTag(step model.LoadStep, request Request, used map[string]bool) string {
	name := step.Name
	if strings.TrimSpace(name) == "" {
		name = request.Name
	}
	tag := slugify(name, "_")
	if tag == "" {
		tag = "step"
	}
	candidate := tag
	for n := 2; used[candidate]; n++ {
		candidate = tag + "_" + strconv.Itoa(n)
	}
	used[candidate] = true
	return candidate
}

func (g *generator) defaultFunction(steps []model.LoadStep) string {
	saved := g.out
	g.out = bytes.Buffer{}
	g.indent = 1
	if len(g.plan.Data) > 0 {
		switch g.plan.Test.Data.Mode {
		case "per-iteration":
			g.needs["exec"] = true
			g.line("row = DATA[exec.scenario.iterationInTest %% DATA.length];")
		case "random":
			g.line("row = DATA[Math.floor(Math.random() * DATA.length)];")
		default:
			g.line("row = DATA[(__VU - 1) %% DATA.length];")
		}
	} else if g.plan.Test.Data != nil {
		message := g.plan.DataError
		if message == "" {
			message = "the file has no rows"
		}
		g.warn(0, "Test data %s is not exported: %s.", g.plan.Test.Data.Path, message)
	}
	used := map[string]bool{}
	for index, step := range steps {
		number := index + 1
		request, ok := g.plan.Requests[step.RequestID]
		if !ok {
			g.warn(number, "The request of this step is not in the collection, so the step is left out.")
			continue
		}
		switch request.Type {
		case "", "http", "graphql":
		default:
			g.warn(number, "%s is a %s request; only HTTP and GraphQL requests are exported.", request.Name, request.Type)
			continue
		}
		tag := g.stepTag(step, request, used)
		g.stepTags[step.ID] = tag
		g.stepOrder = append(g.stepOrder, model.K6ExportStep{StepID: step.ID, Tag: tag})
		g.writeStep(number, step, request, tag)
	}
	body := g.out.String()
	g.out = saved
	g.indent = 0
	return body
}

func (g *generator) writeStep(number int, step model.LoadStep, request Request, tag string) {
	if request.HasScripts {
		g.warn(number, "The pre-request and test scripts of %s are not exported. Add checks to the step instead.", request.Name)
	}
	if !request.VerifyTLS && !g.insecure {
		g.insecure = true
		g.warn(number, "%s skips TLS certificate checks, so the whole script does.", request.Name)
	}
	if step.Once {
		g.line("if (!done[%s]) {", jsString(step.ID))
		g.indent++
	}
	g.line("group(%s, () => {", jsString(tag))
	g.indent++
	g.line("const res = http.request(%s, %s, %s, %s);", jsString(request.Method), g.urlExpr(number, request), g.bodyExpr(number, request), g.paramsExpr(number, request, tag))
	g.writeChecks(number, step, tag)
	g.writeExtracts(number, step)
	g.indent--
	g.line("});")
	if step.Once {
		g.line("done[%s] = true;", jsString(step.ID))
		g.indent--
		g.line("}")
	}
	if step.ThinkTimeMs > 0 || step.ThinkJitterMs > 0 {
		wait := seconds(step.ThinkTimeMs)
		if step.ThinkJitterMs > 0 {
			g.line("sleep(%s + Math.random() * %s);", wait, seconds(step.ThinkJitterMs))
		} else {
			g.line("sleep(%s);", wait)
		}
	}
}

func seconds(ms int) string {
	return strconv.FormatFloat(float64(ms)/1000, 'f', -1, 64)
}

func (g *generator) urlExpr(number int, request Request) string {
	raw := applyPathParams(request.URL, request.PathParams)
	expr := g.text(number, raw)
	query := make([]string, 0, len(request.Query)+1)
	for _, pair := range request.Query {
		query = append(query, "["+g.text(number, pair.Key)+", "+g.text(number, pair.Value)+"]")
	}
	auth := strings.ToLower(strings.TrimSpace(request.Auth.Type))
	if auth == "apikey" && request.Auth.KeyIn == "query" && request.Auth.KeyName != "" {
		query = append(query, "["+g.text(number, request.Auth.KeyName)+", "+g.text(number, request.Auth.KeyValue)+"]")
	}
	if len(query) > 0 {
		g.needs["q"] = true
		expr = "q(" + expr + ", [" + strings.Join(query, ", ") + "])"
	}
	if auth == "digest" {
		g.needs["withUser"] = true
		expr = "withUser(" + expr + ", " + g.text(number, request.Auth.Username) + ", " + g.text(number, request.Auth.Password) + ")"
	}
	return expr
}

func applyPathParams(rawURL string, params []Pair) string {
	values := map[string]string{}
	for _, param := range params {
		if param.Key != "" && param.Value != "" {
			values[param.Key] = param.Value
		}
	}
	if len(values) == 0 {
		return rawURL
	}
	start := 0
	if scheme := strings.Index(rawURL, "://"); scheme >= 0 {
		slash := strings.IndexByte(rawURL[scheme+3:], '/')
		if slash < 0 {
			return rawURL
		}
		start = scheme + 3 + slash
	}
	end := len(rawURL)
	if cut := strings.IndexAny(rawURL[start:], "?#"); cut >= 0 {
		end = start + cut
	}
	segments := strings.Split(rawURL[start:end], "/")
	for i, segment := range segments {
		if !strings.HasPrefix(segment, ":") {
			continue
		}
		if value, ok := values[segment[1:]]; ok {
			if strings.Contains(value, "{{") {
				segments[i] = value
			} else {
				segments[i] = url.PathEscape(value)
			}
		}
	}
	return rawURL[:start] + strings.Join(segments, "/") + rawURL[end:]
}

func (g *generator) bodyExpr(number int, request Request) string {
	if _, ok := rawContentTypes[request.BodyType]; ok {
		if request.Body == "" {
			return "null"
		}
		return g.text(number, request.Body)
	}
	switch request.BodyType {
	case "urlencoded", "form":
		fields := make([]string, 0, len(request.Form))
		skipped := false
		for _, field := range request.Form {
			if field.IsFile {
				skipped = true
				continue
			}
			fields = append(fields, g.text(number, field.Key)+": "+g.text(number, field.Value))
		}
		if request.BodyType == "form" {
			g.warn(number, "The multipart form of %s is sent URL-encoded.", request.Name)
		}
		if skipped {
			g.warn(number, "File fields of %s are not exported.", request.Name)
		}
		if len(fields) == 0 {
			return "null"
		}
		return "{ " + strings.Join(fields, ", ") + " }"
	case "binary":
		g.warn(number, "The file body of %s is not exported.", request.Name)
	}
	return "null"
}

func (g *generator) paramsExpr(number int, request Request, tag string) string {
	headers := make([]string, 0, len(request.Headers)+2)
	has := map[string]bool{}
	for _, header := range request.Headers {
		has[strings.ToLower(strings.TrimSpace(header.Key))] = true
		headers = append(headers, g.text(number, header.Key)+": "+g.text(number, header.Value))
	}
	if contentType, ok := rawContentTypes[request.BodyType]; ok && request.Body != "" && !has["content-type"] {
		headers = append(headers, jsString("Content-Type")+": "+jsString(contentType))
	}
	if auth := g.authHeader(number, request); auth != "" && !has["authorization"] {
		headers = append(headers, jsString("Authorization")+": "+auth)
	}
	auth := strings.ToLower(strings.TrimSpace(request.Auth.Type))
	if auth == "apikey" && request.Auth.KeyIn != "query" && request.Auth.KeyName != "" {
		headers = append(headers, g.text(number, request.Auth.KeyName)+": "+g.text(number, request.Auth.KeyValue))
	}
	parts := []string{}
	if len(headers) > 0 {
		parts = append(parts, "headers: { "+strings.Join(headers, ", ")+" }")
	}
	parts = append(parts, "tags: { step: "+jsString(tag)+" }")
	timeout := g.plan.Test.Settings.TimeoutMs
	if timeout <= 0 {
		timeout = request.TimeoutMs
	}
	if timeout > 0 {
		parts = append(parts, "timeout: "+jsString(k6Duration(timeout)))
	}
	if auth == "digest" {
		parts = append(parts, "auth: 'digest'")
	}
	return "{ " + strings.Join(parts, ", ") + " }"
}

func (g *generator) authHeader(number int, request Request) string {
	cfg := request.Auth
	switch strings.ToLower(strings.TrimSpace(cfg.Type)) {
	case "", "none", "inherit", "apikey", "digest":
		return ""
	case "bearer":
		if cfg.Token == "" {
			return ""
		}
		return g.text(number, "Bearer "+cfg.Token)
	case "basic":
		g.needs["encoding"] = true
		return "'Basic ' + encoding.b64encode(" + g.text(number, cfg.Username+":"+cfg.Password) + ")"
	case "oauth2":
		grant := strings.ToLower(strings.TrimSpace(cfg.OAuth2GrantType))
		if (grant == "client_credentials" || grant == "password") && strings.TrimSpace(cfg.OAuth2TokenURL) != "" {
			index := g.tokenIndex(number, cfg)
			return "'Bearer ' + data.tokens[" + strconv.Itoa(index) + "]"
		}
		if cfg.Token != "" {
			g.warn(number, "%s uses the saved OAuth 2.0 token, which may expire during the test.", request.Name)
			return g.text(number, "Bearer "+cfg.Token)
		}
		g.warn(number, "The OAuth 2.0 %s grant of %s is not exported; the request is sent without auth.", strings.ReplaceAll(grant, "_", " "), request.Name)
		return ""
	default:
		g.warn(number, "%s auth of %s is not exported; the request is sent without it.", strings.ToUpper(cfg.Type[:1])+cfg.Type[1:], request.Name)
		return ""
	}
}

func (g *generator) tokenIndex(number int, cfg model.AuthConfig) int {
	for index, existing := range g.tokens {
		if sameTokenSource(existing, cfg) {
			return index
		}
	}
	g.tokens = append(g.tokens, cfg)
	for _, value := range []string{cfg.OAuth2TokenURL, cfg.OAuth2ClientID, cfg.OAuth2Secret, cfg.OAuth2Scope, cfg.OAuth2Audience, cfg.OAuth2Username, cfg.OAuth2Password} {
		g.scan(number, value, 0)
	}
	return len(g.tokens) - 1
}

func sameTokenSource(a, b model.AuthConfig) bool {
	return a.OAuth2GrantType == b.OAuth2GrantType && a.OAuth2TokenURL == b.OAuth2TokenURL &&
		a.OAuth2ClientID == b.OAuth2ClientID && a.OAuth2Secret == b.OAuth2Secret &&
		a.OAuth2Scope == b.OAuth2Scope && a.OAuth2Audience == b.OAuth2Audience &&
		a.OAuth2Username == b.OAuth2Username && a.OAuth2Password == b.OAuth2Password &&
		a.OAuth2ClientAuth == b.OAuth2ClientAuth
}

func (g *generator) writeChecks(number int, step model.LoadStep, tag string) {
	entries := []string{}
	for _, check := range step.Checks {
		switch check.Type {
		case "status":
			code, err := strconv.Atoi(strings.TrimSpace(check.Value))
			if err != nil {
				g.warn(number, "The status check %q is not a number and is left out.", check.Value)
				continue
			}
			entries = append(entries, jsString(fmt.Sprintf("status is %d", code))+": (r) => r.status === "+strconv.Itoa(code))
		case "jsonExists":
			path, err := jsonPathToGJSON(check.Path)
			if err != nil {
				g.warn(number, "%s; the check is left out.", err.Error())
				continue
			}
			g.needs["jsonAt"] = true
			entries = append(entries, jsString(check.Path+" exists")+": (r) => jsonAt(r, "+jsString(path)+") !== undefined")
		case "bodyContains":
			entries = append(entries, jsString(fmt.Sprintf("body contains %q", check.Value))+": (r) => typeof r.body === 'string' && r.body.includes("+g.text(number, check.Value)+")")
		default:
			g.warn(number, "The %q check is not exported.", check.Type)
		}
	}
	if len(entries) == 0 {
		return
	}
	g.line("check(res, {")
	g.indent++
	for _, entry := range entries {
		g.line("%s,", entry)
	}
	g.indent--
	g.line("}, { step: %s });", jsString(tag))
}

func (g *generator) writeExtracts(number int, step model.LoadStep) {
	for _, extract := range step.Extract {
		if extract.Var == "" {
			continue
		}
		target := "vu[" + jsString(extract.Var) + "]"
		switch extract.From {
		case "json":
			path, err := jsonPathToGJSON(extract.Path)
			if err != nil {
				g.warn(number, "%s; %s is not saved.", err.Error(), extract.Var)
				continue
			}
			g.needs["jsonAt"] = true
			g.line("%s = jsonAt(res, %s);", target, jsString(path))
		case "header":
			g.needs["header"] = true
			g.line("%s = header(res, %s);", target, jsString(extract.Path))
		case "regex":
			if _, err := regexp.Compile(extract.Path); err != nil {
				g.warn(number, "The pattern for %s is not valid; it is not saved.", extract.Var)
				continue
			}
			g.line("%s = ((typeof res.body === 'string' ? res.body : '').match(new RegExp(%s)) || [])[1];", target, jsString(extract.Path))
		default:
			g.warn(number, "%s is saved from %q, which is not exported.", extract.Var, extract.From)
		}
	}
}

func k6Duration(ms int) string {
	if ms <= 0 {
		return "0s"
	}
	if ms%1000 != 0 {
		return strconv.Itoa(ms) + "ms"
	}
	total := ms / 1000
	hours := total / 3600
	minutes := (total % 3600) / 60
	secs := total % 60
	var out strings.Builder
	if hours > 0 {
		out.WriteString(strconv.Itoa(hours) + "h")
	}
	if minutes > 0 {
		out.WriteString(strconv.Itoa(minutes) + "m")
	}
	if secs > 0 || out.Len() == 0 {
		out.WriteString(strconv.Itoa(secs) + "s")
	}
	return out.String()
}

func (g *generator) scenario() []string {
	executor := model.LoadExecutor{Type: "constant-vus", VUs: 1, DurationMs: 60000}
	if len(g.plan.Test.Scenarios) > 0 {
		executor = g.plan.Test.Scenarios[0].Executor
	}
	fields := []string{"executor: " + jsString(executor.Type)}
	stages := func() string {
		items := make([]string, 0, len(executor.Stages))
		for _, stage := range executor.Stages {
			items = append(items, "{ duration: "+jsString(k6Duration(stage.DurationMs))+", target: "+strconv.Itoa(stage.Target)+" }")
		}
		return "stages: [" + strings.Join(items, ", ") + "]"
	}
	timeUnit := executor.TimeUnitMs
	if timeUnit <= 0 {
		timeUnit = 1000
	}
	switch executor.Type {
	case "constant-vus":
		fields = append(fields, "vus: "+strconv.Itoa(executor.VUs), "duration: "+jsString(k6Duration(executor.DurationMs)))
	case "ramping-vus":
		fields = append(fields, "startVUs: 0", stages())
	case "constant-arrival-rate":
		fields = append(fields, "rate: "+strconv.Itoa(executor.Rate), "timeUnit: "+jsString(k6Duration(timeUnit)), "duration: "+jsString(k6Duration(executor.DurationMs)), "preAllocatedVUs: "+strconv.Itoa(executor.PreAllocatedVUs))
		if executor.MaxVUs > 0 {
			fields = append(fields, "maxVUs: "+strconv.Itoa(executor.MaxVUs))
		}
	case "ramping-arrival-rate":
		fields = append(fields, "startRate: 0", "timeUnit: "+jsString(k6Duration(timeUnit)), "preAllocatedVUs: "+strconv.Itoa(executor.PreAllocatedVUs))
		if executor.MaxVUs > 0 {
			fields = append(fields, "maxVUs: "+strconv.Itoa(executor.MaxVUs))
		}
		fields = append(fields, stages())
	default:
		g.warn(0, "The load model %q is not known to k6.", executor.Type)
	}
	return fields
}

func (g *generator) thresholds() []string {
	byKey := map[string][]string{}
	for _, threshold := range g.plan.Test.Thresholds {
		tag := ""
		if threshold.Step != "" {
			found, ok := g.stepTags[threshold.Step]
			if !ok {
				g.warn(0, "A threshold applies to a step that is not exported, so it is left out.")
				continue
			}
			tag = found
		}
		key := ThresholdKey(threshold, tag)
		expression := ThresholdExpression(threshold)
		if threshold.AbortOnFail {
			byKey[key] = append(byKey[key], "{ threshold: "+jsString(expression)+", abortOnFail: true }")
		} else {
			byKey[key] = append(byKey[key], jsString(expression))
		}
	}
	for _, tag := range g.stepTags {
		for _, metric := range []string{"http_req_duration", "http_req_failed", "http_reqs", "checks"} {
			key := metric + "{step:" + tag + "}"
			if _, ok := byKey[key]; !ok {
				byKey[key] = []string{}
			}
		}
	}
	keys := make([]string, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	lines := make([]string, 0, len(keys))
	for _, key := range keys {
		lines = append(lines, jsString(key)+": ["+strings.Join(byKey[key], ", ")+"],")
	}
	return lines
}

func (g *generator) writeScript(body string) {
	setupBody := g.setup()
	g.line("import http from 'k6/http';")
	g.line("import { check, group, sleep } from 'k6';")
	if g.needs["encoding"] {
		g.line("import encoding from 'k6/encoding';")
	}
	if len(g.plan.Data) > 0 {
		g.line("import { SharedArray } from 'k6/data';")
	}
	if g.needs["exec"] {
		g.line("import exec from 'k6/execution';")
	}
	g.line("")
	g.line("export const options = {")
	g.indent++
	g.line("scenarios: {")
	g.indent++
	g.line("main: {")
	g.indent++
	for _, field := range g.scenario() {
		g.line("%s,", field)
	}
	g.indent--
	g.line("},")
	g.indent--
	g.line("},")
	g.line("thresholds: {")
	g.indent++
	for _, line := range g.thresholds() {
		g.line("%s", line)
	}
	g.indent--
	g.line("},")
	g.line("summaryTrendStats: %s,", jsValue(summaryTrendStats))
	if g.insecure {
		g.line("insecureSkipTLSVerify: true,")
	}
	g.indent--
	g.line("};")
	g.line("")

	names := make([]string, 0, len(g.defaults))
	for name := range g.defaults {
		names = append(names, name)
	}
	sort.Strings(names)
	g.line("const DEFAULTS = {")
	g.indent++
	for _, name := range names {
		g.line("%s: %s,", jsString(name), jsString(g.defaults[name]))
	}
	g.indent--
	g.line("};")
	if len(g.plan.Data) > 0 {
		g.line("const DATA = new SharedArray('data', () => %s);", jsValue(g.plan.Data))
	}
	dynamicNames := make([]string, 0, len(g.dynamics))
	for name := range g.dynamics {
		dynamicNames = append(dynamicNames, name)
	}
	sort.Strings(dynamicNames)
	g.line("const DYNAMIC = {")
	g.indent++
	for _, name := range dynamicNames {
		g.line("%s: %s,", jsString(name), dynamicHelpers[name])
	}
	g.indent--
	g.line("};")
	g.line("")
	g.line("const vu = {};")
	g.line("const done = {};")
	g.line("let row = {};")
	g.line("")
	g.writeHelpers()
	if setupBody != "" {
		g.out.WriteString(setupBody)
		g.line("")
	}
	if setupBody != "" {
		g.line("export default function (data) {")
	} else {
		g.line("export default function () {")
	}
	g.out.WriteString(body)
	g.line("}")

	sort.Strings(g.secrets)
	for _, name := range g.secrets {
		g.info("%s is secret and is not written into the script. Pass it when running: k6 run -e %s=…", name, name)
	}
}

func (g *generator) setup() string {
	if len(g.tokens) == 0 {
		return ""
	}
	saved := g.out
	g.out = bytes.Buffer{}
	g.line("export function setup() {")
	g.indent++
	g.line("const tokens = [];")
	for index, cfg := range g.tokens {
		grant := strings.ToLower(strings.TrimSpace(cfg.OAuth2GrantType))
		fields := []string{"grant_type: " + jsString(grant)}
		if grant == "password" {
			fields = append(fields, "username: "+g.text(0, cfg.OAuth2Username), "password: "+g.text(0, cfg.OAuth2Password))
		}
		if cfg.OAuth2Scope != "" {
			fields = append(fields, "scope: "+g.text(0, cfg.OAuth2Scope))
		}
		if cfg.OAuth2Audience != "" {
			fields = append(fields, "audience: "+g.text(0, cfg.OAuth2Audience))
		}
		headers := ""
		if strings.EqualFold(cfg.OAuth2ClientAuth, "body") {
			fields = append(fields, "client_id: "+g.text(0, cfg.OAuth2ClientID), "client_secret: "+g.text(0, cfg.OAuth2Secret))
		} else {
			g.needs["encoding"] = true
			headers = ", { headers: { Authorization: 'Basic ' + encoding.b64encode(" + g.text(0, cfg.OAuth2ClientID+":"+cfg.OAuth2Secret) + ") } }"
		}
		g.line("const token%d = http.post(%s, { %s }%s);", index, g.text(0, cfg.OAuth2TokenURL), strings.Join(fields, ", "), headers)
		g.line("check(token%d, { 'token received': (r) => r.status === 200 });", index)
		g.line("tokens.push(token%d.json('access_token'));", index)
	}
	g.line("return { tokens };")
	g.indent--
	g.line("}")
	out := g.out.String()
	g.out = saved
	return out
}

func (g *generator) writeHelpers() {
	g.line("function env(name, depth) {")
	g.line("  const raw = __ENV[name] !== undefined ? __ENV[name] : DEFAULTS[name];")
	g.line("  return raw === undefined ? undefined : t(String(raw), depth + 1);")
	g.line("}")
	g.line("")
	g.line("function lookup(name, depth) {")
	g.line("  if (name in vu) return vu[name] === undefined ? undefined : String(vu[name]);")
	g.line("  if (name in row) return String(row[name]);")
	g.line("  if (name in DYNAMIC) return DYNAMIC[name]();")
	g.line("  return env(name, depth);")
	g.line("}")
	g.line("")
	g.line("function t(text, depth = 0) {")
	g.line("  if (depth > 10) return text;")
	g.line("  return text.replace(/\\{\\{([^{}]*)\\}\\}/g, (match, key) => {")
	g.line("    const value = lookup(key.trim(), depth);")
	g.line("    return value === undefined ? match : value;")
	g.line("  });")
	g.line("}")
	g.line("")
	if g.dynamics["$guid"] || g.dynamics["$randomUUID"] {
		g.line("function uuid() {")
		g.line("  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {")
		g.line("    const r = Math.floor(Math.random() * 16);")
		g.line("    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);")
		g.line("  });")
		g.line("}")
		g.line("")
	}
	if g.needs["q"] {
		g.line("function q(url, pairs) {")
		g.line("  const query = pairs.map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');")
		g.line("  if (!query) return url;")
		g.line("  return url + (url.includes('?') ? '&' : '?') + query;")
		g.line("}")
		g.line("")
	}
	if g.needs["withUser"] {
		g.line("function withUser(url, user, password) {")
		g.line("  return url.replace('://', '://' + encodeURIComponent(user) + ':' + encodeURIComponent(password) + '@');")
		g.line("}")
		g.line("")
	}
	if g.needs["jsonAt"] {
		g.line("function jsonAt(res, path) {")
		g.line("  try {")
		g.line("    return path ? res.json(path) : res.json();")
		g.line("  } catch (error) {")
		g.line("    return undefined;")
		g.line("  }")
		g.line("}")
		g.line("")
	}
	if g.needs["header"] {
		g.line("function header(res, name) {")
		g.line("  const key = Object.keys(res.headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());")
		g.line("  return key === undefined ? undefined : res.headers[key];")
		g.line("}")
		g.line("")
	}
}
