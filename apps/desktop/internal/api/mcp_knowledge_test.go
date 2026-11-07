package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const knowledgeOpenAPI = `openapi: 3.1.0
info:
  title: Pet Store
servers:
  - url: https://api.example.test/v1
paths:
  /pets/{id}:
    get:
      summary: Get Pet
      tags: [Pets]
      parameters:
        - name: id
          in: path
          schema: {type: string, default: pet-12}
      responses:
        '200':
          description: Found
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
components:
  schemas:
    Pet:
      type: object
      properties:
        name: {type: string, example: Spot}
`

func TestKnowledgeImportsPreviewAndApplyThroughMCP(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	tests := []struct {
		name, source string
		checks       []string
	}{
		{"openapi", knowledgeOpenAPI, []string{"Pet Store", "Get Pet", "pet-12", "Spot"}},
		{"postman", `{"info":{"name":"Store"},"variable":[{"key":"apiKey","value":"top-secret"}],"item":[{"name":"Pets","event":[{"listen":"test","script":{"exec":["pm.test('ok', () => {});"]}}],"item":[{"name":"Create Pet","request":{"method":"POST","url":{"raw":"https://example.test/pets?q=cat","query":[{"key":"q","value":"cat"}]},"auth":{"type":"bearer","bearer":[{"key":"token","value":"top-secret"}]},"body":{"mode":"raw","raw":"{\"name\":\"Spot\"}","options":{"raw":{"language":"json"}}}},"response":[{"name":"Created","code":201,"body":"ok"}]}]}]}`, []string{"Create Pet", "pm.test", "bearerToken", "Created"}},
		{"insomnia", `{"resources":[{"_id":"wrk","_type":"workspace","name":"Insomnia Store"},{"_id":"env","_type":"environment","name":"Staging","data":{"baseUrl":"https://staging.example.test"}},{"_id":"folder","_type":"request_group","parentId":"wrk","name":"Stream"},{"_id":"req","_type":"grpc_request","parentId":"folder","name":"Ping","url":"localhost:50051","protoMethodName":"pkg.Service/Ping","body":{"mimeType":"application/json","text":"{}"}}]}`, []string{"Ping", "pkg.Service/Ping", "Staging", "Stream"}},
		{"har", `{"log":{"entries":[{"request":{"url":"https://example.test/pets?q=cat","method":"GET","headers":[{"name":"Cookie","value":"top-secret"}]},"response":{"status":200,"content":{"mimeType":"application/json","text":"[]"}}}]}}`, []string{"Captured response", "Cookie", "cat"}},
		{"curl", `curl --json '{"name":"Spot"}' -H 'Authorization: Bearer top-secret' 'https://example.test/pets'`, []string{"POST", "Spot", "Authorization"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := agentTestWorkspace(t, "http://127.0.0.1:1")
			h := startMCPHarness(t, mcpServerOptions{workspace: root})
			before := workspaceTreeForTest(t, root)
			var preview struct {
				ImportID   string                  `json:"importId"`
				Changes    []model.AgentFileChange `json:"changes"`
				NextOffset int                     `json:"nextOffset"`
			}
			h.tool("import_preview", map[string]any{"format": tc.name, "content": tc.source, "limit": 1}, &preview)
			if preview.ImportID == "" || len(preview.Changes) != 1 || preview.NextOffset != 1 {
				t.Fatalf("preview = %+v", preview)
			}
			var rest struct {
				Changes []model.AgentFileChange `json:"changes"`
			}
			h.tool("import_preview", map[string]any{"importId": preview.ImportID, "offset": preview.NextOffset}, &rest)
			preview.Changes = append(preview.Changes, rest.Changes...)
			if fmt.Sprint(workspaceTreeForTest(t, root)) != fmt.Sprint(before) {
				t.Fatal("preview wrote files")
			}
			if h.tool("import_apply", map[string]any{"importId": preview.ImportID}, nil).IsError != true {
				t.Fatal("applied without confirmation")
			}
			var result map[string]any
			h.tool("import_apply", map[string]any{"importId": preview.ImportID, "confirm": true}, &result)
			files := workspaceTreeForTest(t, root)
			snapshot := fmt.Sprint(files)
			for _, want := range tc.checks {
				if !strings.Contains(snapshot, want) {
					t.Errorf("missing %q from %s", want, snapshot)
				}
			}
			if strings.Contains(snapshot, "top-secret") {
				t.Fatalf("import wrote credentials: %s", snapshot)
			}
			for _, change := range preview.Changes {
				if change.After != nil && files[change.Path] != *change.After {
					t.Fatalf("applied a different diff at %s", change.Path)
				}
			}
			if _, err := loadMCPStore(root); err != nil {
				t.Fatal(err)
			}
			if !h.tool("import_apply", map[string]any{"importId": preview.ImportID, "confirm": true}, nil).IsError {
				t.Fatal("applied the same import twice")
			}
		})
	}
}

