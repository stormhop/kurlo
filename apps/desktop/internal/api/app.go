package api

import (
	"context"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/auth"
	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

var appVersion = "dev"

const maxTextFileReadSize = 100 * 1024 * 1024

type App struct {
	ctx            context.Context
	quit           *quitGate
	requestMu      sync.Mutex
	requestSeq     uint64
	requestCancels map[string]requestCancel
	state          *state.Manager
	cookieJars     *cookieJarRegistry
	preflightCache *preflightCache
	sse            *sseManager
	ws             *websocketManager
	sio            *socketIOManager
	mock           *mockServer
	cookieSync     *cookieSyncServer
	binaryBodies   *binaryResponseCache
	mcpSessions    *mcpSessionRegistry
}

type SaveRequestStoreResult struct {
	Ok    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

type requestCancel struct {
	seq    uint64
	cancel context.CancelFunc
}

func NewApp() *App {
	jars := newCookieJarRegistry()
	return &App{
		quit:           newQuitGate(),
		requestCancels: make(map[string]requestCancel),
		binaryBodies:   newBinaryResponseCache(),
		mcpSessions:    newMCPSessionRegistry(),
		state:          state.New(),
		cookieJars:     jars,
		preflightCache: newPreflightCache(),
		sse:            newSSEManager(jars),
		ws:             newWebSocketManager(jars),
		sio:            newSocketIOManager(jars),
		mock:           newMockServer(),
		cookieSync:     newCookieSyncServer(jars),
	}
}

func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	go a.watchWorkspaceDisk(ctx)
	repairStaleBundleInBackground(ctx)
	go refreshInstalledBrowserExtensions()
}

func (a *App) DiagnosticsReport() string {
	return DiagnosticsReport()
}

func (a *App) LogFilePath() string {
	return LogFilePath()
}

func (a *App) OpenLogFolder() string {
	dir := logDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "Could not open the log folder: " + err.Error()
	}
	if err := revealInFileManager(dir); err != nil {
		return "Could not open the log folder: " + err.Error()
	}
	return ""
}

func (a *App) Shutdown(_ context.Context) {
	defer CloseLogFile()
	if a.ws != nil {
		a.ws.disconnectAll()
	}
	if a.sio != nil {
		a.sio.disconnectAll()
	}
	if a.sse != nil {
		a.sse.disconnectAll()
	}
	if a.mock != nil {
		a.mock.stop()
	}
	if a.cookieSync != nil {
		a.cookieSync.stopServer()
	}
	httpTransports.closeAll()
}

func (a *App) BeforeClose(ctx context.Context) bool {
	return a.quit.beforeClose(ctx)
}

func (a *App) AppInfo() model.AppInfo {
	return model.AppInfo{
		Name:      "Kurlo",
		Version:   appVersion,
		Runtime:   goruntime.GOOS + "/" + goruntime.GOARCH,
		GoVersion: goruntime.Version(),
		Packaged:  runningAsPackagedApp(),
	}
}

func (a *App) Show() {
	if a.ctx != nil {
		runtime.WindowShow(a.ctx)
	}
}

func (a *App) MenuZoom(action string) {
	if a.ctx == nil {
		return
	}
	switch action {
	case "in", "out", "reset":
		runtime.EventsEmit(a.ctx, "kurlo:zoom", action)
	}
}

func (a *App) emitWorkspaceChanged(reason string) {
	if a.ctx == nil {
		return
	}
	if root := workspaceDisk.trackedRoot(); root != "" {
		workspaceDisk.markAnnounced(root)
	}
	runtime.EventsEmit(a.ctx, "kurlo:workspace-changed", reason)
}

func (a *App) Quit() {
	if a.ctx != nil {
		runtime.Quit(a.ctx)
	}
}

func (a *App) AckQuit() {
	a.quit.acknowledge()
}

func (a *App) ConfirmQuit() {
	if a.ctx == nil {
		return
	}
	a.quit.confirm(a.ctx)
}

