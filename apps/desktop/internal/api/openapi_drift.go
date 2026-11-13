package api

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

const openAPIDriftFetchLimit = 32 << 20

type cliOpenAPISource struct {
	Source              string   `json:"source"`
	Headers             []cliKV  `json:"headers"`
	IntervalMinutes     int      `json:"intervalMinutes"`
	SkipTLSVerification bool     `json:"skipTlsVerification"`
	Ignored             []string `json:"ignored"`
}

type openAPIOperationInfo struct {
	operationID string
	fingerprint string
}

type openAPIDriftChange struct {
	Operation string `json:"operation"`
	From      string `json:"from,omitempty"`
}

type openAPIDriftReport struct {
	Collection string               `json:"collection"`
	Source     string               `json:"source"`
	InSync     bool                 `json:"inSync"`
	Added      []openAPIDriftChange `json:"added"`
	Removed    []openAPIDriftChange `json:"removed"`
	Changed    []openAPIDriftChange `json:"changed"`
	Moved      []openAPIDriftChange `json:"moved"`
	Unlinked   []string             `json:"unlinkedRequests,omitempty"`
}

func openAPIOperationKey(method, path string) string {
	return strings.ToUpper(method) + " " + path
}

func parseOpenAPIDocumentText(content string) (map[string]any, error) {
	content = strings.TrimPrefix(strings.TrimSpace(content), "\ufeff")
	if content == "" {
		return nil, errors.New("the spec is empty")
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(content), &doc); err != nil {
		var raw any
		if yamlErr := yaml.Unmarshal([]byte(content), &raw); yamlErr != nil {
			return nil, errors.New("could not read the spec as JSON or YAML")
		}
		doc, _ = normalizeImportYAML(raw).(map[string]any)
	}
	if doc == nil || (doc["openapi"] == nil && doc["swagger"] == nil) {
		return nil, errors.New(`the document has no "openapi" or "swagger" version field`)
	}
	return doc, nil
}

func openAPIResolveDeep(doc map[string]any, value any, stack map[string]bool, depth int) any {
	if depth > 48 {
		return nil
	}
	switch node := value.(type) {
	case map[string]any:
		if ref, ok := node["$ref"].(string); ok && strings.HasPrefix(ref, "#/") {
			if stack[ref] {
				return map[string]any{"$ref": ref}
			}
			target := openAPIObject(doc, map[string]any{"$ref": ref})
			if target == nil {
				return map[string]any{"$ref": ref}
			}
			stack[ref] = true
			resolved := openAPIResolveDeep(doc, target, stack, depth+1)
			delete(stack, ref)
			return resolved
		}
		out := make(map[string]any, len(node))
		for key, child := range node {
			if strings.HasPrefix(key, "x-") {
				continue
			}
			out[key] = openAPIResolveDeep(doc, child, stack, depth+1)
		}
		return out
	case []any:
		out := make([]any, len(node))
		for i, child := range node {
			out[i] = openAPIResolveDeep(doc, child, stack, depth+1)
		}
		return out
	default:
		return value
	}
}

func openAPIOperationsOf(doc map[string]any) map[string]openAPIOperationInfo {
	operations := map[string]openAPIOperationInfo{}
	paths := nestedMap(doc, "paths")
	for _, path := range sortedKeysAny(paths) {
		item := openAPIObject(doc, paths[path])
		if item == nil {
			continue
		}
		for _, verb := range importMethods {
			operation := openAPIObject(doc, item[verb])
			if operation == nil {
				continue
			}
			parameters := map[string]any{}
			for _, raw := range append(append([]any{}, importArray(item["parameters"])...), importArray(operation["parameters"])...) {
				param := openAPIObject(doc, raw)
				if param == nil {
					continue
				}
				parameters[stringValue(param, "in")+" "+stringValue(param, "name")] = openAPIResolveDeep(doc, param, map[string]bool{}, 0)
			}
			shape := map[string]any{
				"parameters":  parameters,
				"requestBody": openAPIResolveDeep(doc, operation["requestBody"], map[string]bool{}, 0),
				"responses":   openAPIResolveDeep(doc, operation["responses"], map[string]bool{}, 0),
				"security":    operation["security"],
				"description": operation["description"],
				"consumes":    operation["consumes"],
			}
			data, _ := json.Marshal(shape)
			operations[openAPIOperationKey(verb, path)] = openAPIOperationInfo{operationID: stringValue(operation, "operationId"), fingerprint: string(data)}
		}
	}
	return operations
}

