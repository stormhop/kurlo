package api

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"text/tabwriter"

	"github.com/stormhop/kurlo/apps/desktop/internal/loadtest"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const loadCLIUsage = `Usage:
  kurlo load list [--workspace .] [--collection NAME]
  kurlo load export <test> [--workspace .] [--collection NAME] [-o file.k6.js | --dir out/] [--inline-secrets]
  kurlo load run <test> [--workspace .] [--collection NAME] [--env NAME] [--env-file FILE] [--k6 PATH]
                       [--json summary.json] [--report report.html]

<test> is a load-test name, ID or YAML path inside the workspace.
Export writes the script to stdout unless -o or --dir is supplied.
Use a subcommand with --help for its flags. k6 is required only for run.
`

type loadCLIOptions struct {
	command, test, workspace, collection string
	environment, envFile, globalsFile    string
	output, dir, k6, summary, report     string
	inlineSecrets                        bool
	vars, globalVars                     map[string]string
}

type cliLoadTest struct {
	collection cliCollection
	test       model.LoadTest
	path       string
}

func RunLoadCLI(args []string, stdout, stderr io.Writer) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runLoadCLI(ctx, args, stdout, stderr)
}

func parseLoadCLIArgs(args []string, stderr io.Writer) (loadCLIOptions, error) {
	opts := loadCLIOptions{workspace: ".", vars: map[string]string{}, globalVars: map[string]string{}}
	if len(args) == 0 {
		fmt.Fprint(stderr, loadCLIUsage)
		return opts, fmt.Errorf("a load subcommand is required")
	}
	if args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprint(stderr, loadCLIUsage)
		return opts, flag.ErrHelp
	}
	opts.command = args[0]
	if opts.command != "list" && opts.command != "export" && opts.command != "run" {
		return opts, fmt.Errorf("unknown load subcommand %q (use list, export or run)", opts.command)
	}
	fs := flag.NewFlagSet("kurlo load "+opts.command, flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&opts.workspace, "workspace", ".", "directory containing kurlo.yml")
	fs.StringVar(&opts.collection, "collection", "", "collection name or ID")
	if opts.command != "list" {
		fs.StringVar(&opts.environment, "env", "", "environment name (defaults to the test's saved environment)")
		fs.StringVar(&opts.envFile, "env-file", "", "KEY=VALUE or JSON file; values stay external unless --inline-secrets is used")
		fs.StringVar(&opts.globalsFile, "globals", "", "KEY=VALUE or JSON file of global defaults")
	}
	var vars, globals multiFlag
	if opts.command != "list" {
		fs.Var(&vars, "var", "override KEY=VALUE (repeatable)")
		fs.Var(&globals, "global-var", "set global KEY=VALUE (repeatable)")
	}
	if opts.command == "export" {
		fs.StringVar(&opts.output, "o", "", "write a self-contained script to this file")
		fs.StringVar(&opts.dir, "dir", "", "create this directory with script.k6.js and optional data.json")
		fs.BoolVar(&opts.inlineSecrets, "inline-secrets", false, "write secret values into exported files")
	}
	if opts.command == "run" {
		fs.StringVar(&opts.k6, "k6", "", "path to k6 (defaults to PATH)")
		fs.StringVar(&opts.summary, "json", "", "save the raw k6 summary JSON")
		fs.StringVar(&opts.report, "report", "", "save the k6 web dashboard HTML report")
	}
	fs.Usage = func() {
		fmt.Fprint(stderr, loadCLIUsage, "\nFlags for ", opts.command, ":\n")
		fs.PrintDefaults()
	}
	var flags, positional []string
	for index := 1; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			positional = append(positional, args[index+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			positional = append(positional, arg)
			continue
		}
		flags = append(flags, arg)
		name, _, assigned := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		if option := fs.Lookup(name); option != nil && !assigned {
			boolean, ok := option.Value.(interface{ IsBoolFlag() bool })
			if !ok || !boolean.IsBoolFlag() {
				if index+1 < len(args) {
					index++
					flags = append(flags, args[index])
				}
			}
		}
	}
	if err := fs.Parse(flags); err != nil {
		return opts, err
	}
	if opts.command == "list" && len(positional) != 0 {
		return opts, fmt.Errorf("list expects no test argument")
	}
	if opts.command != "list" && (len(positional) != 1 || strings.TrimSpace(positional[0]) == "") {
		return opts, fmt.Errorf("%s expects exactly one test name, ID or YAML path", opts.command)
	}
	if len(positional) > 0 {
		opts.test = positional[0]
	}
	if opts.output != "" && opts.dir != "" {
		return opts, fmt.Errorf("-o and --dir cannot be combined")
	}
	if err := collectKeyValues(vars, opts.vars, "--var"); err != nil {
		return opts, err
	}
	if err := collectKeyValues(globals, opts.globalVars, "--global-var"); err != nil {
		return opts, err
	}
	if opts.summary != "" && opts.report != "" {
		a, _ := filepath.Abs(opts.summary)
		b, _ := filepath.Abs(opts.report)
		if a == b {
			return opts, fmt.Errorf("--json and --report must use different paths")
		}
	}
	return opts, nil
}

