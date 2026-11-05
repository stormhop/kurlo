package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const knowledgeTextLimit = 1 << 20

var errKnowledgeLimit = errors.New("project search limit reached")

func knowledgePath(name string) (string, error) {
	if name == "" {
		name = "."
	}
	name = filepath.ToSlash(name)
	if strings.Contains(name, "\\") || !fs.ValidPath(name) || strings.ContainsRune(name, ':') {
		return "", fmt.Errorf("provide a path relative to the connected project")
	}
	for _, part := range strings.Split(name, "/") {
		if part != "." && knowledgeExcluded(part) {
			return "", fmt.Errorf("the requested path is excluded from project access")
		}
	}
	return name, nil
}

func knowledgeExcluded(name string) bool {
	name = strings.ToLower(name)
	if strings.HasPrefix(name, ".") {
		return name != ".gitignore" && name != ".dockerignore" && name != ".editorconfig"
	}
	switch name {
	case "node_modules", "vendor", "dist", "build", "coverage", "__pycache__", "credentials", "secrets", "id_rsa", "id_ed25519":
		return true
	}
	return strings.HasPrefix(name, "credentials.") || strings.HasPrefix(name, "secrets.") ||
		strings.HasSuffix(name, ".pem") || strings.HasSuffix(name, ".key") || strings.HasSuffix(name, ".p12")
}

func knowledgeStat(root *os.Root, name string) (fs.FileInfo, error) {
	parts := strings.Split(name, "/")
	for i := range parts {
		info, err := root.Lstat(strings.Join(parts[:i+1], "/"))
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("project access does not follow symbolic links")
		}
		if i == len(parts)-1 {
			return info, nil
		}
	}
	return nil, fs.ErrInvalid
}

func readKnowledgeFile(directory, name string, limit int64) ([]byte, error) {
	if directory == "" {
		return nil, fmt.Errorf("attach a project folder to this chat or start kurlo mcp with --project-root")
	}
	name, err := knowledgePath(name)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return readKnowledgeRoot(root, name, limit)
}

func readKnowledgeRoot(root *os.Root, name string, limit int64) ([]byte, error) {
	info, err := knowledgeStat(root, name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, fmt.Errorf("expected a regular file of at most %d bytes", limit)
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, limit+1))
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("file exceeds the %d byte limit", limit)
	}
	return body, err
}

type knowledgeWalkArgs struct {
	Path  string `json:"path"`
	Glob  string `json:"glob"`
	Limit int    `json:"limit"`
	Query string `json:"query"`
}

func (s *mcpServer) walkKnowledge(ctx context.Context, args knowledgeWalkArgs, visit func(*os.Root, string, fs.DirEntry) error) (bool, error) {
	if s.opts.projectRoot == "" {
		return false, fmt.Errorf("attach a project folder to this chat or start kurlo mcp with --project-root")
	}
	start, err := knowledgePath(args.Path)
	if err != nil {
		return false, err
	}
	if args.Glob != "" {
		if _, err := path.Match(args.Glob, "file"); err != nil {
			return false, fmt.Errorf("invalid glob: %w", err)
		}
	}
	root, err := os.OpenRoot(s.opts.projectRoot)
	if err != nil {
		return false, err
	}
	defer root.Close()
	if _, err = knowledgeStat(root, start); err != nil {
		return false, err
	}
	visited := 0
	err = fs.WalkDir(root.FS(), start, func(name string, entry fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			if name == start {
				return err
			}
			return nil
		}
		visited++
		if visited > 10000 {
			return errKnowledgeLimit
		}
		if name != start && knowledgeExcluded(entry.Name()) {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() || !entry.Type().IsRegular() {
			return nil
		}
		if args.Glob != "" {
			matched, _ := path.Match(args.Glob, name)
			basename, _ := path.Match(args.Glob, entry.Name())
			if !matched && !basename {
				return nil
			}
		}
		return visit(root, name, entry)
	})
	if errors.Is(err, errKnowledgeLimit) {
		return true, nil
	}
	return false, err
}

func knowledgeResultLimit(requested, fallback, maximum int) (int, error) {
	if requested < 0 || requested > maximum {
		return 0, fmt.Errorf("limit must be between 1 and %d", maximum)
	}
	if requested == 0 {
		return fallback, nil
	}
	return requested, nil
}

func (s *mcpServer) toolListFiles(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args knowledgeWalkArgs
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	limit, err := knowledgeResultLimit(args.Limit, 100, 500)
	if err != nil {
		return nil, err
	}
	files := []string{}
	truncated, err := s.walkKnowledge(ctx, args, func(_ *os.Root, name string, _ fs.DirEntry) error {
		if len(files) >= limit {
			return errKnowledgeLimit
		}
		files = append(files, name)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"files": files, "truncated": truncated}, nil
}

type knowledgeTextArgs struct {
	Path       string `json:"path"`
	Attachment string `json:"attachment"`
	StartLine  int    `json:"startLine"`
	LineCount  int    `json:"lineCount"`
}

func knowledgeText(body []byte, args knowledgeTextArgs, secrets []string) (map[string]any, error) {
	if !utf8.Valid(body) || strings.ContainsRune(string(body), 0) {
		return nil, fmt.Errorf("expected a UTF-8 text file")
	}
	if args.StartLine < 0 {
		return nil, fmt.Errorf("startLine must be positive")
	}
	limit, err := knowledgeResultLimit(args.LineCount, 200, 500)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.ReplaceAll(string(body), "\r\n", "\n"), "\n")
	start := max(1, args.StartLine)
	if start > len(lines) {
		return nil, fmt.Errorf("file has only %d lines", len(lines))
	}
	end := min(len(lines), start-1+limit)
	bodyText, truncated := mcpTruncate(redactSecrets(strings.Join(lines[start-1:end], "\n"), secrets), 36000)
	return map[string]any{"text": bodyText, "startLine": start, "endLine": end, "totalLines": len(lines), "truncated": truncated || end < len(lines)}, nil
}

