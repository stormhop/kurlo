package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/auth"
	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/script"
	"github.com/stormhop/kurlo/apps/desktop/internal/util"
)

const maxFileBodySize = 256 * 1024 * 1024

var maxResponseBodySize int64 = 100 * 1024 * 1024

type responseBodySink struct {
	writer io.Writer
	commit func() error
	abort  func()
}

type responseBodySinkFactory func(headers []model.KeyValue) *responseBodySink

func sendRequest(requestCtx context.Context, req model.HttpRequest, sm *state.Manager, jars *cookieJarRegistry, cache *preflightCache) model.HttpResponse {
	return sendRequestWithBodySink(requestCtx, req, sm, jars, cache, nil)
}

func sendRequestWithBodySink(requestCtx context.Context, req model.HttpRequest, sm *state.Manager, jars *cookieJarRegistry, cache *preflightCache, sinkFactory responseBodySinkFactory) model.HttpResponse {
	return withResponseHeaders(runRequestWithBodySink(requestCtx, req, sm, jars, cache, sinkFactory))
}

func withResponseHeaders(resp model.HttpResponse) model.HttpResponse {
	if resp.Headers == nil {
		resp.Headers = []model.KeyValue{}
	}
	return resp
}

func runRequestWithBodySink(requestCtx context.Context, req model.HttpRequest, sm *state.Manager, jars *cookieJarRegistry, cache *preflightCache, sinkFactory responseBodySinkFactory) model.HttpResponse {
	var jar http.CookieJar
	if jars != nil {
		jar = jars.jar(req.WorkspaceID)
	}
	template := req
	if template.ResolveTemplates {
		resolved, err := resolveHTTPRequestTemplates(template, template.TemplateValues)
		if err != nil {
			return model.HttpResponse{Error: err.Error()}
		}
		req = resolved
	}
	var envDelta environmentDelta
	scope := beginScriptScope(sm, req.CollectionVariables)
	ctx := scope.ctx
	populateScriptRequestContext(ctx, req)
	populateScriptCookies(ctx, req, jars)
	ctx.Send = newScriptSender(requestCtx, req.AllowSendRequest, req)

	var preResult model.ScriptResult
	if req.PreRequestScript != "" {
		preResult = script.RunPreRequest(req.ScriptEngine, req.PreRequestScript, ctx)
		preResult = redactScriptResult(preResult, req.SecretEnvironmentValues)
		scriptedURL := ctx.RequestURL
		urlChanged := scriptedURL != "" && scriptedURL != req.URL
		if template.ResolveTemplates && preResult.Error == "" {
			if changed := scriptVariableChanges(scope, template.CollectionVariables); len(changed) > 0 {
				values := overlayScriptVariables(template.TemplateValues, ctx, changed)
				resolved, err := resolveHTTPRequestTemplates(template, values)
				if err != nil {
					envDelta.merge(scope.commit(sm))
					resp := model.HttpResponse{Error: err.Error(), PreRequestResult: preResult}
					resp.CollectionVariableUpdates, resp.CollectionVariablesRemoved = mergeCollectionVariableResults(preResult)
					envDelta.apply(&resp)
					return resp
				}
				resolved.SecretEnvironmentValues = append(resolved.SecretEnvironmentValues, revealedSecretValues(changed, template.SecretEnvironmentKeys, values)...)
				req = resolved
				preResult = redactScriptResult(preResult, req.SecretEnvironmentValues)
			}
		}
		if urlChanged {
			req.URL = scriptedURL
		}
		mergeScriptHeaders(ctx, &req)
		mergeScriptParams(ctx, &req)
		mergeScriptBody(ctx, &req)
		envDelta.merge(scope.commit(sm))
		if preResult.Error != "" {
			resp := model.HttpResponse{
				Error:            "pre-request script failed: " + preResult.Error,
				PreRequestResult: preResult,
			}
			resp.CollectionVariableUpdates, resp.CollectionVariablesRemoved = mergeCollectionVariableResults(preResult)
			envDelta.apply(&resp)
			return resp
		}
		if preResult.SkippedRequest {
			resp := model.HttpResponse{
				Skipped:          true,
				SkipReason:       "skipped by pm.execution.skipRequest()",
				PreRequestResult: preResult,
			}
			resp.CollectionVariableUpdates, resp.CollectionVariablesRemoved = mergeCollectionVariableResults(preResult)
			envDelta.apply(&resp)
			return resp
		}
	}

	resp := doRequestWithBodySink(requestCtx, req, jar, cache, sinkFactory)
	resp.PreRequestResult = preResult

	if req.TestScript != "" {
		testScope := beginScriptScope(sm, req.CollectionVariables)
		testCtx := testScope.ctx
		testCtx.Response = &resp
		populateScriptRequestContext(testCtx, req)
		populateScriptCookies(testCtx, req, jars)
		testCtx.Send = newScriptSender(requestCtx, req.AllowSendRequest, req)
		resp.TestResult = script.RunTests(req.ScriptEngine, req.TestScript, testCtx)
		resp.TestResult = redactScriptResult(resp.TestResult, req.SecretEnvironmentValues)
		envDelta.merge(testScope.commit(sm))
	}

	resp.CollectionVariableUpdates, resp.CollectionVariablesRemoved = mergeCollectionVariableResults(preResult, resp.TestResult)
	envDelta.apply(&resp)

	return resp
}