func compareOpenAPIDocuments(base, next map[string]any) openAPIDriftReport {
	before := openAPIOperationsOf(base)
	after := openAPIOperationsOf(next)
	report := openAPIDriftReport{Added: []openAPIDriftChange{}, Removed: []openAPIDriftChange{}, Changed: []openAPIDriftChange{}, Moved: []openAPIDriftChange{}}
	byID := map[string]string{}
	for key, info := range after {
		if info.operationID != "" {
			byID[info.operationID] = key
		}
	}
	claimed := map[string]bool{}
	for _, key := range sortedOperationKeys(before) {
		info := before[key]
		if next, ok := after[key]; ok {
			claimed[key] = true
			if next.fingerprint != info.fingerprint {
				report.Changed = append(report.Changed, openAPIDriftChange{Operation: key})
			}
			continue
		}
		_, targetExisted := before[byID[info.operationID]]
		if target, ok := byID[info.operationID]; ok && info.operationID != "" && !targetExisted && !claimed[target] {
			claimed[target] = true
			report.Moved = append(report.Moved, openAPIDriftChange{Operation: target, From: key})
			continue
		}
		report.Removed = append(report.Removed, openAPIDriftChange{Operation: key})
	}
	for _, key := range sortedOperationKeys(after) {
		if _, existed := before[key]; !existed && !claimed[key] {
			report.Added = append(report.Added, openAPIDriftChange{Operation: key})
		}
	}
	baseServers, _ := json.Marshal(openAPIResolveDeep(base, base["servers"], map[string]bool{}, 0))
	nextServers, _ := json.Marshal(openAPIResolveDeep(next, next["servers"], map[string]bool{}, 0))
	if string(baseServers) != string(nextServers) || stringValue(base, "host") != stringValue(next, "host") || stringValue(base, "basePath") != stringValue(next, "basePath") {
		report.Changed = append(report.Changed, openAPIDriftChange{Operation: "servers"})
	}
	report.InSync = len(report.Added)+len(report.Removed)+len(report.Changed)+len(report.Moved) == 0
	return report
}