func runLoadCLI(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	opts, err := parseLoadCLIArgs(args, stderr)
	if err == flag.ErrHelp {
		return 0
	}
	if err != nil {
		fmt.Fprintln(stderr, "kurlo load:", err)
		return 2
	}
	fail := func(err error) int {
		fmt.Fprintln(stderr, "kurlo load:", err)
		return 1
	}
	root, err := filepath.Abs(opts.workspace)
	if err != nil {
		return fail(err)
	}
	workspaces, collections, requests, environments, err := loadCLIWorkspace(root)
	if err != nil {
		return fail(err)
	}
	entries := loadCLIEntries(root, workspaces, collections, opts.collection)
	if opts.command == "list" {
		if opts.collection != "" && len(entries) == 0 {
			found := false
			for _, collection := range collections {
				found = found || loadCLICollectionMatches(collection, opts.collection)
			}
			if !found {
				return fail(fmt.Errorf("collection %q not found", opts.collection))
			}
		}
		writer := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(writer, "COLLECTION\tTEST\tID\tPATH")
		for _, entry := range entries {
			path, _ := filepath.Rel(root, entry.path)
			fmt.Fprintf(writer, "%s\t%s\t%s\t%s\n", entry.collection.Name, entry.test.Name, entry.test.ID, filepath.ToSlash(path))
		}
		if err := writer.Flush(); err != nil {
			return fail(err)
		}
		return 0
	}
	entry, err := selectCLILoadTest(root, opts.test, entries)
	if err != nil {
		return fail(err)
	}
	plan, err := buildCLILoadPlan(root, opts, entry, requests, environments)
	if err != nil {
		return fail(err)
	}
	result := loadtest.GenerateK6(plan, loadtest.Options{InlineSecrets: opts.inlineSecrets, SeparateData: opts.dir != ""})
	for _, warning := range result.Warnings {
		fmt.Fprintf(stderr, "%s: %s\n", warning.Level, warning.Message)
	}
	if opts.command == "run" {
		return runCLILoadTest(ctx, opts, plan, result, stdout, stderr)
	}
	if opts.inlineSecrets {
		fmt.Fprintln(stderr, "Secret values are included in the exported files. Do not commit or share them.")
	}
	switch {
	case opts.dir != "":
		dir, err := filepath.Abs(opts.dir)
		if err != nil {
			return fail(err)
		}
		if err := os.MkdirAll(filepath.Dir(dir), 0755); err != nil {
			return fail(err)
		}
		if err := writeLoadTestFolder(filepath.Dir(dir), filepath.Base(dir), result.Files); err != nil {
			return fail(err)
		}
		fmt.Fprintln(stderr, "Exported", dir)
	case opts.output != "" && opts.output != "-":
		if err := writeFileAtomic(opts.output, []byte(result.Script)); err != nil {
			return fail(err)
		}
		fmt.Fprintln(stderr, "Exported", opts.output)
	default:
		if _, err := io.WriteString(stdout, result.Script); err != nil {
			return fail(err)
		}
	}
	return 0
}

func loadCLICollectionMatches(collection cliCollection, selector string) bool {
	return collection.ID == selector || strings.EqualFold(collection.Name, selector)
}

func loadCLIEntries(root string, workspaces []map[string]any, collections []cliCollection, filter string) []cliLoadTest {
	workspaceNames := map[string]string{}
	for _, workspace := range workspaces {
		workspaceNames[stringValue(workspace, "id")] = stringValue(workspace, "filesystemName")
	}
	var entries []cliLoadTest
	for _, collection := range collections {
		if filter != "" && !loadCLICollectionMatches(collection, filter) {
			continue
		}
		for _, test := range collection.LoadTests {
			path := filepath.Join(root, fileStoreWorkspacesDir, workspaceNames[collection.WorkspaceID], fileStoreCollectionsDir, collection.FilesystemName, fileStoreLoadTestsDir, test.FilesystemName+fileStoreYAMLExt)
			entries = append(entries, cliLoadTest{collection: collection, test: test, path: path})
		}
	}
	return entries
}