func (a *App) CancelQuit() {
	a.quit.cancel()
}

func (a *App) SetAppThemeBackground(theme string, background string) {
	resolved := normalizeResolvedTheme(theme)
	_ = saveResolvedThemePreference(resolved)
	_ = saveWindowBackgroundPreference(background)
	if a.ctx == nil {
		return
	}
	r, g, b, alpha := loadWindowBackgroundPreference(resolved)
	runtime.WindowSetBackgroundColour(a.ctx, r, g, b, alpha)
}

func (a *App) ClipboardSet(text string) {
	if a.ctx != nil {
		runtime.ClipboardSetText(a.ctx, text)
	}
}

func (a *App) ClipboardGet() string {
	if a.ctx == nil {
		return ""
	}
	text, _ := runtime.ClipboardGetText(a.ctx)
	return text
}

func (a *App) OpenFileDialog(title string) string {
	if a.ctx == nil {
		return ""
	}
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{Title: title})
	if err != nil {
		return ""
	}
	return path
}

func (a *App) ReadTextFile(path string) string {
	if path == "" {
		return ""
	}
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() || fi.Size() > maxTextFileReadSize {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(data)
}

func (a *App) SaveFileDialog(defaultName string, content string) string {
	if a.ctx == nil {
		return ""
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: defaultName,
		Title:           "Save file",
	})
	if err != nil || path == "" {
		return ""
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		return ""
	}
	return path
}

func (a *App) LoadRequestStore() string {
	gitOperationMu.RLock()
	defer gitOperationMu.RUnlock()
	root := fileWorkspaceStorePath()
	if unlock, err := lockWorkspaceWrites(root); err == nil {
		defer unlock()
	}
	payload, _, err := loadKurloStorePayloadWithDiagnostics(requestStorePath(), root)
	if hasYAMLWorkspaceStore(root) {
		workspaceDisk.remember(root)
	}
	if err != nil {
		return ""
	}
	return payload
}

func (a *App) LoadWorkspaceDiagnostics() []WorkspaceDiagnostic {
	gitOperationMu.RLock()
	defer gitOperationMu.RUnlock()
	_, diagnostics, _ := loadKurloStorePayloadWithDiagnostics(requestStorePath(), fileWorkspaceStorePath())
	if diagnostics == nil {
		return []WorkspaceDiagnostic{}
	}
	return diagnostics
}

func (a *App) SaveRequestStore(payload string) bool {
	return a.SaveRequestStoreWithError(payload).Ok
}

func (a *App) SaveRequestStoreWithError(payload string) SaveRequestStoreResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	if err := a.saveRequestStorePayload(payload); err != nil {
		return SaveRequestStoreResult{Ok: false, Error: err.Error()}
	}
	return SaveRequestStoreResult{Ok: true}
}

func (a *App) SaveRequestStoreView(payload string) SaveRequestStoreResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	if err := saveRequestStoreView(requestStorePath(), payload); err != nil {
		return SaveRequestStoreResult{Ok: false, Error: err.Error()}
	}
	return SaveRequestStoreResult{Ok: true}
}

func (a *App) saveRequestStorePayload(payload string) error {
	root := fileWorkspaceStorePath()
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		return err
	}
	defer unlock()
	before, external, err := workspaceDisk.externalChanges(root)
	if err != nil {
		return err
	}
	if err := a.writeRequestStorePayload(root, payload); err != nil {
		return err
	}
	workspaceDisk.remember(root)
	if len(external) == 0 {
		return nil
	}
	if err := reapplyExternalChanges(root, before, external); err != nil {
		return err
	}
	a.emitWorkspaceChanged(workspaceExternalChangeNote)
	return nil
}