func mergeCollectionVariableResults(results ...model.ScriptResult) (map[string]string, []string) {
	var updates map[string]string
	removed := map[string]struct{}{}
	for _, result := range results {
		for key, value := range result.CollectionVariables {
			if updates == nil {
				updates = make(map[string]string)
			}
			updates[key] = value
			delete(removed, key)
		}
		for _, key := range result.CollectionVariablesRemoved {
			if updates != nil {
				delete(updates, key)
			}
			removed[key] = struct{}{}
		}
	}
	if len(removed) == 0 {
		return updates, nil
	}
	keys := make([]string, 0, len(removed))
	for key := range removed {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return updates, keys
}

type scriptStateScope struct {
	ctx        *script.Context
	beforeVars map[string]string
	beforeEnv  map[string]string
}

func beginScriptScope(sm *state.Manager, collectionVariables map[string]string) *scriptStateScope {
	vars, env := sm.Snapshot()
	beforeVars := util.CloneMap(vars)
	beforeEnv := util.CloneMap(env)
	ctx := script.NewContext(vars, env)
	ctx.DynamicVariable = resolveDynamicCLIVariable
	for key, value := range collectionVariables {
		ctx.CollectionVariables[key] = value
	}
	return &scriptStateScope{
		ctx:        ctx,
		beforeVars: beforeVars,
		beforeEnv:  beforeEnv,
	}
}

func (s *scriptStateScope) commit(sm *state.Manager) environmentDelta {
	sm.Merge(s.beforeVars, s.ctx.Variables, s.beforeEnv, s.ctx.Environment)
	var delta environmentDelta
	delta.add(s.beforeEnv, s.ctx.Environment)
	return delta
}

type environmentDelta struct {
	updates map[string]string
	removed map[string]bool
}

func (d *environmentDelta) add(before, after map[string]string) {
	for key, value := range after {
		if prev, ok := before[key]; ok && prev == value {
			continue
		}
		if d.updates == nil {
			d.updates = map[string]string{}
		}
		d.updates[key] = value
		delete(d.removed, key)
	}
	for key := range before {
		if _, ok := after[key]; ok {
			continue
		}
		if d.removed == nil {
			d.removed = map[string]bool{}
		}
		d.removed[key] = true
		delete(d.updates, key)
	}
}

func (d *environmentDelta) merge(other environmentDelta) {
	for key, value := range other.updates {
		d.add(map[string]string{}, map[string]string{key: value})
	}
	for key := range other.removed {
		d.add(map[string]string{key: ""}, map[string]string{})
	}
}

func (d environmentDelta) apply(resp *model.HttpResponse) {
	resp.EnvironmentUpdates = d.updates
	resp.EnvironmentRemoved = nil
	for key := range d.removed {
		resp.EnvironmentRemoved = append(resp.EnvironmentRemoved, key)
	}
	sort.Strings(resp.EnvironmentRemoved)
}

func redactScriptResult(result model.ScriptResult, secrets []string) model.ScriptResult {
	result.Error = redactSecrets(result.Error, secrets)
	for i, log := range result.Logs {
		result.Logs[i] = redactSecrets(log, secrets)
	}
	for i, test := range result.Tests {
		result.Tests[i].Error = redactSecrets(test.Error, secrets)
	}
	return result
}

func redactSecrets(text string, secrets []string) string {
	if text == "" || len(secrets) == 0 {
		return text
	}
	unique := make(map[string]struct{}, len(secrets))
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		unique[secret] = struct{}{}
	}
	ordered := make([]string, 0, len(unique))
	for secret := range unique {
		ordered = append(ordered, secret)
	}
	sort.Slice(ordered, func(i, j int) bool { return len(ordered[i]) > len(ordered[j]) })
	for _, secret := range ordered {
		text = strings.ReplaceAll(text, secret, "[secret]")
	}
	return text
}

func populateScriptRequestContext(ctx *script.Context, req model.HttpRequest) {
	ctx.RequestURL = req.URL
	ctx.RequestMethod = req.Method
	ctx.RequestBody = req.Body
	ctx.RequestBodyType = req.BodyType
	ctx.RequestBodyFilePath = req.BodyFilePath
	ctx.RequestFormData = append([]model.KeyValue(nil), req.FormData...)
	ctx.IterationData = req.IterationData
	ctx.Info = script.Info{
		RequestName:    req.Name,
		Iteration:      req.Iteration,
		IterationCount: req.IterationCount,
	}
	if req.ScriptTimeoutMs > 0 {
		ctx.Timeout = time.Duration(req.ScriptTimeoutMs) * time.Millisecond
	}
	for _, h := range req.Headers {
		if h.Enabled && h.Key != "" {
			ctx.RequestHeaders[h.Key] = h.Value
		}
	}
	for _, p := range req.Params {
		if p.Enabled && p.Key != "" {
			ctx.RequestParams[p.Key] = p.Value
		}
	}
}

func populateScriptCookies(ctx *script.Context, req model.HttpRequest, jars *cookieJarRegistry) {
	if jars == nil || req.DisableCookieJar {
		return
	}
	target, err := url.Parse(normalizeRequestURL(req.URL))
	if err != nil || target.Host == "" {
		return
	}
	jar := jars.jar(req.WorkspaceID)
	if jar == nil {
		return
	}
	for _, cookie := range jar.Cookies(target) {
		ctx.Cookies = append(ctx.Cookies, model.Cookie{Name: cookie.Name, Value: cookie.Value})
	}
}