func selectCLILoadTest(root, selector string, entries []cliLoadTest) (cliLoadTest, error) {
	abs, _ := filepath.Abs(selector)
	var matches []cliLoadTest
	for _, entry := range entries {
		if entry.test.ID == selector || strings.EqualFold(entry.test.Name, selector) || entry.path == abs || entry.path == filepath.Join(root, selector) {
			matches = append(matches, entry)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) > 1 {
		return cliLoadTest{}, fmt.Errorf("load test %q is ambiguous; use --collection, a unique ID or a YAML path", selector)
	}
	return cliLoadTest{}, fmt.Errorf("load test %q not found; use kurlo load list --workspace %q", selector, root)
}

func buildCLILoadPlan(root string, opts loadCLIOptions, entry cliLoadTest, requests []cliSavedRequest, environments []cliEnvironment) (loadtest.Plan, error) {
	payload := loadTestPayload{LoadTest: entry.test, Collection: entry.collection}
	var targets []model.LoadTestRequest
	for _, request := range requests {
		if request.CollectionID == entry.collection.ID && !request.IsDraft {
			payload.Requests = append(payload.Requests, request)
			targets = append(targets, model.LoadTestRequest{ID: request.ID, RequestType: loadTestRequest(request, &entry.collection).Type})
		}
	}
	if problems := loadtest.Validate(entry.test, targets); len(problems) > 0 {
		return loadtest.Plan{}, fmt.Errorf("invalid load test: %s", strings.Join(problems, "; "))
	}
	environment := opts.environment
	if environment == "" {
		environment = entry.test.Settings.Environment
	}
	if environment != "" {
		var matches []cliEnvironment
		for _, candidate := range environments {
			if candidate.WorkspaceID == entry.collection.WorkspaceID && strings.EqualFold(candidate.Name, environment) {
				matches = append(matches, candidate)
			}
		}
		if len(matches) != 1 {
			return loadtest.Plan{}, fmt.Errorf("environment %q must identify exactly one environment in the collection's workspace", environment)
		}
		payload.Environment = &matches[0]
		payload.LoadTest.Settings.Environment = matches[0].Name
	}
	globals, err := resolveGlobals(cliOptions{globalsFile: opts.globalsFile, globalVars: opts.globalVars})
	if err != nil {
		return loadtest.Plan{}, err
	}
	for key, value := range globals {
		payload.Globals = append(payload.Globals, cliKV{Key: key, Value: value, Enabled: true})
	}
	plan := loadtest.Plan{Test: payload.LoadTest, Collection: entry.collection.Name, Requests: map[string]loadtest.Request{}, Variables: loadTestVariables(payload)}
	for _, request := range payload.Requests {
		plan.Requests[request.ID] = loadTestRequest(request, &entry.collection)
	}
	variables := map[string]loadtest.Variable{}
	for _, variable := range plan.Variables {
		if value, ok := os.LookupEnv(variable.Name); ok {
			variable.Value, variable.Secret = value, true
		}
		variables[variable.Name] = variable
	}
	if opts.envFile != "" {
		values, err := readEnvFile(opts.envFile)
		if err != nil {
			return plan, err
		}
		for name, value := range values {
			variables[name] = loadtest.Variable{Name: name, Value: value, Secret: true}
		}
	}
	for name, value := range opts.vars {
		variable := variables[name]
		variable.Name, variable.Value = name, value
		variables[name] = variable
	}
	plan.Variables = nil
	names := make([]string, 0, len(variables))
	for name := range variables {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		variable := variables[name]
		if name == "" || strings.ContainsAny(name, "=\x00") || strings.ContainsRune(variable.Value, '\x00') {
			return plan, fmt.Errorf("variable %q cannot be passed to k6; names must be nonempty without '=' and names and values cannot contain NUL bytes", name)
		}
		plan.Variables = append(plan.Variables, variable)
	}
	if data := plan.Test.Data; data != nil {
		plan.Data, plan.DataError = loadTestData(root, data.Path)
		if plan.DataError != "" {
			return plan, fmt.Errorf("test data: %s", plan.DataError)
		}
	}
	return plan, nil
}