func (a *App) writeRequestStorePayload(root, payload string) error {
	localStoreAuthFailed := false
	if _, err := loadRequestStorePayload(requestStorePath()); err != nil && isRequestStoreAuthenticationError(err) {
		localStoreAuthFailed = true
	}
	if hasYAMLWorkspaceStore(root) {
		if localStoreAuthFailed {
			if _, backupErr := backupRequestStoreForRecovery(requestStorePath()); backupErr != nil {
				return fmt.Errorf("request store could not be decrypted and backup failed: %w", backupErr)
			}
			return saveKurloStorePayloadPreserving(requestStorePath(), root, payload, nil)
		}
		_, diagnostics, err := loadKurloStoreWithDiagnostics(requestStorePath(), root)
		if err != nil {
			if isRequestStoreAuthenticationError(err) {
				if _, backupErr := backupRequestStoreForRecovery(requestStorePath()); backupErr != nil {
					return fmt.Errorf("request store could not be decrypted and backup failed: %w", backupErr)
				}
				return saveKurloStorePayloadPreserving(requestStorePath(), root, payload, nil)
			}
			return err
		}
		return saveKurloStorePayloadPreserving(requestStorePath(), root, payload, diagnosticPreserveDirs(root, diagnostics))
	}
	return saveKurloStorePayload(requestStorePath(), root, payload)
}

func (a *App) GetVariables() map[string]string         { return a.state.GetVariables() }
func (a *App) GetEnvironment() map[string]string       { return a.state.GetEnvironment() }
func (a *App) SetVariable(key, value string)           { a.state.SetVariable(key, value) }
func (a *App) SetEnvironmentVar(key, value string)     { a.state.SetEnvironmentVar(key, value) }
func (a *App) SetEnvironment(values map[string]string) { a.state.SetEnvironment(values) }
func (a *App) SetVariables(values map[string]string)   { a.state.SetVariables(values) }
func (a *App) DeleteVariable(key string)               { a.state.DeleteVariable(key) }
func (a *App) ClearVariables()                         { a.state.ClearVariables() }

func (a *App) FetchOAuth2Token(cfg model.AuthConfig) model.OAuth2TokenResponse {
	if cfg.OAuth2GrantType == "password" {
		return auth.FetchTokenPassword(cfg)
	}
	return auth.FetchToken(cfg)
}

func (a *App) AuthorizeOAuth2(cfg model.AuthConfig) model.OAuth2TokenResponse {
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	return auth.AuthorizeCode(ctx, cfg, a.openAuthorizeURL)
}

func (a *App) AuthorizeOAuth2Device(cfg model.AuthConfig) model.OAuth2TokenResponse {
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	return auth.AuthorizeDevice(ctx, cfg, func(prompt model.OAuth2DevicePrompt) {
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, "oauth2:device-prompt", prompt)
		}
	}, a.openAuthorizeURL)
}

func (a *App) openAuthorizeURL(target string) error {
	if a.ctx != nil {
		runtime.BrowserOpenURL(a.ctx, target)
	}
	return nil
}

func (a *App) RefreshOAuth2Token(cfg model.AuthConfig) model.OAuth2TokenResponse {
	return auth.RefreshToken(cfg)
}

func (a *App) ListCookies(workspaceID string) []model.Cookie {
	return a.cookieJars.jar(workspaceID).ListCookies()
}

func (a *App) UpsertCookie(workspaceID string, cookie model.Cookie) model.CookieJarResult {
	cookies, err := a.cookieJars.jar(workspaceID).UpsertCookie(cookie)
	result := model.CookieJarResult{Cookies: cookies}
	if err != nil {
		result.Error = err.Error()
	}
	return result
}

func (a *App) DeleteCookie(workspaceID string, cookie model.Cookie) model.CookieJarResult {
	return model.CookieJarResult{Cookies: a.cookieJars.jar(workspaceID).DeleteCookie(cookie)}
}

func (a *App) ClearCookies(workspaceID string) []model.Cookie {
	return a.cookieJars.jar(workspaceID).ClearCookies()
}

func isDevBuild() bool {
	v := strings.TrimSpace(appVersion)
	return v == "" || v == "dev"
}