func TestKnowledgeImportRejectsChangedFilesAndReviewsTheBatch(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge, approvals := newTestAgentBridge(t, root, model.AgentApprovalReject, model.AgentApprovalAllow, model.AgentApprovalAllow)
	ctx := t.Context()
	preview := callExecutionTool(t, bridge.server, ctx, "import_preview", map[string]any{"content": knowledgeOpenAPI})
	id := preview["importId"].(string)
	if _, failed := agentBridgeCall(t, bridge, "import_apply", map[string]any{"importId": id, "confirm": true}); !failed {
		t.Fatal("declined import was applied")
	}
	if approval := approvals.last(); approval.Kind != model.AgentToolWrite || len(approval.Changes) < 3 {
		t.Fatalf("missing combined diff: %+v", approval)
	}
	for _, change := range approvals.last().Changes {
		if change.Before != nil {
			target := filepath.Join(root, filepath.FromSlash(change.Path))
			if err := os.WriteFile(target, []byte(*change.Before+"\n"), 0600); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	if out, failed := agentBridgeCall(t, bridge, "import_apply", map[string]any{"importId": id}); !failed || !strings.Contains(out, "changed while waiting") {
		t.Fatalf("stale import = %s", out)
	}
	preview = callExecutionTool(t, bridge.server, ctx, "import_preview", map[string]any{"content": knowledgeOpenAPI})
	if out, failed := agentBridgeCall(t, bridge, "import_apply", map[string]any{"importId": preview["importId"]}); failed {
		t.Fatalf("approved import = %s", out)
	}
}

func TestKnowledgeOpenAPIURLRequiresAgentApproval(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	fetched := make(chan struct{}, 2)
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetched <- struct{}{}
		_, _ = io.WriteString(w, knowledgeOpenAPI)
	}))
	defer source.Close()
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge, approvals := newTestAgentBridge(t, root, model.AgentApprovalReject, model.AgentApprovalAllow)
	if out, failed := agentBridgeCall(t, bridge, "import_preview", map[string]any{"url": source.URL}); !failed || !strings.Contains(out, "declined") || len(fetched) != 0 {
		t.Fatalf("unapproved fetch = %s", out)
	}
	if out, failed := agentBridgeCall(t, bridge, "import_preview", map[string]any{"url": source.URL}); failed || !strings.Contains(out, "importId") || len(fetched) != 1 {
		t.Fatalf("approved fetch = %s", out)
	}
	if approvals.last().Kind != model.AgentToolExternal {
		t.Fatal("URL fetch did not request an external approval")
	}
}