func sortedOperationKeys(operations map[string]openAPIOperationInfo) []string {
	keys := make([]string, 0, len(operations))
	for key := range operations {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

type openAPICheckOptions struct {
	workspace  string
	collection string
	specPath   string
	values     map[string]string
	insecure   bool
	client     *http.Client
}

func findOpenAPICollection(collections []cliCollection, name string) (cliCollection, error) {
	var synced []string
	for _, collection := range collections {
		if collection.OpenAPI != nil && strings.TrimSpace(collection.OpenAPI.Source) != "" {
			synced = append(synced, collection.Name)
		}
	}
	for _, collection := range collections {
		if collection.Name == name || collection.ID == name {
			if collection.OpenAPI == nil || strings.TrimSpace(collection.OpenAPI.Source) == "" {
				return cliCollection{}, fmt.Errorf("collection %q has no OpenAPI source; connect one in Kurlo first", collection.Name)
			}
			return collection, nil
		}
	}
	if name == "" && len(synced) == 1 {
		for _, collection := range collections {
			if collection.Name == synced[0] {
				return collection, nil
			}
		}
	}
	if len(synced) == 0 {
		return cliCollection{}, errors.New("no collection in this workspace is connected to an OpenAPI source")
	}
	sort.Strings(synced)
	if name == "" {
		return cliCollection{}, fmt.Errorf("name the collection to check (synced collections: %s)", strings.Join(synced, ", "))
	}
	return cliCollection{}, fmt.Errorf("collection %q not found (synced collections: %s)", name, strings.Join(synced, ", "))
}

func fetchOpenAPISource(ctx context.Context, root string, source *cliOpenAPISource, values map[string]string, insecure bool, client *http.Client) (string, string, error) {
	resolved := strings.TrimSpace(substituteTemplates(source.Source, values))
	if strings.Contains(resolved, "{{") {
		return "", resolved, fmt.Errorf("the spec source %q uses a variable that is not set; pass it with --var or --env", source.Source)
	}
	parsed, err := url.Parse(resolved)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		file := readOpenAPISourceFile(root, resolved)
		if file.Error != "" {
			return "", resolved, errors.New(file.Error)
		}
		return file.Content, file.Path, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, resolved, nil)
	if err != nil {
		return "", resolved, err
	}
	req.Header.Set("Accept", "application/json, application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.8")
	for _, row := range source.Headers {
		if !row.Enabled || strings.TrimSpace(row.Key) == "" {
			continue
		}
		req.Header.Set(substituteTemplates(row.Key, values), substituteTemplates(row.Value, values))
	}
	if client == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		if insecure || source.SkipTLSVerification {
			transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
		}
		client = &http.Client{Timeout: 30 * time.Second, Transport: transport}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", resolved, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, openAPIDriftFetchLimit+1))
	if err != nil {
		return "", resolved, err
	}
	if len(data) > openAPIDriftFetchLimit {
		return "", resolved, fmt.Errorf("the spec is larger than %d MB", openAPIDriftFetchLimit>>20)
	}
	if resp.StatusCode >= 400 {
		return "", resolved, fmt.Errorf("the spec URL answered %s", resp.Status)
	}
	return string(data), resolved, nil
}

func checkOpenAPIDrift(ctx context.Context, opts openAPICheckOptions) (openAPIDriftReport, error) {
	root := opts.workspace
	_, collections, requests, _, err := loadCLIWorkspace(root)
	if err != nil {
		return openAPIDriftReport{}, err
	}
	collection, err := findOpenAPICollection(collections, opts.collection)
	if err != nil {
		return openAPIDriftReport{}, err
	}
	values := enabledRowValues(collection.Defaults.Variables)
	for key, value := range opts.values {
		values[key] = value
	}
	base := readOpenAPIBaseSpec(root, collection.ID)
	if base.Error != "" {
		return openAPIDriftReport{}, errors.New(base.Error)
	}
	if !base.Exists {
		return openAPIDriftReport{}, fmt.Errorf("collection %q has not been synced yet: open it in Kurlo, check the spec and apply the changes, then commit %s", collection.Name, base.Path)
	}
	baseDoc, err := parseOpenAPIDocumentText(base.Content)
	if err != nil {
		return openAPIDriftReport{}, fmt.Errorf("%s: %w", base.Path, err)
	}
	var content, where string
	if opts.specPath != "" {
		file := readOpenAPISourceFile(root, opts.specPath)
		if file.Error != "" {
			return openAPIDriftReport{}, errors.New(file.Error)
		}
		content, where = file.Content, opts.specPath
	} else {
		content, where, err = fetchOpenAPISource(ctx, root, collection.OpenAPI, values, opts.insecure, opts.client)
		if err != nil {
			return openAPIDriftReport{}, err
		}
	}
	nextDoc, err := parseOpenAPIDocumentText(content)
	if err != nil {
		return openAPIDriftReport{}, fmt.Errorf("%s: %w", where, err)
	}
	report := compareOpenAPIDocuments(baseDoc, nextDoc)
	report.Collection = collection.Name
	report.Source = where
	for _, request := range requests {
		if request.CollectionID == collection.ID && request.OpenAPI == "" && (request.RequestType == "" || request.RequestType == "http") {
			report.Unlinked = append(report.Unlinked, request.Name)
		}
	}
	sort.Strings(report.Unlinked)
	return report, nil
}

func printOpenAPIDrift(w io.Writer, report openAPIDriftReport) {
	if report.InSync {
		fmt.Fprintf(w, "%s is in sync with %s\n", report.Collection, report.Source)
	} else {
		fmt.Fprintf(w, "%s has drifted from %s\n", report.Collection, report.Source)
	}
	section := func(title, mark string, changes []openAPIDriftChange) {
		if len(changes) == 0 {
			return
		}
		fmt.Fprintf(w, "\n%s (%d)\n", title, len(changes))
		for _, change := range changes {
			if change.From != "" {
				fmt.Fprintf(w, "  %s %s (was %s)\n", mark, change.Operation, change.From)
			} else {
				fmt.Fprintf(w, "  %s %s\n", mark, change.Operation)
			}
		}
	}
	section("New in the spec", "+", report.Added)
	section("Changed", "~", report.Changed)
	section("Moved", ">", report.Moved)
	section("Removed from the spec", "-", report.Removed)
	if len(report.Unlinked) > 0 {
		fmt.Fprintf(w, "\nRequests not linked to an operation (%d): %s\n", len(report.Unlinked), strings.Join(report.Unlinked, ", "))
	}
	if !report.InSync {
		fmt.Fprintln(w, "\nOpen the collection in Kurlo, review the changes on its OpenAPI tab and commit the result.")
	}
}

func (s *mcpServer) toolCheckOpenAPISync(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Collection  string `json:"collection"`
		Environment string `json:"environment"`
	}
	if err := json.Unmarshal(arguments, &args); err != nil {
		return nil, err
	}
	values := map[string]string{}
	envName := strings.TrimSpace(args.Environment)
	if envName == "" {
		envName = s.opts.env
	}
	if envName != "" {
		ws, err := s.loadWorkspace()
		if err != nil {
			return nil, err
		}
		for _, env := range ws.environments {
			if env.Name == envName && env.Protected {
				return nil, fmt.Errorf("environment %q is protected; ask the user to check the spec in Kurlo", envName)
			}
		}
		resolved, _, err := resolveCLIValues(cliOptions{env: envName, vars: map[string]string{}}, nil, ws.environments, nil)
		if err != nil {
			return nil, err
		}
		values = resolved
	}
	return checkOpenAPIDrift(ctx, openAPICheckOptions{workspace: s.opts.workspace, collection: strings.TrimSpace(args.Collection), values: values, insecure: s.opts.insecure})
}