func (a *App) CheckForUpdate() model.UpdateCheckResult {
	if isDevBuild() {
		return model.UpdateCheckResult{}
	}
	ctx, cancel := context.WithTimeout(updateBaseContext(a.ctx), updateMetadataTimeout)
	defer cancel()
	info, err := checkForUpdate(ctx)
	if err != nil {
		return model.UpdateCheckResult{Error: friendlyUpdateError(err, "check for updates")}
	}
	if !semverIsNewer(info.Version, appVersion) {
		return model.UpdateCheckResult{}
	}
	return model.UpdateCheckResult{Info: info}
}

func (a *App) ApplyUpdate(info model.UpdateInfo) string {
	if isDevBuild() {
		return "Updates are disabled in development builds. Install a release build to receive updates."
	}
	if runningAsPackagedApp() {
		return friendlyUpdateError(errUpdateManagedByPackage, "install the update")
	}
	ctx, cancel := context.WithTimeout(updateBaseContext(a.ctx), updateDownloadTimeout)
	defer cancel()
	trusted, err := resolveTrustedUpdateInfo(ctx)
	if err != nil {
		return friendlyUpdateError(err, "install the update")
	}
	if requested := strings.TrimSpace(strings.TrimPrefix(info.Version, "v")); requested != "" {
		if requested != trusted.Version && !semverIsNewer(trusted.Version, requested) {
			return friendlyUpdateError(errUpdateVersionRollback, "install the update")
		}
	}
	if err := downloadAndApply(ctx, trusted); err != nil {
		return friendlyUpdateError(err, "install the update")
	}
	return ""
}

func updateBaseContext(ctx context.Context) context.Context {
	if ctx != nil {
		return ctx
	}
	return context.Background()
}

func (a *App) RestartApp() {
	relaunchSelf()
}

func (a *App) SendRequest(req model.HttpRequest) model.HttpResponse {
	baseCtx := context.Background()
	if a.ctx != nil {
		baseCtx = a.ctx
	}
	ctx, cancel := context.WithCancel(baseCtx)
	seq := a.registerRequestCancel(req.RequestID, cancel)
	defer func() {
		cancel()
		a.unregisterRequestCancel(req.RequestID, seq)
	}()
	return a.keepBinaryBodyOutOfTheWindow(req.RequestID, sendRequest(ctx, req, a.state, a.cookieJars, a.preflightCache))
}

type DownloadResult struct {
	Response  model.HttpResponse `json:"response"`
	SavedPath string             `json:"savedPath"`
}

func newResponseDownloadSink(path string, onCommit func()) (*responseBodySink, error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".kurlo-download-*.tmp")
	if err != nil {
		return nil, err
	}
	tmpPath := tmp.Name()
	closed := false
	closeFile := func() error {
		if closed {
			return nil
		}
		closed = true
		return tmp.Close()
	}
	return &responseBodySink{
		writer: tmp,
		commit: func() error {
			if err := tmp.Sync(); err != nil {
				_ = closeFile()
				return err
			}
			if err := closeFile(); err != nil {
				return err
			}
			if err := replaceFile(tmpPath, path); err != nil {
				return err
			}
			if err := syncDir(dir); err != nil {
				return err
			}
			if onCommit != nil {
				onCommit()
			}
			return nil
		},
		abort: func() {
			_ = closeFile()
			_ = os.Remove(tmpPath)
		},
	}, nil
}