func doRequestWithBodySink(ctx context.Context, req model.HttpRequest, jar http.CookieJar, cache *preflightCache, sinkFactory responseBodySinkFactory) model.HttpResponse {
	start := time.Now()
	traceCtx, timings := withResponseTiming(ctx, start)

	earlyError := func(msg string) model.HttpResponse {
		finish := time.Now()
		timings.markPrepared()
		return model.HttpResponse{
			Duration: finish.Sub(start).Milliseconds(),
			Timings:  timings.snapshot(finish),
			Error:    msg,
		}
	}

	rawURL := strings.TrimSpace(req.URL)
	if isBarePortLikeURL(rawURL) {
		return earlyError(invalidBarePortURLMessage("http"))
	}
	req.URL = normalizeRequestURL(req.URL)
	if strings.Contains(req.URL, "{{") {
		return earlyError("URL contains an unresolved variable — make sure all {{variables}} are defined in the active environment")
	}
	u, err := url.Parse(req.URL)
	if err != nil {
		return earlyError(fmt.Sprintf("invalid URL: %s", err))
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return earlyError(fmt.Sprintf("unsupported URL scheme %q. Use http:// or https://.", u.Scheme))
	}
	if u.Host == "" {
		return earlyError("invalid URL: missing host. Try http://localhost:3005/...")
	}
	if isNumericHostname(u.Hostname()) {
		return earlyError(invalidBarePortURLMessage("http"))
	}
	if msg := validateClientCertificate(req); msg != "" {
		return earlyError(msg)
	}

	applyQueryParams(u, req)

	body, bodyErr := buildRequestBody(req)
	if bodyErr != nil {
		return earlyError(bodyErr.Error())
	}
	if body.cleanup != nil {
		defer body.cleanup()
	}

	httpReq, err := http.NewRequestWithContext(traceCtx, req.Method, u.String(), body.reader)
	if err != nil {
		return earlyError(fmt.Sprintf("failed to build request: %s", err))
	}
	if body.length >= 0 {
		httpReq.ContentLength = body.length
	}
	if body.getBody != nil {
		httpReq.GetBody = body.getBody
	}

	if body.contentType != "" {
		httpReq.Header.Set("Content-Type", body.contentType)
	}
	if browserSecurityActive(req) {
		httpReq.Header.Set("User-Agent", browserLikeUserAgent)
	} else {
		httpReq.Header.Set("User-Agent", "Kurlo/"+appVersion)
	}
	hostOverride, droppedHeaders := applyUserHeaders(httpReq.Header, req.Headers)
	if hostOverride != "" {
		httpReq.Host = hostOverride
	}
	multipartNotice := reconcileMultipartContentType(httpReq.Header, body.contentType)
	explicitCookieHeader := httpReq.Header.Get("Cookie") != ""

	beforeAuth := userHeaderSnapshot(req.Headers, httpReq.Header)
	if err := auth.Apply(httpReq, req.Auth); err != nil {
		return earlyError("auth error: " + err.Error())
	}
	overriddenHeaders := changedUserHeaders(beforeAuth, httpReq.Header)
	browserCtx, err := prepareBrowserSecurity(req, httpReq.Header, u, browserKindFetch)
	if err != nil {
		return earlyError(err.Error())
	}
	if msg := validateBrowserCSP(req, u, browserCtx); msg != "" {
		return earlyError("CSP error: " + msg)
	}
	if msg := blockedBrowserNetworkAccess(u, browserCtx); msg != "" {
		return earlyError("Browser error: " + msg)
	}
	if browserCtx.active && browserCtx.crossOrigin && !browserCtx.withCredentials {
		req.DisableCookieJar = true
		httpReq.Header.Del("Cookie")
	}

	effectiveTimeout := effectiveRequestTimeout(req)
	requestJar := jar
	if explicitCookieHeader && !req.DisableCookieJar {
		requestJar = receiveOnlyCookieJar{jar: jar}
	}
	if browserCtx.active && !browserCtx.withCredentials && requestJar != nil && !req.DisableCookieJar {
		requestJar = browserCredentialsJar{jar: requestJar, state: &browserCtx}
	}
	client, sentRequests := buildHTTPClient(req, requestJar, effectiveTimeout, &browserCtx, cache)
	var browserHiddenHeaders, browserWarnings []string
	withTrace := func(resp model.HttpResponse) model.HttpResponse {
		resp.SentRequests = sentRequests.snapshot()
		resp.Connection = timings.connectionInfo()
		resp.Timeline = timings.timeline()
		if notice := droppedHeaderNotice(droppedHeaders); notice != "" {
			resp.Warnings = append(resp.Warnings, notice)
		}
		if notice := overriddenHeaderNotice(overriddenHeaders); notice != "" {
			resp.Warnings = append(resp.Warnings, notice)
		}
		if multipartNotice != "" {
			resp.Warnings = append(resp.Warnings, multipartNotice)
		}
		resp.Warnings = append(resp.Warnings, browserWarnings...)
		resp.BrowserHiddenHeaders = browserHiddenHeaders
		return resp
	}
	timings.markPrepared()
	if browserCtx.enforceCORS && corsPreflightRequired(httpReq) {
		preflightResp, corsMsg, networkErr := ensureCORSPreflight(traceCtx, client, httpReq, browserCtx, cache)
		if networkErr != nil {
			finish := time.Now()
			return withTrace(model.HttpResponse{
				Duration: finish.Sub(start).Milliseconds(),
				Timings:  timings.snapshot(finish),
				Error:    formatRequestError(fmt.Errorf("CORS preflight failed: %w", networkErr), u, effectiveTimeout),
			})
		}
		if corsMsg != "" {
			finish := time.Now()
			resp := model.HttpResponse{
				Duration: finish.Sub(start).Milliseconds(),
				Timings:  timings.snapshot(finish),
				Error:    "CORS error: " + corsMsg,
			}
			if preflightResp != nil {
				resp.StatusCode = preflightResp.StatusCode
				resp.Status = preflightResp.Status
				resp.Headers = httpHeadersToKeyValues(preflightResp.Header)
			}
			return withTrace(resp)
		}
	}
	httpResp, err := client.Do(httpReq)
	if err != nil {
		finish := time.Now()
		resp := model.HttpResponse{
			Duration: finish.Sub(start).Milliseconds(),
			Timings:  timings.snapshot(finish),
			Error:    formatRequestError(err, u, effectiveTimeout),
		}
		var blocked browserBlockedError
		if errors.As(err, &blocked) {
			resp.Error = blocked.Error()
		}
		return withTrace(resp)
	}
	defer httpResp.Body.Close()

	respHeaders := httpHeadersToKeyValues(httpResp.Header)
	if browserCtx.enforceCORS {
		if msg := validateCORSActualResponse(httpResp, browserCtx); msg != "" {
			finish := time.Now()
			return withTrace(model.HttpResponse{
				StatusCode: httpResp.StatusCode,
				Status:     httpResp.Status,
				Headers:    respHeaders,
				Duration:   finish.Sub(start).Milliseconds(),
				Timings:    timings.snapshot(finish),
				Error:      "CORS error: " + msg,
			})
		}
	}
	browserHiddenHeaders = corsUnexposedResponseHeaders(httpResp.Header, browserCtx)
	browserWarnings = browserNetworkAccessWarnings(httpResp.Request.URL, timings.connectionInfo().RemoteAddr, requestUsesProxy(req, httpResp.Request), browserCtx)

	if isEventStreamResponse(httpResp.Header) && !requestReadsEventStream(req) && strings.EqualFold(req.Method, http.MethodGet) {
		finish := time.Now()
		return withTrace(model.HttpResponse{
			StatusCode: httpResp.StatusCode,
			Status:     httpResp.Status,
			Headers:    respHeaders,
			Duration:   finish.Sub(start).Milliseconds(),
			Timings:    timings.snapshot(finish),
			Error:      "This endpoint returned an SSE stream. Switch to SSE mode to subscribe.",
		})
	}

	var (
		bodyBytes      []byte
		bodySize       int64
		truncated      bool
		readErr        error
		streamedToSink bool
	)
	if sinkFactory != nil {
		if sink := sinkFactory(respHeaders); sink != nil && sink.writer != nil {
			streamedToSink = true
			committed := false
			if sink.abort != nil {
				defer func() {
					if !committed {
						sink.abort()
					}
				}()
			}
			var preview bytes.Buffer
			decoded := newDecodingReader(httpResp.Body, httpResp)
			bodySize, truncated, readErr = copyResponseBody(&preview, sink.writer, decoded, maxResponseBodySize)
			bodyBytes = preview.Bytes()
			if readErr == nil && sink.commit != nil {
				readErr = sink.commit()
			}
			committed = readErr == nil
		}
	}
	if !streamedToSink {
		bodyBytes, truncated, readErr = readResponseBodyWithLimitHint(httpResp.Body, maxResponseBodySize, httpResp.ContentLength)
		bodySize = int64(len(bodyBytes))
		if readErr == nil && !truncated {
			if decoded, ok := decodeResponseBody(bodyBytes, httpResp); ok {
				bodyBytes = decoded
				bodySize = int64(len(bodyBytes))
			}
		}
	}
	finish := time.Now()
	duration := finish.Sub(start).Milliseconds()

	resp := model.HttpResponse{
		StatusCode: httpResp.StatusCode,
		Status:     httpResp.Status,
		Headers:    respHeaders,
		Body:       string(bodyBytes),
		Duration:   duration,
		Timings:    timings.snapshot(finish),
		Size:       bodySize,
	}
	resp.PreviewImageBase64, resp.PreviewMediaType = buildPreviewImage(bodyBytes, respHeaders, truncated)
	resp.BodyIsBinary, resp.BodySniffedType = classifyResponseBody(bodyBytes, respHeaders)
	switch {
	case readErr != nil:
		if streamedToSink {
			resp.Error = fmt.Sprintf("failed to save response body: %s", readErr)
		} else {
			resp.Error = fmt.Sprintf("failed to read response body: %s", readErr)
		}
	case truncated:
		shown := maxResponseBodySize / (1024 * 1024)
		if streamedToSink {
			total := bodySize / (1024 * 1024)
			resp.Error = fmt.Sprintf("response truncated — showing %d MB of %d MB", shown, total)
		} else if httpResp.ContentLength > 0 {
			resp.Size = httpResp.ContentLength
			total := httpResp.ContentLength / (1024 * 1024)
			resp.Error = fmt.Sprintf("response truncated — showing %d MB of %d MB", shown, total)
		} else {
			resp.Error = fmt.Sprintf("response truncated — showing first %d MB (total size unknown)", shown)
		}
	}
	return withTrace(resp)
}