func RunOpenAPICLI(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprintln(stdout, "Usage: kurlo openapi check [collection] [flags]")
		fmt.Fprintln(stdout, "\nCompare a synced collection's last applied spec with the current spec at its source.")
		fmt.Fprintln(stdout, "Exit codes: 0 in sync, 1 the spec changed, 2 the check could not run.")
		return 0
	}
	if args[0] != "check" {
		fmt.Fprintf(stderr, "kurlo openapi: unknown command %q (try kurlo openapi check)\n", args[0])
		return 2
	}
	fs := flag.NewFlagSet("kurlo openapi check", flag.ContinueOnError)
	fs.SetOutput(stderr)
	workspace := fs.String("workspace", ".", "path to the Kurlo YAML workspace directory")
	collection := fs.String("collection", "", "collection to check (by name); also accepted as the first argument")
	specPath := fs.String("spec", "", "compare with this spec file instead of the collection's source")
	envName := fs.String("env", "", "environment whose variables resolve {{variables}} in the source URL and headers")
	envFile := fs.String("env-file", "", "KEY=VALUE file whose values override environment variables")
	reporter := fs.String("reporter", "cli", "cli or json")
	insecure := fs.Bool("insecure", false, "skip TLS certificate verification when downloading the spec")
	var varFlags multiFlag
	fs.Var(&varFlags, "var", "set a variable as KEY=VALUE (repeatable)")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "Usage: kurlo openapi check [collection] [flags]")
		fs.PrintDefaults()
	}
	rest := args[1:]
	var positional []string
	for len(rest) > 0 {
		if err := fs.Parse(rest); err != nil {
			if err == flag.ErrHelp {
				return 0
			}
			return 2
		}
		rest = fs.Args()
		if len(rest) > 0 {
			positional = append(positional, rest[0])
			rest = rest[1:]
		}
	}
	if *collection == "" && len(positional) > 0 {
		*collection = positional[0]
	}
	if *reporter != "cli" && *reporter != "json" {
		fmt.Fprintf(stderr, "kurlo openapi check: unknown reporter %q (use cli or json)\n", *reporter)
		return 2
	}
	root, err := filepath.Abs(*workspace)
	if err != nil {
		fmt.Fprintln(stderr, "kurlo openapi check:", err)
		return 2
	}
	values := map[string]string{}
	if *envName != "" || *envFile != "" {
		_, _, _, environments, err := loadCLIWorkspace(root)
		if err != nil {
			fmt.Fprintln(stderr, "kurlo openapi check:", err)
			return 2
		}
		resolved, _, err := resolveCLIValues(cliOptions{env: *envName, envFile: *envFile, vars: map[string]string{}}, nil, environments, nil)
		if err != nil {
			fmt.Fprintln(stderr, "kurlo openapi check:", err)
			return 2
		}
		values = resolved
	}
	for _, item := range varFlags {
		key, value, ok := strings.Cut(item, "=")
		if !ok || strings.TrimSpace(key) == "" {
			fmt.Fprintf(stderr, "kurlo openapi check: --var expects KEY=VALUE, got %q\n", item)
			return 2
		}
		values[strings.TrimSpace(key)] = value
	}
	report, err := checkOpenAPIDrift(context.Background(), openAPICheckOptions{
		workspace: root, collection: *collection, specPath: *specPath, values: values, insecure: *insecure,
	})
	if err != nil {
		fmt.Fprintln(stderr, "kurlo openapi check:", err)
		return 2
	}
	if *reporter == "json" {
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		_ = encoder.Encode(report)
	} else {
		printOpenAPIDrift(stdout, report)
	}
	if report.InSync {
		return 0
	}
	return 1
}
