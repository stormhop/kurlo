package api

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type cliOptions struct {
	workspace           string
	env                 string
	collection          string
	folder              []string
	reporters           []string
	reporterJSONExport  string
	reporterJUnitExport string
	exportEnvironment   string
	exportGlobals       string
	globalsFile         string
	globalVars          map[string]string
	vars                map[string]string
	envFile             string
	dataFile            string
	timeoutMs           int
	scriptTimeoutMs     int
	allowSendRequest    bool
	delayMs             int
	iterations          int
	iterationCount      int
	failFast            bool
	insecure            bool
	verbose             bool
	stdout              io.Writer
	stderr              io.Writer
}

type cliTestResult struct {
	Name   string `json:"name"`
	Passed bool   `json:"passed"`
	Error  string `json:"error,omitempty"`
}

type cliRunResult struct {
	secrets     []string
	Name        string          `json:"name"`
	Method      string          `json:"method"`
	URL         string          `json:"url"`
	Iteration   int             `json:"iteration"`
	StatusCode  int             `json:"statusCode"`
	DurationMs  int64           `json:"durationMs"`
	Size        int64           `json:"size"`
	ContentType string          `json:"contentType,omitempty"`
	Error       string          `json:"error,omitempty"`
	Skipped     bool            `json:"skipped,omitempty"`
	SkipReason  string          `json:"skipReason,omitempty"`
	Tests       []cliTestResult `json:"tests"`
	TestsPassed int             `json:"testsPassed"`
	TestsTotal  int             `json:"testsTotal"`
	Logs        []string        `json:"logs,omitempty"`
}

func (r cliRunResult) failed() bool {
	return !r.Skipped && (r.Error != "" || (r.TestsTotal > 0 && r.TestsPassed != r.TestsTotal))
}

func RunCLI(args []string) int {
	opts, err := parseCLIArgs(args, os.Stdout, os.Stderr)
	if err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		fmt.Fprintln(os.Stderr, "kurlo run:", err)
		return 2
	}
	return runCLI(opts)
}