func readResponseBodyWithLimitHint(body io.Reader, maxSize int64, sizeHint int64) ([]byte, bool, error) {
	if sizeHint <= 0 || sizeHint > maxSize {
		return readResponseBodyWithLimit(body, maxSize)
	}
	buffer := bytes.NewBuffer(make([]byte, 0, sizeHint+bytes.MinRead))
	_, readErr := buffer.ReadFrom(io.LimitReader(body, maxSize+1))
	bodyBytes := buffer.Bytes()
	if int64(len(bodyBytes)) <= maxSize {
		return bodyBytes, false, readErr
	}
	return bodyBytes[:int(maxSize)], true, readErr
}

func readResponseBodyWithLimit(body io.Reader, maxSize int64) ([]byte, bool, error) {
	bodyBytes, readErr := io.ReadAll(io.LimitReader(body, maxSize+1))
	if int64(len(bodyBytes)) <= maxSize {
		return bodyBytes, false, readErr
	}
	return bodyBytes[:int(maxSize)], true, readErr
}

func copyResponseBody(preview io.Writer, full io.Writer, body io.Reader, maxPreview int64) (size int64, truncated bool, err error) {
	buffer := make([]byte, 32*1024)
	var previewSize int64
	for {
		read, readErr := body.Read(buffer)
		if read > 0 {
			chunk := buffer[:read]
			size += int64(read)
			if full != nil {
				written, writeErr := full.Write(chunk)
				if writeErr != nil {
					return size, size > maxPreview, writeErr
				}
				if written != len(chunk) {
					return size, size > maxPreview, io.ErrShortWrite
				}
			}
			if preview != nil && previewSize < maxPreview {
				previewChunk := chunk
				if remaining := maxPreview - previewSize; int64(len(previewChunk)) > remaining {
					previewChunk = previewChunk[:remaining]
				}
				written, writeErr := preview.Write(previewChunk)
				if writeErr != nil {
					return size, size > maxPreview, writeErr
				}
				if written != len(previewChunk) {
					return size, size > maxPreview, io.ErrShortWrite
				}
				previewSize += int64(written)
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return size, size > maxPreview, nil
			}
			return size, size > maxPreview, readErr
		}
	}
}