func TestKnowledgeProjectReadAndSearchStayInsideRoot(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	project := t.TempDir()
	outside := t.TempDir()
	if err := os.Mkdir(filepath.Join(project, "src"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		filepath.Join(project, "src", "router.go"): "package router\nfunc setup() { handle(\"/pets\") }",
		filepath.Join(project, "api.yaml"):         knowledgeOpenAPI,
		filepath.Join(project, ".env"):             "secret=outside-tool",
		filepath.Join(outside, "secret.go"):        "package outside",
	} {
		if err := os.WriteFile(name, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(project, "link")); err != nil {
		t.Fatal(err)
	}
	s := newMCPServer(mcpServerOptions{workspace: root, projectRoot: project}, io.Discard)
	ctx := t.Context()
	list := callExecutionTool(t, s, ctx, "list_files", nil)
	if fmt.Sprint(list["files"]) != "[api.yaml src/router.go]" {
		t.Fatalf("list = %v", list)
	}
	found := callExecutionTool(t, s, ctx, "search_code", map[string]any{"query": "/PETS", "glob": "*.go"})
	if !strings.Contains(fmt.Sprint(found), "line:2") {
		t.Fatalf("search = %v", found)
	}
	preview := callExecutionTool(t, s, ctx, "import_preview", map[string]any{"file": "api.yaml"})
	if preview["importId"] == "" {
		t.Fatalf("file import = %v", preview)
	}
	file := callExecutionTool(t, s, ctx, "read_file", map[string]any{"path": "src/router.go", "startLine": 2})
	if !strings.Contains(file["text"].(string), "/pets") {
		t.Fatalf("file = %v", file)
	}
	for _, path := range []string{"../secret.go", "link/secret.go", ".env", filepath.Join(outside, "secret.go")} {
		if _, err := s.toolReadFile(ctx, json.RawMessage(importJSON(map[string]string{"path": path}))); err == nil {
			t.Errorf("read %q outside access scope", path)
		}
	}
	for name, args := range map[string]map[string]string{"sync_collection": {"collection": "Smoke"}, "cover_endpoint": {"endpoint": "GET /pets"}} {
		plan := callExecutionTool(t, s, ctx, name, args)
		if !strings.Contains(plan["workflow"].(string), "search_code") {
			t.Fatalf("workflow = %v", plan)
		}
	}
}

func TestKnowledgeDocsAndSnippetsThroughAgent(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge, approvals := newTestAgentBridge(t, root, model.AgentApprovalAllow, model.AgentApprovalAllow)
	for key, target := range map[string]string{"request": "Ok", "collection": "Smoke"} {
		if out, failed := agentBridgeCall(t, bridge, "save_docs", map[string]any{key: target, "markdown": "# " + target + " guide"}); failed {
			t.Fatalf("save docs = %s", out)
		}
		if change := approvals.last().Changes; len(change) != 1 {
			t.Fatalf("docs diff = %v", change)
		}
		doc := callExecutionTool(t, bridge.server, t.Context(), "get_docs", map[string]any{key: target})
		if doc["markdown"] != "# "+target+" guide" {
			t.Fatalf("doc = %v", doc)
		}
	}
	for _, language := range []string{"curl", "httpie", "javascript", "node", "axios", "python", "go", "java", "csharp", "php", "ruby", "swift", "kotlin", "rust"} {
		code := callExecutionTool(t, bridge.server, t.Context(), "code_snippet", map[string]any{"request": "Ok", "language": language})["code"].(string)
		if !strings.Contains(code, "GET") || !strings.Contains(code, "/ok") {
			t.Errorf("%s snippet = %s", language, code)
		}
	}
}

func TestKnowledgeAttachmentsBecomeTurnToolsAndVisionContent(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	dir := t.TempDir()
	csv := filepath.Join(dir, "rows.csv")
	png := filepath.Join(dir, "screenshot.png")
	if err := os.WriteFile(csv, []byte("id\npet-1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	pixel, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xl1sAAAAASUVORK5CYII=")
	if err := os.WriteFile(png, pixel, 0600); err != nil {
		t.Fatal(err)
	}
	files, err := loadAgentAttachments([]string{csv, png})
	if err != nil {
		t.Fatal(err)
	}
	s := newMCPServer(mcpServerOptions{workspace: root}, io.Discard)
	s.live = newAgentLiveSessions(t.Context(), s.jars)
	defer s.live.close()
	s.attachments = files
	if out := callExecutionTool(t, s, t.Context(), "read_attachment", map[string]any{"attachment": files[0].id}); !strings.Contains(out["text"].(string), "pet-1") {
		t.Fatalf("attachment = %v", out)
	}
	history, _ := agentHistoryForModel([]model.AiMessage{newAgentUserMessage("Check it", files)}, 0)
	msg := history[0]
	msg.Blocks = append(msg.Blocks, agentImageBlocks(files)...)
	if len(msg.Attachments) != 0 || !strings.Contains(msg.Blocks[0].Text, fmt.Sprintf("%q (attachment %s, available with read_attachment)", "rows.csv", files[0].id)) {
		t.Fatalf("model attachment prompt = %+v", msg)
	}
	earlier := newAgentUserMessage("First", files)
	reply := model.AiMessage{Role: "assistant", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "ok"}}}
	twoTurns, _ := agentHistoryForModel([]model.AiMessage{earlier, reply, newAgentUserMessage("Again", files)}, 0)
	if first, last := twoTurns[0].Blocks[0].Text, twoTurns[2].Blocks[0].Text; strings.Contains(first, "image included with this message") || !strings.Contains(first, "no longer included") || !strings.Contains(last, "image included with this message") {
		t.Fatalf("image notes = %q / %q", first, last)
	}
	openAI := fmt.Sprint(openAIMessages("", []model.AiMessage{msg}))
	anthropic := fmt.Sprint(anthropicMessages([]model.AiMessage{msg}))
	if !strings.Contains(openAI, "image_url") || !strings.Contains(openAI, "data:image/png;base64,") || !strings.Contains(anthropic, "media_type:image/png") {
		t.Fatalf("image was not encoded: %s / %s", openAI, anthropic)
	}
}

func TestKnowledgeVisionThroughAgentKeepsOriginalOutsideChatHistory(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	copyWorkspaceTo(t, agentTestWorkspace(t, "http://127.0.0.1:1"), fileWorkspaceStorePath())
	provider := newAiTestServer(t, sseScript{events: []string{
		openAIChunkEvent(`{"choices":[{"index":0,"delta":{"content":"I see the screenshot."},"finish_reason":"stop"}]}`),
		openAIChunkEvent(`[DONE]`),
	}})
	var original bytes.Buffer
	if err := png.Encode(&original, image.NewRGBA(image.Rect(0, 0, 1024, 512))); err != nil {
		t.Fatal(err)
	}
	encoded := base64.StdEncoding.EncodeToString(original.Bytes())
	path := filepath.Join(t.TempDir(), "capture.png")
	if err := os.WriteFile(path, original.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if result := app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionCompatible, BaseURL: provider.URL, Key: "test", Model: "demo"}); result.Error != "" {
		t.Fatal(result.Error)
	}
	project := t.TempDir()
	result := app.SendAgentMessage(model.AgentSendInput{WorkspaceID: "ws-demo", Text: "What is shown?", ProjectRoot: &project, Attachments: []string{path}})
	if result.Error != "" || result.Text != "I see the screenshot." {
		t.Fatalf("turn = %+v", result)
	}
	if sent := fmt.Sprint(provider.body(0)["messages"]); !strings.Contains(sent, "data:image/png;base64,"+encoded) {
		t.Fatalf("vision input was omitted: %v", sent)
	}
	saved, err := app.AgentChat(result.Chat.ID)
	canonical, _ := filepath.EvalSymlinks(project)
	if err != nil {
		t.Fatal(err)
	}
	user := saved.Messages[0]
	if saved.ProjectRoot != canonical || user.Blocks[0].Text != "What is shown?" || len(user.Attachments) != 1 || user.Attachments[0].Name != "capture.png" || strings.Contains(importJSON(saved), encoded) {
		t.Fatalf("persisted chat project/attachments = %s / %+v", saved.ProjectRoot, user)
	}
	preview, ok := strings.CutPrefix(user.Attachments[0].Preview, "data:image/jpeg;base64,")
	if !ok {
		t.Fatal("missing image preview")
	}
	config, err := jpeg.DecodeConfig(base64.NewDecoder(base64.StdEncoding, strings.NewReader(preview)))
	if err != nil || config.Width != 256 || config.Height != 128 {
		t.Fatalf("image preview = %+v, %v", config, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	id := user.Attachments[0].ID
	if data, err := app.AgentAttachmentData(saved.ID, "ws-demo", id); err != nil || data != "data:image/png;base64,"+encoded {
		t.Fatalf("could not reopen the original image: %v", err)
	}
	if _, err := app.AgentAttachmentData(saved.ID, "another-workspace", id); err == nil {
		t.Fatal("opened an attachment from another workspace")
	}
	chatPath, err := agentChatPath(saved.ID)
	if err != nil {
		t.Fatal(err)
	}
	dir := chatPath + ".attachments"
	sealed, err := os.ReadFile(filepath.Join(dir, id))
	if err != nil || bytes.Contains(sealed, original.Bytes()) || bytes.Contains(sealed, []byte(encoded)) {
		t.Fatalf("attachment was not stored encrypted: %v", err)
	}
	if deleted := app.DeleteAgentChat(saved.ID); !deleted.Ok {
		t.Fatalf("delete chat: %+v", deleted)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("attachment directory survived deletion: %v", err)
	}
}

func TestKnowledgeSVGAttachmentOpensAndExposesSourceToAgent(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5"/></svg>`
	path := filepath.Join(t.TempDir(), "icon.svg")
	if err := os.WriteFile(path, []byte(svg), 0600); err != nil {
		t.Fatal(err)
	}
	files, err := loadAgentAttachments([]string{path})
	if err != nil {
		t.Fatal(err)
	}
	message := newAgentUserMessage("Describe the icon", files)
	id := message.Attachments[0].ID
	encoded := "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg))
	if message.Attachments[0].Preview != encoded || len(agentImageBlocks(files)) != 0 || !strings.Contains(agentAttachmentPrompt("Describe the icon", message.Attachments), id+", available with read_attachment") {
		t.Fatalf("SVG attachment = %+v", message.Attachments[0])
	}
	s := &mcpServer{attachments: files}
	out, err := s.toolReadAttachment(t.Context(), json.RawMessage(fmt.Sprintf(`{"attachment":%q}`, id)))
	if err != nil || !strings.Contains(fmt.Sprint(out), "<circle") {
		t.Fatalf("read SVG source: %v, %v", out, err)
	}
	chat, err := createAgentChat(model.AgentChat{ID: "svg-chat", Workspace: agentWorkspaceKey(fileWorkspaceStorePath()), WorkspaceID: "ws-demo", Messages: []model.AiMessage{message}}, files...)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if data, err := NewApp().AgentAttachmentData(chat.ID, "ws-demo", id); err != nil || data != encoded {
		t.Fatalf("reopen SVG: %v", err)
	}
	if err := os.WriteFile(path, []byte("<html></html>"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadAgentAttachment(path); err == nil {
		t.Fatal("accepted HTML as SVG")
	}
}

func TestAgentChatPageDisplaysLegacyAttachmentNames(t *testing.T) {
	const prompt = "What is shown?"
	stored := agentAttachmentPrompt(prompt, []model.AgentAttachment{{Name: `capture "one".png`}, {Name: "rows.csv", ID: "abc123ef"}})
	chat := model.AgentChat{Messages: []model.AiMessage{
		{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: stored}}},
		{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: stored + "\nMy own text"}}},
	}}
	page := agentChatPage(chat, -1)
	first := page.Messages[0]
	if first.Blocks[0].Text != prompt || len(first.Attachments) != 2 || first.Attachments[0].Name != `capture "one".png` || first.Attachments[1].Name != "rows.csv" {
		t.Fatalf("legacy message = %+v", first)
	}
	if page.Messages[1].Blocks[0].Text != stored+"\nMy own text" || chat.Messages[0].Blocks[0].Text != stored {
		t.Fatal("displaying a legacy attachment rewrote stored text")
	}
}

func TestKnowledgeRunCollectionFromAttachedCSV(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server, _ := countingServer(t)
	root := agentTestWorkspace(t, server.URL)
	s := newMCPServer(mcpServerOptions{workspace: root, env: "Local"}, io.Discard)
	s.attachments = []agentAttachment{{id: "csv", name: "rows.csv", data: []byte("apiVersion\nfrom_csv\n")}}
	result := callExecutionTool(t, s, t.Context(), "run_collection", map[string]any{"collection": "Smoke", "dataAttachment": "csv"})
	if !strings.Contains(fmt.Sprint(result["results"]), "v=from_csv") {
		t.Fatalf("CSV did not reach the runner: %v", result)
	}
}