func (a *App) SendRequestToFile(req model.HttpRequest, defaultName string) DownloadResult {
	baseCtx := context.Background()
	if a.ctx != nil {
		baseCtx = a.ctx
	}
	ctx, cancel := context.WithCancel(baseCtx)
	seq := a.registerRequestCancel(req.RequestID, cancel)
	defer func() {
		cancel()
		a.unregisterRequestCancel(req.RequestID, seq)
	}()
	stagedPath := ""
	stagedReady := false
	var stageErr error
	resp := sendRequestWithBodySink(ctx, req, a.state, a.cookieJars, a.preflightCache, func([]model.KeyValue) *responseBodySink {
		if a.ctx == nil {
			return nil
		}
		tmp, err := os.CreateTemp("", "kurlo-download-*")
		if err != nil {
			stageErr = err
			return nil
		}
		stagedPath = tmp.Name()
		closed := false
		closeFile := func() error {
			if closed {
				return nil
			}
			closed = true
			return tmp.Close()
		}
		return &responseBodySink{
			writer: tmp,
			commit: func() error {
				if err := tmp.Sync(); err != nil {
					_ = closeFile()
					return err
				}
				if err := closeFile(); err != nil {
					return err
				}
				stagedReady = true
				return nil
			},
			abort: func() {
				_ = closeFile()
				_ = os.Remove(stagedPath)
			},
		}
	})
	if stagedPath != "" {
		defer os.Remove(stagedPath)
	}
	if stageErr != nil {
		resp.Error = "failed to stage response body: " + stageErr.Error()
		return DownloadResult{Response: resp}
	}
	if !stagedReady || a.ctx == nil || resp.StatusCode == 0 {
		return DownloadResult{Response: resp}
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: downloadFilename(defaultName, resp.Headers),
		Title:           "Save response",
	})
	if err != nil || path == "" {
		return DownloadResult{Response: resp}
	}
	source, err := os.Open(stagedPath)
	if err != nil {
		resp.Error = "failed to save response body: " + err.Error()
		return DownloadResult{Response: resp}
	}
	defer source.Close()
	sink, err := newResponseDownloadSink(path, nil)
	if err != nil {
		resp.Error = "failed to save response body: " + err.Error()
		return DownloadResult{Response: resp}
	}
	if _, err := io.Copy(sink.writer, source); err != nil {
		sink.abort()
		resp.Error = "failed to save response body: " + err.Error()
		return DownloadResult{Response: resp}
	}
	if err := sink.commit(); err != nil {
		sink.abort()
		resp.Error = "failed to save response body: " + err.Error()
		return DownloadResult{Response: resp}
	}
	return DownloadResult{Response: resp, SavedPath: path}
}

func downloadFilename(defaultName string, headers []model.KeyValue) string {
	for _, h := range headers {
		if !strings.EqualFold(h.Key, "Content-Disposition") {
			continue
		}
		if _, params, err := mime.ParseMediaType(h.Value); err == nil {
			if fn := strings.TrimSpace(params["filename"]); fn != "" {
				return filepath.Base(fn)
			}
		}
	}
	name := strings.TrimSpace(defaultName)
	if name == "" {
		name = "response"
	}
	if filepath.Ext(name) == "" {
		if ext := extensionForContentType(contentTypeHeader(headers)); ext != "" {
			name += ext
		}
	}
	return name
}

func contentTypeHeader(headers []model.KeyValue) string {
	for _, h := range headers {
		if strings.EqualFold(h.Key, "Content-Type") {
			return h.Value
		}
	}
	return ""
}

func extensionForContentType(contentType string) string {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	switch mediaType {
	case "application/json":
		return ".json"
	case "text/html":
		return ".html"
	case "application/xml", "text/xml":
		return ".xml"
	case "text/plain":
		return ".txt"
	case "text/csv":
		return ".csv"
	case "application/pdf":
		return ".pdf"
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/svg+xml":
		return ".svg"
	case "application/zip":
		return ".zip"
	case "application/octet-stream":
		return ".bin"
	}
	if exts, _ := mime.ExtensionsByType(mediaType); len(exts) > 0 {
		return exts[0]
	}
	return ""
}

func (a *App) SendGrpcRequest(req model.GrpcRequest) model.GrpcResponse {
	baseCtx := context.Background()
	if a.ctx != nil {
		baseCtx = a.ctx
	}
	ctx, cancel := context.WithCancel(baseCtx)
	seq := a.registerRequestCancel(req.RequestID, cancel)
	defer func() {
		cancel()
		a.unregisterRequestCancel(req.RequestID, seq)
	}()
	return sendGrpcRequest(ctx, req, a.state, a.grpcEventEmitter())
}