func isEventStreamResponse(headers http.Header) bool {
	contentType := strings.ToLower(headers.Get("Content-Type"))
	return strings.Contains(contentType, "text/event-stream")
}

var rawBodyContentTypes = map[string]string{
	"json":       "application/json",
	"text":       "text/plain",
	"javascript": "application/javascript",
	"xml":        "application/xml",
	"html":       "text/html",
	"graphql":    "application/json",
}

type preparedBody struct {
	reader      io.Reader
	contentType string
	length      int64
	getBody     func() (io.ReadCloser, error)
	cleanup     func()
}

func noRequestBody() preparedBody {
	return preparedBody{length: -1}
}

func rawRequestBody(reader io.Reader, contentType string) preparedBody {
	return preparedBody{reader: reader, contentType: contentType, length: -1}
}

func buildRequestBody(req model.HttpRequest) (preparedBody, error) {
	if contentType, ok := rawBodyContentTypes[req.BodyType]; ok {
		if req.Body == "" {
			if methodConventionallyHasNoBody(req.Method) {
				return noRequestBody(), nil
			}
			return rawRequestBody(nil, contentType), nil
		}
		return rawRequestBody(strings.NewReader(req.Body), contentType), nil
	}
	switch req.BodyType {
	case "urlencoded":
		form := url.Values{}
		for _, kv := range req.FormData {
			if kv.Enabled && kv.Key != "" {
				form.Add(kv.Key, kv.Value)
			}
		}
		encoded := form.Encode()
		if encoded == "" && methodConventionallyHasNoBody(req.Method) {
			return noRequestBody(), nil
		}
		return rawRequestBody(strings.NewReader(encoded), "application/x-www-form-urlencoded"), nil
	case "form":
		if !multipartHasParts(req.FormData) && methodConventionallyHasNoBody(req.Method) {
			return noRequestBody(), nil
		}
		return buildMultipartRequestBody(req.FormData)
	case "binary":
		if req.BodyFilePath != "" {
			return buildFileRequestBody(req.BodyFilePath)
		}
	}
	return noRequestBody(), nil
}

func buildFileRequestBody(path string) (preparedBody, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return noRequestBody(), fmt.Errorf("failed to access file: %w", err)
	}
	if fi.IsDir() {
		return noRequestBody(), fmt.Errorf("failed to read file: %s is a directory", path)
	}
	if fi.Size() > maxFileBodySize {
		return noRequestBody(), fmt.Errorf("file too large (%.0f MB) — binary body limit is 256 MB", float64(fi.Size())/(1024*1024))
	}

	var (
		mu     sync.Mutex
		opened []*os.File
	)
	open := func() (io.ReadCloser, error) {
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		mu.Lock()
		opened = append(opened, file)
		mu.Unlock()
		return file, nil
	}
	first, err := open()
	if err != nil {
		return noRequestBody(), fmt.Errorf("failed to read file: %w", err)
	}
	length := fi.Size()
	if handle, ok := first.(*os.File); ok {
		if stat, statErr := handle.Stat(); statErr == nil {
			length = stat.Size()
		}
	}
	return preparedBody{
		reader:      first,
		contentType: "application/octet-stream",
		length:      length,
		getBody:     open,
		cleanup: func() {
			mu.Lock()
			defer mu.Unlock()
			for _, file := range opened {
				_ = file.Close()
			}
			opened = nil
		},
	}, nil
}

func methodConventionallyHasNoBody(method string) bool {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case "", http.MethodGet, http.MethodHead:
		return true
	}
	return false
}

func multipartHasParts(fields []model.KeyValue) bool {
	for _, kv := range fields {
		if kv.Enabled && kv.Key != "" {
			return true
		}
	}
	return false
}

func buildMultipartRequestBody(fields []model.KeyValue) (preparedBody, error) {
	if err := validateMultipartFiles(fields); err != nil {
		return noRequestBody(), err
	}
	boundary := multipart.NewWriter(io.Discard).Boundary()

	var (
		mu      sync.Mutex
		streams []*io.PipeReader
	)
	open := func() (io.ReadCloser, error) {
		reader := streamMultipartBody(fields, boundary)
		mu.Lock()
		streams = append(streams, reader)
		mu.Unlock()
		return reader, nil
	}
	first, _ := open()

	length, ok := multipartBodyLength(fields, boundary)
	if !ok {
		length = -1
	}
	return preparedBody{
		reader:      first,
		contentType: "multipart/form-data; boundary=" + boundary,
		length:      length,
		getBody:     open,
		cleanup: func() {
			mu.Lock()
			defer mu.Unlock()
			for _, reader := range streams {
				_ = reader.Close()
			}
			streams = nil
		},
	}, nil
}

func validateMultipartFiles(fields []model.KeyValue) error {
	for _, kv := range fields {
		if !kv.Enabled || kv.Key == "" {
			continue
		}
		if kv.IsFile && kv.Value != "" {
			fi, err := os.Stat(kv.Value)
			if err != nil {
				return fmt.Errorf("failed to read form file: %w", err)
			}
			if fi.IsDir() {
				return fmt.Errorf("failed to read form file: %s is a directory", kv.Value)
			}
			if fi.Size() > maxFileBodySize {
				return fmt.Errorf("form file too large (%.0f MB) — multipart file limit is 256 MB", float64(fi.Size())/(1024*1024))
			}
		}
	}
	return nil
}