func (s *mcpServer) toolReadFile(_ context.Context, arguments json.RawMessage) (any, error) {
	var args knowledgeTextArgs
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	body, err := readKnowledgeFile(s.opts.projectRoot, args.Path, knowledgeTextLimit)
	if err != nil {
		return nil, err
	}
	out, err := knowledgeText(body, args, agentActivitySecrets())
	if err != nil {
		return nil, err
	}
	out["path"] = args.Path
	return out, nil
}

func (s *mcpServer) toolSearchCode(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args knowledgeWalkArgs
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.Query) == "" || len(args.Query) > 256 {
		return nil, fmt.Errorf("provide a nonempty literal query of at most 256 bytes")
	}
	limit, err := knowledgeResultLimit(args.Limit, 40, 100)
	if err != nil {
		return nil, err
	}
	query := strings.ToLower(args.Query)
	matches := []map[string]any{}
	secrets := agentActivitySecrets()
	budget := 32 << 20
	truncated, err := s.walkKnowledge(ctx, args, func(root *os.Root, name string, _ fs.DirEntry) error {
		body, err := readKnowledgeRoot(root, name, knowledgeTextLimit)
		if err != nil || !utf8.Valid(body) || strings.ContainsRune(string(body), 0) {
			return nil
		}
		budget -= len(body)
		if budget < 0 {
			return errKnowledgeLimit
		}
		for i, line := range strings.Split(string(body), "\n") {
			if !strings.Contains(strings.ToLower(line), query) {
				continue
			}
			if len(matches) >= limit {
				return errKnowledgeLimit
			}
			text, _ := mcpTruncate(redactSecrets(strings.TrimSpace(line), secrets), 320)
			matches = append(matches, map[string]any{"path": name, "line": i + 1, "text": text})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"matches": matches, "truncated": truncated}, nil
}

func (s *mcpServer) toolGetDocs(_ context.Context, arguments json.RawMessage) (any, error) {
	var args mcpDocsArgs
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	st, err := s.loadStore()
	if err != nil {
		return nil, err
	}
	item, field, err := args.target(st)
	if err != nil {
		return nil, err
	}
	content, truncated := mcpTruncate(redactSecrets(stringValue(item, field), agentActivitySecrets()), 50000)
	return map[string]any{"id": stringValue(item, "id"), "name": stringValue(item, "name"), "markdown": content, "truncated": truncated}, nil
}

type mcpDocsArgs struct {
	Request    string  `json:"request"`
	Collection string  `json:"collection"`
	Markdown   *string `json:"markdown"`
}

func (args mcpDocsArgs) target(st *mcpStore) (map[string]any, string, error) {
	if (args.Request == "") == (args.Collection == "") {
		return nil, "", fmt.Errorf("provide exactly one of request or collection")
	}
	if args.Request != "" {
		item, _, err := st.request(args.Request)
		return item, "requestNotes", err
	}
	item, err := st.collection(args.Collection)
	return item, "description", err
}

func (s *mcpServer) toolSaveDocs(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args mcpDocsArgs
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	if args.Markdown == nil || len(*args.Markdown) > 50000 {
		return nil, fmt.Errorf("provide markdown of at most 50000 bytes; an empty string clears it")
	}
	if err := validateMCPWorkspaceInput(*args.Markdown); err != nil {
		return nil, err
	}
	return s.mutate(ctx, func(st *mcpStore) (func() any, error) {
		item, field, err := args.target(st)
		if err != nil {
			return nil, err
		}
		item[field] = *args.Markdown
		return func() any {
			return map[string]any{"id": stringValue(item, "id"), "name": stringValue(item, "name"), "updated": true}
		}, nil
	})
}

func (s *mcpServer) toolSyncCollection(_ context.Context, arguments json.RawMessage) (any, error) {
	var args map[string]string
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	if s.opts.projectRoot == "" {
		return nil, fmt.Errorf("connect the project's source folder first")
	}
	return map[string]any{"workflow": mcpSyncCollectionPrompt(args)}, nil
}

func (s *mcpServer) toolCoverEndpoint(_ context.Context, arguments json.RawMessage) (any, error) {
	var args map[string]string
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args["endpoint"]) == "" {
		return nil, fmt.Errorf("provide the endpoint's method and path")
	}
	if s.opts.projectRoot == "" {
		return nil, fmt.Errorf("connect the project's source folder first")
	}
	return map[string]any{"workflow": mcpCoverEndpointPrompt(args)}, nil
}

func knowledgeReadTool(description string, properties map[string]string, required []string, run func(*mcpServer, context.Context, json.RawMessage) (any, error)) executionTool {
	return executionTool{description: description, properties: properties, required: required, kind: model.AgentToolRead, run: run}
}