func (a *App) grpcEventEmitter() grpcEventEmitter {
	if a.ctx == nil {
		return nil
	}
	return func(eventName string, payload any) {
		runtime.EventsEmit(a.ctx, eventName, payload)
	}
}

func (a *App) GrpcDiscover(req model.GrpcRequest) model.GrpcServiceDefinition {
	baseCtx := context.Background()
	if a.ctx != nil {
		baseCtx = a.ctx
	}
	ctx := baseCtx
	if req.TimeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(baseCtx, time.Duration(req.TimeoutMs)*time.Millisecond)
		defer cancel()
	}
	return discoverGrpcServices(ctx, req)
}

func (a *App) registerRequestCancel(requestID string, cancel context.CancelFunc) uint64 {
	if requestID == "" {
		return 0
	}
	a.requestMu.Lock()
	defer a.requestMu.Unlock()
	if existing, ok := a.requestCancels[requestID]; ok {
		existing.cancel()
	}
	a.requestSeq++
	seq := a.requestSeq
	a.requestCancels[requestID] = requestCancel{seq: seq, cancel: cancel}
	return seq
}

func (a *App) unregisterRequestCancel(requestID string, seq uint64) {
	if requestID == "" {
		return
	}
	a.requestMu.Lock()
	defer a.requestMu.Unlock()
	if existing, ok := a.requestCancels[requestID]; ok && existing.seq == seq {
		delete(a.requestCancels, requestID)
	}
}

func (a *App) CancelRequest(requestID string) {
	if requestID == "" {
		return
	}
	a.requestMu.Lock()
	existing, ok := a.requestCancels[requestID]
	if ok {
		delete(a.requestCancels, requestID)
	}
	a.requestMu.Unlock()
	if ok {
		existing.cancel()
	}
}

func (a *App) SSEConnect(sessionID string, req model.HttpRequest) {
	if a.ctx == nil {
		return
	}
	a.sse.connect(a.ctx, sessionID, req)
}

func (a *App) SSEDisconnect(sessionID string) {
	a.sse.disconnect(sessionID)
}

func (a *App) WebSocketConnect(sessionID string, req model.HttpRequest) {
	if a.ctx == nil {
		return
	}
	a.ws.connect(a.ctx, sessionID, req)
}

func (a *App) WebSocketDisconnect(sessionID string) {
	a.ws.disconnect(sessionID)
}

func (a *App) WebSocketSend(sessionID string, msg model.WebSocketSendMessage) model.WebSocketSendResult {
	return a.ws.send(sessionID, msg)
}

func (a *App) SocketIOConnect(sessionID string, req model.HttpRequest) {
	if a.ctx == nil {
		return
	}
	a.sio.connect(a.ctx, sessionID, req)
}

func (a *App) SocketIODisconnect(sessionID string) {
	a.sio.disconnect(sessionID)
}

func (a *App) SocketIOEmit(sessionID string, msg model.SocketIOEmitMessage) model.SocketIOEmitResult {
	return a.sio.emit(sessionID, msg)
}

func (a *App) StartMockServer(config model.MockServerConfig) model.MockServerStatus {
	if a.mock == nil {
		return model.MockServerStatus{Error: "mock server is unavailable"}
	}
	return a.mock.start(config, a.emitMockRequest)
}

func (a *App) StopMockServer() model.MockServerStatus {
	if a.mock == nil {
		return model.MockServerStatus{}
	}
	return a.mock.stop()
}

func (a *App) MockServerStatus() model.MockServerStatus {
	if a.mock == nil {
		return model.MockServerStatus{}
	}
	return a.mock.status()
}

func (a *App) MockServerLog() []model.MockRequestLog {
	if a.mock == nil {
		return []model.MockRequestLog{}
	}
	return a.mock.recentLog()
}

func (a *App) emitMockRequest(entry model.MockRequestLog) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, "mock:request", entry)
}