func streamMultipartBody(fields []model.KeyValue, boundary string) *io.PipeReader {
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	_ = mw.SetBoundary(boundary)
	go func() {
		var err error
		defer func() {
			if err != nil {
				_ = pw.CloseWithError(err)
				return
			}
			_ = pw.Close()
		}()

		for _, kv := range fields {
			if !kv.Enabled || kv.Key == "" {
				continue
			}
			if err = writeMultipartPart(mw, kv); err != nil {
				return
			}
		}
		if err = mw.Close(); err != nil {
			err = fmt.Errorf("failed to finalize multipart body: %w", err)
		}
	}()
	return pr
}

func multipartPartHeader(kv model.KeyValue) textproto.MIMEHeader {
	disposition := fmt.Sprintf(`form-data; name="%s"`, escapeMultipartValue(kv.Key))
	contentType := strings.TrimSpace(kv.ContentType)
	if kv.IsFile && kv.Value != "" {
		fileName := kv.FileName
		if fileName == "" {
			fileName = filepath.Base(kv.Value)
		}
		disposition += fmt.Sprintf(`; filename="%s"`, escapeMultipartValue(fileName))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
	}
	header := make(textproto.MIMEHeader, 2)
	header.Set("Content-Disposition", disposition)
	if contentType != "" {
		header.Set("Content-Type", contentType)
	}
	return header
}

func writeMultipartPart(mw *multipart.Writer, kv model.KeyValue) error {
	part, err := mw.CreatePart(multipartPartHeader(kv))
	if err != nil {
		return fmt.Errorf("failed to create multipart field: %w", err)
	}
	if kv.IsFile && kv.Value != "" {
		file, err := os.Open(kv.Value)
		if err != nil {
			return fmt.Errorf("failed to read form file: %w", err)
		}
		defer file.Close()
		if _, err := io.Copy(part, file); err != nil {
			return fmt.Errorf("failed to write multipart file field: %w", err)
		}
		return nil
	}
	if _, err := io.WriteString(part, kv.Value); err != nil {
		return fmt.Errorf("failed to write multipart field: %w", err)
	}
	return nil
}

func multipartBodyLength(fields []model.KeyValue, boundary string) (int64, bool) {
	var total int64
	parts := 0
	for _, kv := range fields {
		if !kv.Enabled || kv.Key == "" {
			continue
		}
		var content int64
		if kv.IsFile && kv.Value != "" {
			fi, err := os.Stat(kv.Value)
			if err != nil {
				return 0, false
			}
			content = fi.Size()
		} else {
			content = int64(len(kv.Value))
		}
		if parts == 0 {
			total += int64(len("--" + boundary + "\r\n"))
		} else {
			total += int64(len("\r\n--" + boundary + "\r\n"))
		}
		total += multipartHeaderBlockLength(multipartPartHeader(kv))
		total += content
		parts++
	}
	return total + int64(len("\r\n--"+boundary+"--\r\n")), true
}

func multipartHeaderBlockLength(header textproto.MIMEHeader) int64 {
	var total int64
	for key, values := range header {
		for _, value := range values {
			total += int64(len(key) + len(": ") + len(value) + len("\r\n"))
		}
	}
	return total + int64(len("\r\n"))
}

var multipartValueEscaper = strings.NewReplacer("\\", "\\\\", `"`, "\\\"", "\r", "", "\n", "")

func escapeMultipartValue(value string) string {
	return multipartValueEscaper.Replace(value)
}

func effectiveRequestTimeout(req model.HttpRequest) time.Duration {
	if req.TimeoutMs > 0 {
		return time.Duration(req.TimeoutMs) * time.Millisecond
	}
	return 0
}

func buildHTTPClient(req model.HttpRequest, jar http.CookieJar, timeout time.Duration, browserCtx *browserSecurityContext, cache *preflightCache) (*http.Client, *sentRequestRecorder) {
	maxRedirects := req.MaxRedirects
	if maxRedirects <= 0 {
		maxRedirects = 10
	}

	transport := sharedHTTPTransport(req)
	recorder := newSentRequestRecorder(buildHTTPRoundTripper(req, transport), req.SecretEnvironmentValues)

	if req.DisableCookieJar {
		jar = nil
	}

	client := &http.Client{
		Timeout:   timeout,
		Transport: recorder,
		Jar:       jar,
	}
	client.CheckRedirect = buildRedirectPolicy(req, maxRedirects, browserCtx, func(ctx context.Context, next *http.Request) error {
		_, corsMsg, err := ensureCORSPreflight(ctx, client, next, *browserCtx, cache)
		if err != nil {
			return fmt.Errorf("CORS preflight failed: %w", err)
		}
		if corsMsg != "" {
			return browserBlockedError{label: "CORS", msg: corsMsg}
		}
		return nil
	})
	return client, recorder
}

func buildHTTPRoundTripper(req model.HttpRequest, transport *http.Transport) http.RoundTripper {
	var roundTripper http.RoundTripper = transport
	if req.Auth.Type == "digest" && req.Auth.Username != "" {
		roundTripper = auth.NewDigestTransport(req.Auth.Username, req.Auth.Password, transport)
	}
	return roundTripper
}

func buildRedirectPolicy(req model.HttpRequest, maxRedirects int, browserCtx *browserSecurityContext, preflight corsRedirectPreflight) func(*http.Request, []*http.Request) error {
	return func(next *http.Request, via []*http.Request) error {
		if !req.FollowRedirects {
			return http.ErrUseLastResponse
		}
		if len(via) >= maxRedirects {
			return http.ErrUseLastResponse
		}
		prev := via[len(via)-1]
		if req.FollowOriginalMethod {
			next.Method = prev.Method
			if err := replayRedirectBody(next, prev); err != nil {
				return err
			}
		}
		if authorization := prev.Header.Get("Authorization"); authorization != "" && redirectKeepsAuthorization(prev.URL, next.URL, req.FollowAuthorizationHeader) {
			next.Header.Set("Authorization", authorization)
		} else {
			next.Header.Del("Authorization")
		}
		if req.RemoveRefererHeader {
			next.Header.Del("Referer")
		}
		return browserCtx.followRedirect(req, next, via, preflight)
	}
}