func parseCLIArgs(args []string, stdout, stderr io.Writer) (cliOptions, error) {
	fs := flag.NewFlagSet("kurlo run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	opts := cliOptions{vars: map[string]string{}, globalVars: map[string]string{}, stdout: stdout, stderr: stderr}

	fs.StringVar(&opts.workspace, "workspace", ".", "path to the Kurlo YAML workspace directory")
	fs.StringVar(&opts.env, "env", "", "environment name to resolve variables from")
	fs.StringVar(&opts.collection, "collection", "", "only run requests in this collection (by name)")
	folder := fs.String("folder", "", "only run requests under this folder path (slash-separated)")
	reporters := fs.String("reporters", "", "comma-separated reporters: cli, json, junit (default cli)")
	reporter := fs.String("reporter", "", "shorthand for a single reporter (cli, json, or junit)")
	fs.StringVar(&opts.reporterJSONExport, "reporter-json-export", "", "write the JSON report to this file")
	fs.StringVar(&opts.reporterJUnitExport, "reporter-junit-export", "", "write the JUnit report to this file")
	fs.StringVar(&opts.exportEnvironment, "export-environment", "", "write final environment variables to this file after the run")
	fs.StringVar(&opts.exportGlobals, "export-globals", "", "write final global variables to this file after the run")
	fs.StringVar(&opts.globalsFile, "globals", "", "KEY=VALUE or JSON file of global variables")
	fs.StringVar(&opts.envFile, "env-file", "", "KEY=VALUE file whose values override environment variables")
	fs.StringVar(&opts.dataFile, "data", "", "CSV or JSON data file; each row is one iteration")
	fs.IntVar(&opts.timeoutMs, "timeout", 0, "per-request timeout in milliseconds (overrides request settings)")
	fs.IntVar(&opts.scriptTimeoutMs, "script-timeout", 0, "per-script execution timeout in milliseconds (default 2000, max 60000)")
	fs.BoolVar(&opts.allowSendRequest, "allow-send-request", false, "allow pm.sendRequest to make HTTP calls from scripts")
	fs.IntVar(&opts.delayMs, "delay", 0, "delay in milliseconds between requests")
	fs.IntVar(&opts.iterations, "iterations", 1, "number of times to run the selected set (ignored when --data is set)")
	fs.BoolVar(&opts.failFast, "fail-fast", false, "stop at the first failing request")
	fs.BoolVar(&opts.failFast, "bail", false, "alias for --fail-fast")
	fs.BoolVar(&opts.insecure, "insecure", false, "disable TLS certificate verification for every request")
	fs.BoolVar(&opts.insecure, "k", false, "alias for --insecure")
	fs.BoolVar(&opts.verbose, "verbose", false, "print request and response detail for each request")
	var varFlags, globalVarFlags multiFlag
	fs.Var(&varFlags, "var", "override a variable as KEY=VALUE (repeatable)")
	fs.Var(&globalVarFlags, "global-var", "set a global variable as KEY=VALUE (repeatable)")

	fs.Usage = func() {
		fmt.Fprintln(stderr, "Usage: kurlo run [workspace] [flags]")
		fmt.Fprint(stderr, "\nRun a Kurlo YAML workspace's requests and their test scripts, for CI or the terminal.\n\n")
		fs.PrintDefaults()
	}

	positional := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		positional = args[0]
		args = args[1:]
	}
	if err := fs.Parse(args); err != nil {
		return opts, err
	}
	if positional != "" {
		opts.workspace = positional
	}

	if err := collectKeyValues(varFlags, opts.vars, "--var"); err != nil {
		return opts, err
	}
	if err := collectKeyValues(globalVarFlags, opts.globalVars, "--global-var"); err != nil {
		return opts, err
	}
	if *folder != "" {
		for _, seg := range strings.Split(*folder, "/") {
			if seg = strings.TrimSpace(seg); seg != "" {
				opts.folder = append(opts.folder, seg)
			}
		}
	}
	if opts.iterations < 1 {
		opts.iterations = 1
	}

	names := splitCSV(*reporters)
	if len(names) == 0 && *reporter != "" {
		names = []string{*reporter}
	}
	if opts.reporterJSONExport != "" && !containsString(names, "json") {
		names = append(names, "json")
	}
	if opts.reporterJUnitExport != "" && !containsString(names, "junit") {
		names = append(names, "junit")
	}
	if len(names) == 0 {
		names = []string{"cli"}
	}
	for _, name := range names {
		switch name {
		case "cli", "pretty", "json", "junit":
		default:
			return opts, fmt.Errorf("unknown reporter %q (use cli, json, or junit)", name)
		}
	}
	opts.reporters = names
	return opts, nil
}

func collectKeyValues(pairs []string, into map[string]string, flagName string) error {
	for _, pair := range pairs {
		key, value, ok := strings.Cut(pair, "=")
		if !ok {
			return fmt.Errorf("%s must be KEY=VALUE, got %q", flagName, pair)
		}
		into[strings.TrimSpace(key)] = value
	}
	return nil
}

func splitCSV(value string) []string {
	var out []string
	for _, part := range strings.Split(value, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func containsString(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}

type multiFlag []string

func (m *multiFlag) String() string { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error {
	*m = append(*m, v)
	return nil
}

func runCLI(opts cliOptions) int {
	_, collections, requests, environments, err := loadCLIWorkspace(opts.workspace)
	if err != nil {
		fmt.Fprintln(opts.stderr, "kurlo run:", err)
		return 2
	}

	globals, err := resolveGlobals(opts)
	if err != nil {
		fmt.Fprintln(opts.stderr, "kurlo run:", err)
		return 2
	}
	values, secretValues, err := resolveCLIValues(opts, collections, environments, globals)
	if err != nil {
		fmt.Fprintln(opts.stderr, "kurlo run:", err)
		return 2
	}

	var dataRows []map[string]string
	if opts.dataFile != "" {
		dataRows, err = loadDataFile(opts.dataFile)
		if err != nil {
			fmt.Fprintln(opts.stderr, "kurlo run:", err)
			return 2
		}
	}
	iterations := opts.iterations
	if len(dataRows) > 0 {
		iterations = len(dataRows)
	}
	opts.iterationCount = iterations

	selected := selectCLIRequests(requests, opts)
	if len(selected) == 0 {
		fmt.Fprintln(opts.stderr, "kurlo run: no runnable requests matched the selection")
		return 2
	}
	collectionsByID := make(map[string]*cliCollection, len(collections))
	for i := range collections {
		collectionsByID[collections[i].ID] = &collections[i]
	}
	for i := range selected {
		selected[i] = applyCollectionDefaults(selected[i], collectionsByID[selected[i].CollectionID])
	}

	sm := state.New()
	sm.SetEnvironment(values)
	jars := newCookieJarRegistry()
	cache := newPreflightCache()
	tokens := newOAuth2TokenCache()
	defer httpTransports.closeAll()

	results := make([]cliRunResult, 0, len(selected))
	start := time.Now()
	firstRequest := true

runLoop:
	for iteration := 1; iteration <= iterations; iteration++ {
		var dataRow map[string]string
		if len(dataRows) > 0 {
			dataRow = dataRows[iteration-1]
		}
		for _, req := range selected {
			if opts.delayMs > 0 && !firstRequest {
				time.Sleep(time.Duration(opts.delayMs) * time.Millisecond)
			}
			firstRequest = false

			result := runCLIRequest(sm, jars, cache, tokens, req, iteration, dataRow, opts, secretValues)
			results = append(results, result)
			if opts.verbose {
				printVerbose(opts.stdout, result)
			}
			if opts.failFast && result.failed() {
				break runLoop
			}
		}
	}

	elapsed := time.Since(start)
	if err := runReporters(opts, results, elapsed); err != nil {
		fmt.Fprintln(opts.stderr, "kurlo run:", err)
		return 2
	}
	if err := exportScopes(opts, sm, globals); err != nil {
		fmt.Fprintln(opts.stderr, "kurlo run:", err)
		return 2
	}

	for _, result := range results {
		if result.failed() {
			return 1
		}
	}
	return 0
}

func runCLIRequest(sm *state.Manager, jars *cookieJarRegistry, cache *preflightCache, tokens *oauth2TokenCache, req cliSavedRequest, iteration int, dataRow map[string]string, opts cliOptions, secretValues []string) cliRunResult {
	result, _ := executeCLIRequest(context.Background(), sm, jars, cache, tokens, req, iteration, dataRow, opts, secretValues)
	return result
}

func executeCLIRequest(ctx context.Context, sm *state.Manager, jars *cookieJarRegistry, cache *preflightCache, tokens *oauth2TokenCache, req cliSavedRequest, iteration int, dataRow map[string]string, opts cliOptions, secretValues []string) (cliRunResult, model.HttpResponse) {
	label := req.Name
	if label == "" {
		label = req.URL
	}
	base := cliRunResult{Name: label, Method: strings.ToUpper(req.Method), URL: req.URL, Iteration: iteration}

	values := sm.GetEnvironment()
	if len(dataRow) > 0 {
		merged := make(map[string]string, len(values)+len(dataRow))
		for k, v := range values {
			merged[k] = v
		}
		for k, v := range dataRow {
			merged[k] = v
		}
		values = merged
	}

	httpReq := buildHTTPRequest(req, values, secretValues, opts.timeoutMs)
	httpReq.IterationData = dataRow
	httpReq.Name = req.Name
	httpReq.Iteration = iteration
	httpReq.IterationCount = opts.iterationCount
	httpReq.ScriptTimeoutMs = req.Settings.ScriptTimeoutMs
	if opts.scriptTimeoutMs > 0 {
		httpReq.ScriptTimeoutMs = opts.scriptTimeoutMs
	}
	httpReq.AllowSendRequest = opts.allowSendRequest || req.Settings.AllowSendRequest
	if opts.insecure {
		httpReq.EnableSSLVerification = false
	}
	base.Method = httpReq.Method
	base.URL = resolveTemplateValue(httpReq.URL, values)

	resolvedAuth := resolveAuthTemplates(httpReq.Auth, values)
	if err := tokens.resolveOAuth2Token(&resolvedAuth); err != nil {
		base.Error = err.Error()
		return base, model.HttpResponse{}
	}
	httpReq.Auth.Token = resolvedAuth.Token
	base.secrets = []string{
		resolvedAuth.Token, resolvedAuth.Password, resolvedAuth.KeyValue,
		resolvedAuth.OAuth2Secret, resolvedAuth.OAuth2Password, resolvedAuth.OAuth2RefreshToken,
		resolvedAuth.OAuth2AssertionPrivateKey, resolvedAuth.OAuth1ConsumerSecret,
		resolvedAuth.OAuth1Token, resolvedAuth.OAuth1TokenSecret, resolvedAuth.OAuth1PrivateKey,
		resolvedAuth.AWSSecretKey, resolvedAuth.AWSSessionToken,
	}
	httpReq.SecretEnvironmentValues = append(httpReq.SecretEnvironmentValues, base.secrets...)

	resp := sendRequest(ctx, httpReq, sm, jars, cache)

	if resp.Skipped {
		base.Skipped = true
		base.SkipReason = resp.SkipReason
		return base, resp
	}

	base.StatusCode = resp.StatusCode
	base.DurationMs = resp.Duration
	base.Size = resp.Size
	base.ContentType = headerLookup(resp.Headers, "Content-Type")

	scriptErr := resp.PreRequestResult.Error
	if scriptErr == "" {
		scriptErr = resp.TestResult.Error
	}
	if resp.Error != "" {
		base.Error = resp.Error
	} else if scriptErr != "" {
		base.Error = scriptErr
	}

	for _, test := range resp.TestResult.Tests {
		base.Tests = append(base.Tests, cliTestResult{Name: test.Name, Passed: test.Passed, Error: test.Error})
		base.TestsTotal++
		if test.Passed {
			base.TestsPassed++
		}
	}
	return base, resp
}

func headerLookup(headers []model.KeyValue, key string) string {
	for _, h := range headers {
		if strings.EqualFold(h.Key, key) {
			return h.Value
		}
	}
	return ""
}

func selectCLIRequests(requests []cliSavedRequest, opts cliOptions) []cliSavedRequest {
	return selectRequestsForRun(requests, opts, cliRunnable)
}

func selectRequestsForRun(requests []cliSavedRequest, opts cliOptions, runnable func(cliSavedRequest) bool) []cliSavedRequest {
	selected := make([]cliSavedRequest, 0, len(requests))
	for _, req := range requests {
		if !runnable(req) {
			continue
		}
		if opts.collection != "" && !strings.EqualFold(strings.TrimSpace(req.Collection), strings.TrimSpace(opts.collection)) {
			continue
		}
		if !folderPrefixMatches(req.FolderPath, opts.folder) {
			continue
		}
		selected = append(selected, req)
	}
	return selected
}

func folderPrefixMatches(path, prefix []string) bool {
	if len(prefix) == 0 {
		return true
	}
	if len(path) < len(prefix) {
		return false
	}
	for i, seg := range prefix {
		if !strings.EqualFold(strings.TrimSpace(path[i]), seg) {
			return false
		}
	}
	return true
}

func resolveCLIValues(opts cliOptions, collections []cliCollection, environments []cliEnvironment, globals map[string]string) (map[string]string, []string, error) {
	values := map[string]string{}
	for key, value := range globals {
		values[key] = value
	}
	for _, collection := range collections {
		for key, value := range enabledRowValues(collection.Defaults.Variables) {
			values[key] = value
		}
	}

	var secretValues []string
	if opts.env != "" {
		env, ok := findEnvironment(environments, opts.env)
		if !ok {
			return nil, nil, fmt.Errorf("environment %q not found (available: %s)", opts.env, environmentNames(environments))
		}
		for _, row := range env.Values {
			if row.Enabled && strings.TrimSpace(row.Key) != "" {
				values[strings.TrimSpace(row.Key)] = row.Value
				if row.Secret && row.Value != "" {
					secretValues = append(secretValues, row.Value)
				}
			}
		}
	}

	if opts.envFile != "" {
		fileValues, err := readEnvFile(opts.envFile)
		if err != nil {
			return nil, nil, err
		}
		for key, value := range fileValues {
			values[key] = value
		}
	}
	for key, value := range opts.vars {
		values[key] = value
	}
	return values, secretValues, nil
}

func resolveGlobals(opts cliOptions) (map[string]string, error) {
	globals := map[string]string{}
	if opts.globalsFile != "" {
		fileValues, err := readVariableFile(opts.globalsFile)
		if err != nil {
			return nil, fmt.Errorf("globals: %w", err)
		}
		for key, value := range fileValues {
			globals[key] = value
		}
	}
	for key, value := range opts.globalVars {
		globals[key] = value
	}
	return globals, nil
}

func findEnvironment(environments []cliEnvironment, name string) (cliEnvironment, bool) {
	for _, env := range environments {
		if strings.EqualFold(strings.TrimSpace(env.Name), strings.TrimSpace(name)) {
			return env, true
		}
	}
	return cliEnvironment{}, false
}

func environmentNames(environments []cliEnvironment) string {
	names := make([]string, 0, len(environments))
	for _, env := range environments {
		names = append(names, env.Name)
	}
	sort.Strings(names)
	if len(names) == 0 {
		return "none"
	}
	return strings.Join(names, ", ")
}

func readEnvFile(path string) (map[string]string, error) {
	values, err := readVariableFile(path)
	if err != nil {
		return nil, fmt.Errorf("env file: %w", err)
	}
	return values, nil
}

func readVariableFile(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(string(data))
	values := map[string]string{}
	if strings.HasPrefix(trimmed, "{") {
		var doc struct {
			Values []struct {
				Key     string `json:"key"`
				Value   string `json:"value"`
				Enabled *bool  `json:"enabled"`
			} `json:"values"`
			Extra map[string]any `json:"-"`
		}
		if err := json.Unmarshal([]byte(trimmed), &doc); err == nil && len(doc.Values) > 0 {
			for _, row := range doc.Values {
				if row.Enabled != nil && !*row.Enabled {
					continue
				}
				if key := strings.TrimSpace(row.Key); key != "" {
					values[key] = row.Value
				}
			}
			return values, nil
		}
		var flat map[string]any
		if err := json.Unmarshal([]byte(trimmed), &flat); err != nil {
			return nil, fmt.Errorf("not valid JSON")
		}
		for key, value := range flat {
			values[strings.TrimSpace(key)] = jsonCellToString(value)
		}
		return values, nil
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		values[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), `"'`)
	}
	return values, nil
}

func loadCLIWorkspace(root string) ([]map[string]any, []cliCollection, []cliSavedRequest, []cliEnvironment, error) {
	return loadCLIWorkspaceWithSecrets(root, map[string]string{})
}

func loadCLIWorkspaceWithSecrets(root string, secrets map[string]string) ([]map[string]any, []cliCollection, []cliSavedRequest, []cliEnvironment, error) {
	if !hasYAMLWorkspaceStore(root) {
		return nil, nil, nil, nil, fmt.Errorf("%q is not a Kurlo YAML workspace (no kurlo.yml found)", root)
	}
	workspaces, collectionMaps, requestMaps, environmentMaps, _, diagnostics, err := loadFilesystemWorkspaceStoreWithDiagnostics(root, secrets)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	if len(diagnostics) > 0 {
		return nil, nil, nil, nil, workspaceDiagnosticsError(diagnostics)
	}
	collections, err := decodeMaps[cliCollection](collectionMaps)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	requests, err := decodeMaps[cliSavedRequest](requestMaps)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	environments, err := decodeMaps[cliEnvironment](environmentMaps)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	return workspaces, collections, requests, flattenCLIEnvironments(environments), nil
}

func exportScopes(opts cliOptions, sm *state.Manager, globals map[string]string) error {
	if opts.exportEnvironment != "" {
		if err := writeVariableExport(opts.exportEnvironment, opts.env, sm.GetEnvironment()); err != nil {
			return fmt.Errorf("export environment: %w", err)
		}
	}
	if opts.exportGlobals != "" {
		if err := writeVariableExport(opts.exportGlobals, "Globals", globals); err != nil {
			return fmt.Errorf("export globals: %w", err)
		}
	}
	return nil
}

func writeVariableExport(path, name string, values map[string]string) error {
	type exportValue struct {
		Key     string `json:"key"`
		Value   string `json:"value"`
		Enabled bool   `json:"enabled"`
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	rows := make([]exportValue, 0, len(keys))
	for _, key := range keys {
		rows = append(rows, exportValue{Key: key, Value: values[key], Enabled: true})
	}
	doc := map[string]any{"name": name, "values": rows}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return replaceFileAtomicMode(path, append(data, '\n'), 0o600)
}

func runReporters(opts cliOptions, results []cliRunResult, elapsed time.Duration) error {
	for _, name := range opts.reporters {
		switch name {
		case "cli", "pretty":
			reportPretty(opts.stdout, results, elapsed)
		case "json":
			if err := writeOrPrint(opts.stdout, opts.reporterJSONExport, func(w io.Writer) { reportJSON(w, results, elapsed) }); err != nil {
				return err
			}
		case "junit":
			if err := writeOrPrint(opts.stdout, opts.reporterJUnitExport, func(w io.Writer) { reportJUnit(w, results, elapsed) }); err != nil {
				return err
			}
		}
	}
	return nil
}

func writeOrPrint(stdout io.Writer, path string, render func(io.Writer)) error {
	if path == "" {
		render(stdout)
		return nil
	}
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()
	render(file)
	return nil
}

type cliSummary struct {
	requests    int
	passed      int
	failed      int
	assertions  int
	assertPass  int
	totalDataKB float64
	avgMs       float64
}

func summarize(results []cliRunResult) cliSummary {
	var s cliSummary
	var totalMs int64
	var counted int
	for _, r := range results {
		if r.Skipped {
			continue
		}
		s.requests++
		counted++
		totalMs += r.DurationMs
		s.assertions += r.TestsTotal
		s.assertPass += r.TestsPassed
		s.totalDataKB += float64(r.Size) / 1024
		if r.failed() {
			s.failed++
		} else {
			s.passed++
		}
	}
	if counted > 0 {
		s.avgMs = float64(totalMs) / float64(counted)
	}
	return s
}

func printVerbose(w io.Writer, r cliRunResult) {
	fmt.Fprintf(w, "→ %s %s\n", r.Method, r.URL)
	if r.Error != "" {
		fmt.Fprintf(w, "  ✗ %s\n", r.Error)
		return
	}
	ct := r.ContentType
	if ct == "" {
		ct = "—"
	}
	fmt.Fprintf(w, "  ← %d  %dms  %s  %s\n", r.StatusCode, r.DurationMs, humanSize(r.Size), ct)
}

func reportPretty(w io.Writer, results []cliRunResult, elapsed time.Duration) {
	for _, r := range results {
		mark := "✓"
		if r.failed() {
			mark = "✗"
		}
		suffix := ""
		if r.TestsTotal > 0 {
			suffix = fmt.Sprintf("  [%d/%d tests]", r.TestsPassed, r.TestsTotal)
		}
		fmt.Fprintf(w, "%s %s %s → %d  %dms%s\n", mark, r.Method, r.URL, r.StatusCode, r.DurationMs, suffix)
		if r.Error != "" {
			fmt.Fprintf(w, "    error: %s\n", r.Error)
		}
		for _, test := range r.Tests {
			if !test.Passed {
				fmt.Fprintf(w, "    ✗ %s%s\n", test.Name, testDetail(test.Error))
			}
		}
	}

	s := summarize(results)
	fmt.Fprintf(w, "\n%d requests, %d passed, %d failed · %d/%d assertions · avg %.0fms · %s received · %s\n",
		s.requests, s.passed, s.failed, s.assertPass, s.assertions,
		s.avgMs, humanSizeKB(s.totalDataKB), elapsed.Round(time.Millisecond))

	if s.failed > 0 {
		fmt.Fprintln(w, "\nFailures:")
		index := 1
		for _, r := range results {
			if !r.failed() {
				continue
			}
			reason := r.Error
			if reason == "" {
				var names []string
				for _, test := range r.Tests {
					if !test.Passed {
						names = append(names, test.Name+testDetail(test.Error))
					}
				}
				reason = strings.Join(names, "; ")
			}
			iter := ""
			if r.Iteration > 1 {
				iter = fmt.Sprintf(" (iteration %d)", r.Iteration)
			}
			fmt.Fprintf(w, "  %d. %s %s%s\n     %s\n", index, r.Method, r.URL, iter, reason)
			index++
		}
	}
}

func testDetail(err string) string {
	if err == "" {
		return ""
	}
	return " — " + err
}

func humanSize(bytes int64) string {
	return humanSizeKB(float64(bytes) / 1024)
}

func humanSizeKB(kb float64) string {
	if kb >= 1024 {
		return fmt.Sprintf("%.1f MB", kb/1024)
	}
	if kb >= 1 {
		return fmt.Sprintf("%.1f KB", kb)
	}
	return fmt.Sprintf("%.0f B", kb*1024)
}

func reportJSON(w io.Writer, results []cliRunResult, elapsed time.Duration) {
	s := summarize(results)
	payload := map[string]any{
		"summary": map[string]any{
			"requests":       s.requests,
			"passed":         s.passed,
			"failed":         s.failed,
			"assertions":     s.assertions,
			"assertionsPass": s.assertPass,
			"avgResponseMs":  s.avgMs,
			"dataReceivedKB": s.totalDataKB,
			"durationMs":     elapsed.Milliseconds(),
			"ok":             s.failed == 0,
		},
		"results": results,
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(payload)
}

type junitTestCase struct {
	XMLName   xml.Name `xml:"testcase"`
	Name      string   `xml:"name,attr"`
	ClassName string   `xml:"classname,attr"`
	Time      string   `xml:"time,attr"`
	Failure   *struct {
		Message string `xml:"message,attr"`
		Text    string `xml:",chardata"`
	} `xml:"failure,omitempty"`
}

type junitSuite struct {
	XMLName   xml.Name        `xml:"testsuite"`
	Name      string          `xml:"name,attr"`
	Tests     int             `xml:"tests,attr"`
	Failures  int             `xml:"failures,attr"`
	Time      string          `xml:"time,attr"`
	TestCases []junitTestCase `xml:"testcase"`
}

func reportJUnit(w io.Writer, results []cliRunResult, elapsed time.Duration) {
	suite := junitSuite{Name: "kurlo", Time: fmt.Sprintf("%.3f", elapsed.Seconds())}
	for _, r := range results {
		if r.Skipped {
			continue
		}
		suite.Tests++
		tc := junitTestCase{
			Name:      fmt.Sprintf("%s %s", r.Method, r.URL),
			ClassName: r.Name,
			Time:      fmt.Sprintf("%.3f", float64(r.DurationMs)/1000),
		}
		if r.failed() {
			suite.Failures++
			message := r.Error
			if message == "" {
				var failedTests []string
				for _, test := range r.Tests {
					if !test.Passed {
						failedTests = append(failedTests, test.Name+testDetail(test.Error))
					}
				}
				message = strings.Join(failedTests, "; ")
			}
			tc.Failure = &struct {
				Message string `xml:"message,attr"`
				Text    string `xml:",chardata"`
			}{Message: message, Text: message}
		}
		suite.TestCases = append(suite.TestCases, tc)
	}
	fmt.Fprintln(w, xml.Header+`<testsuites>`)
	enc := xml.NewEncoder(w)
	enc.Indent("  ", "  ")
	_ = enc.Encode(suite)
	fmt.Fprint(w, "\n</testsuites>\n")
}