func redirectKeepsAuthorization(prev, next *url.URL, followAcrossHosts bool) bool {
	if prev == nil || next == nil {
		return false
	}
	if strings.EqualFold(prev.Scheme, "https") && !strings.EqualFold(next.Scheme, "https") {
		return false
	}
	return followAcrossHosts || strings.EqualFold(prev.Hostname(), next.Hostname())
}

func applyQueryParams(u *url.URL, req model.HttpRequest) {
	pairs := parseRawQuery(u.RawQuery)
	if req.EncodeURLAutomatically {
		for i := range pairs {
			pairs[i].key = reencodeQueryComponent(pairs[i].key)
			if pairs[i].hasValue {
				pairs[i].value = reencodeQueryComponent(pairs[i].value)
			}
		}
	}
	for _, p := range req.Params {
		if p.Enabled && p.Key != "" {
			pairs = append(pairs, escapedQueryPair(p.Key, p.Value))
		}
	}
	if req.Auth.Type == "apikey" && req.Auth.KeyIn == "query" && req.Auth.KeyName != "" {
		pairs = append(pairs, escapedQueryPair(req.Auth.KeyName, req.Auth.KeyValue))
	}
	u.RawQuery = encodeQueryPairs(pairs)
}

func applyUserHeaders(headers http.Header, rows []model.KeyValue) (hostOverride string, dropped []string) {
	seen := make(map[string]struct{}, len(rows))
	for _, h := range rows {
		if !h.Enabled || h.Key == "" {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(h.Key), "host") {
			if host := strings.TrimSpace(h.Value); host != "" {
				hostOverride = host
			}
			continue
		}
		if isReservedFramingHeader(h.Key) {
			dropped = append(dropped, http.CanonicalHeaderKey(h.Key))
			continue
		}
		key := http.CanonicalHeaderKey(h.Key)
		normalized := strings.ToLower(key)
		if _, ok := seen[normalized]; !ok {
			headers.Del(key)
			seen[normalized] = struct{}{}
		}
		headers.Add(key, h.Value)
	}
	return hostOverride, dropped
}

func reconcileMultipartContentType(headers http.Header, generated string) string {
	if !strings.HasPrefix(generated, "multipart/form-data") {
		return ""
	}
	current := headers.Get("Content-Type")
	if current == generated {
		return ""
	}
	mediaType, params, err := mime.ParseMediaType(current)
	if err != nil || mediaType != "multipart/form-data" {
		return ""
	}
	headers.Set("Content-Type", generated)
	if params["boundary"] == "" {
		return ""
	}
	return "Content-Type boundary replaced: the form body is built by Kurlo, so it is sent with the boundary Kurlo generated for it."
}

func isReservedFramingHeader(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "transfer-encoding", "content-length", "connection", "upgrade",
		"keep-alive", "proxy-authenticate", "proxy-authorization", "te",
		"trailer":
		return true
	}
	return false
}

func droppedHeaderNotice(names []string) string {
	if len(names) == 0 {
		return ""
	}
	return fmt.Sprintf(
		"Not sent: %s. These headers control how the request is framed on the connection, so Kurlo sets them itself.",
		strings.Join(names, ", "),
	)
}

func userHeaderSnapshot(rows []model.KeyValue, headers http.Header) map[string][]string {
	snapshot := make(map[string][]string, len(rows))
	for _, row := range rows {
		if !row.Enabled || row.Key == "" {
			continue
		}
		key := http.CanonicalHeaderKey(strings.TrimSpace(row.Key))
		if key == "Host" {
			continue
		}
		if _, seen := snapshot[key]; seen {
			continue
		}
		snapshot[key] = append([]string(nil), headers.Values(key)...)
	}
	return snapshot
}

func changedUserHeaders(before map[string][]string, headers http.Header) []string {
	var changed []string
	for key, was := range before {
		if !slices.Equal(was, headers.Values(key)) {
			changed = append(changed, key)
		}
	}
	sort.Strings(changed)
	return changed
}

func overriddenHeaderNotice(names []string) string {
	if len(names) == 0 {
		return ""
	}
	return fmt.Sprintf(
		"Replaced by the Auth tab: %s. The value in the Headers tab was not sent — set Auth to \"No Auth\" to send your own.",
		strings.Join(names, ", "),
	)
}

func normalizeRequestURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.HasPrefix(trimmed, "{{") {
		return trimmed
	}
	if strings.HasPrefix(trimmed, "//") {
		return "http:" + trimmed
	}
	if !strings.Contains(trimmed, "://") {
		return "http://" + trimmed
	}
	return trimmed
}

func isBarePortLikeURL(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.HasPrefix(trimmed, "{{") || strings.HasPrefix(trimmed, "//") || strings.Contains(trimmed, "://") {
		return false
	}
	host := trimmed
	for _, sep := range []string{"/", "?", "#"} {
		if before, _, found := strings.Cut(host, sep); found {
			host = before
		}
	}
	if host == "" {
		return false
	}
	return isNumericHostname(host)
}

func isNumericHostname(host string) bool {
	if host == "" {
		return false
	}
	for _, ch := range host {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

func invalidBarePortURLMessage(scheme string) string {
	return fmt.Sprintf("invalid URL: enter a host. If this is a port, use %s://localhost:<port>.", scheme)
}

func formatRequestError(err error, target *url.URL, timeout time.Duration) string {
	if errors.Is(err, context.Canceled) {
		return "Request canceled"
	}
	var urlErr *url.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &urlErr) && urlErr.Timeout() {
		if timeout <= 0 {
			return "Error: request timed out"
		}
		return fmt.Sprintf("Error: request timed out after %d ms", timeout.Milliseconds())
	}

	lower := strings.ToLower(err.Error())
	targetAddr := requestErrorAddress(target)
	switch {
	case strings.Contains(lower, "connection refused"):
		return "Error: connect ECONNREFUSED " + targetAddr
	case strings.Contains(lower, "connection reset"):
		return "Error: read ECONNRESET " + targetAddr
	case strings.Contains(lower, "no route to host"), strings.Contains(lower, "ehostunreach"):
		return "Error: connect EHOSTUNREACH " + targetAddr
	case strings.Contains(lower, "network is unreachable"), strings.Contains(lower, "enetunreach"):
		return "Error: connect ENETUNREACH " + targetAddr
	case strings.Contains(lower, "i/o timeout"), strings.Contains(lower, "timeout awaiting response headers"), strings.Contains(lower, "tls handshake timeout"):
		return "Error: connect ETIMEDOUT " + targetAddr
	case strings.Contains(lower, "no such host"):
		return "Error: getaddrinfo ENOTFOUND " + target.Hostname()
	}

	message := strings.TrimSpace(err.Error())
	if strings.HasPrefix(message, "Error: ") {
		return message
	}
	return "Error: " + message
}

func requestErrorAddress(target *url.URL) string {
	host := target.Hostname()
	if strings.EqualFold(host, "localhost") {
		host = "127.0.0.1"
	}
	port := target.Port()
	if port == "" {
		if target.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return net.JoinHostPort(host, port)
}

func urlWithoutFragment(u *url.URL) string {
	if u == nil {
		return ""
	}
	noFrag := *u
	noFrag.Fragment = ""
	noFrag.RawFragment = ""
	return noFrag.String()
}

type queryPair struct {
	key      string
	value    string
	hasValue bool
}

func parseRawQuery(raw string) []queryPair {
	if raw == "" {
		return nil
	}
	segments := strings.Split(raw, "&")
	pairs := make([]queryPair, 0, len(segments))
	for _, segment := range segments {
		if segment == "" {
			continue
		}
		key, value, hasValue := strings.Cut(segment, "=")
		pairs = append(pairs, queryPair{key: key, value: value, hasValue: hasValue})
	}
	return pairs
}

func escapedQueryPair(key, value string) queryPair {
	return queryPair{key: url.QueryEscape(key), value: url.QueryEscape(value), hasValue: true}
}

func reencodeQueryComponent(raw string) string {
	decoded, err := url.QueryUnescape(raw)
	if err != nil {
		return url.QueryEscape(raw)
	}
	return url.QueryEscape(decoded)
}

func encodeQueryPairs(pairs []queryPair) string {
	var out strings.Builder
	for _, pair := range pairs {
		if out.Len() > 0 {
			out.WriteByte('&')
		}
		out.WriteString(pair.key)
		if pair.hasValue {
			out.WriteByte('=')
			out.WriteString(pair.value)
		}
	}
	return out.String()
}

func mergeScriptBody(ctx *script.Context, req *model.HttpRequest) {
	if ctx.RequestFormDataChanged && (req.BodyType == "urlencoded" || req.BodyType == "form") {
		req.FormData = ctx.RequestFormData
	}
	if !ctx.RequestBodyChanged || req.BodyFilePath != "" {
		return
	}
	if req.BodyType == "urlencoded" || req.BodyType == "form" {
		return
	}
	req.Body = ctx.RequestBody
	if req.Body != "" && (req.BodyType == "" || req.BodyType == "none" || req.BodyType == "binary") {
		if json.Valid([]byte(req.Body)) {
			req.BodyType = "json"
		} else {
			req.BodyType = "text"
		}
	}
}

func mergeScriptHeaders(ctx *script.Context, req *model.HttpRequest) {
	if len(ctx.RemovedHeaders) > 0 {
		next := make([]model.KeyValue, 0, len(req.Headers))
		for _, h := range req.Headers {
			if _, removed := ctx.RemovedHeaders[strings.ToLower(h.Key)]; removed {
				continue
			}
			next = append(next, h)
		}
		req.Headers = next
	}
	for _, key := range writtenKeys(ctx.RequestHeaders, ctx.TouchedHeaders, strings.ToLower) {
		req.Headers = upsertRow(req.Headers, key, ctx.RequestHeaders[key], strings.EqualFold)
	}
}

func mergeScriptParams(ctx *script.Context, req *model.HttpRequest) {
	if len(ctx.RemovedParams) > 0 {
		next := make([]model.KeyValue, 0, len(req.Params))
		for _, p := range req.Params {
			if _, removed := ctx.RemovedParams[p.Key]; removed {
				continue
			}
			next = append(next, p)
		}
		req.Params = next
	}
	sameKey := func(a, b string) bool { return a == b }
	for _, key := range writtenKeys(ctx.RequestParams, ctx.TouchedParams, func(s string) string { return s }) {
		req.Params = upsertRow(req.Params, key, ctx.RequestParams[key], sameKey)
	}
}

func writtenKeys(values map[string]string, touched map[string]struct{}, normalize func(string) string) []string {
	if len(touched) == 0 {
		return nil
	}
	keys := make([]string, 0, len(touched))
	for key := range values {
		if _, ok := touched[normalize(key)]; ok {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}

func upsertRow(rows []model.KeyValue, key, value string, matches func(string, string) bool) []model.KeyValue {
	target := -1
	for i, row := range rows {
		if !matches(row.Key, key) {
			continue
		}
		if target < 0 || (!rows[target].Enabled && row.Enabled) {
			target = i
		}
	}
	if target < 0 {
		return append(rows, model.KeyValue{Key: key, Value: value, Enabled: true})
	}
	next := make([]model.KeyValue, 0, len(rows))
	for i, row := range rows {
		if i == target {
			row.Value = value
			row.Enabled = true
			next = append(next, row)
			continue
		}
		if matches(row.Key, key) {
			continue
		}
		next = append(next, row)
	}
	return next
}
