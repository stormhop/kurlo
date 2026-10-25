package api

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fullstorydev/grpcurl"
	"github.com/golang/protobuf/proto"
	"github.com/golang/protobuf/protoc-gen-go/descriptor"
	"github.com/jhump/protoreflect/desc"
	"github.com/jhump/protoreflect/grpcreflect"
	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/script"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type grpcCompositeSource struct {
	reflection grpcurl.DescriptorSource
	file       grpcurl.DescriptorSource
}

type grpcEventEmitter func(eventName string, payload any)

func (cs grpcCompositeSource) ListServices() ([]string, error) {
	return cs.reflection.ListServices()
}

func (cs grpcCompositeSource) FindSymbol(fullyQualifiedName string) (desc.Descriptor, error) {
	d, err := cs.reflection.FindSymbol(fullyQualifiedName)
	if err == nil {
		return d, nil
	}
	return cs.file.FindSymbol(fullyQualifiedName)
}

func (cs grpcCompositeSource) AllExtensionsForType(typeName string) ([]*desc.FieldDescriptor, error) {
	exts, err := cs.reflection.AllExtensionsForType(typeName)
	if err != nil {
		return cs.file.AllExtensionsForType(typeName)
	}
	tags := make(map[int32]bool, len(exts))
	for _, ext := range exts {
		tags[ext.GetNumber()] = true
	}
	fileExts, err := cs.file.AllExtensionsForType(typeName)
	if err != nil {
		return exts, nil
	}
	for _, ext := range fileExts {
		if !tags[ext.GetNumber()] {
			exts = append(exts, ext)
		}
	}
	return exts, nil
}

type grpcInvokeHandler struct {
	requestID string
	startedAt time.Time
	formatter grpcurl.Formatter
	emit      grpcEventEmitter

	mu       sync.Mutex
	response *model.GrpcResponse
}

func (h *grpcInvokeHandler) OnResolveMethod(md *desc.MethodDescriptor) {
	h.mu.Lock()
	h.response.Method = grpcMethodInfo(md)
	h.mu.Unlock()
}

func (h *grpcInvokeHandler) OnSendHeaders(metadata.MD) {}

func (h *grpcInvokeHandler) OnReceiveHeaders(md metadata.MD) {
	h.mu.Lock()
	h.response.Headers = grpcMetadataToKeyValues(md)
	event := model.GrpcHeadersEvent{
		RequestID: h.requestID,
		Headers:   h.response.Headers,
		Method:    h.response.Method,
		Duration:  h.durationMs(),
		Timestamp: time.Now().UnixMilli(),
	}
	h.mu.Unlock()
	h.emitEvent("grpc:headers", event)
}

func (h *grpcInvokeHandler) appendMessage(msg model.GrpcMessage, countSize bool) model.GrpcMessageEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	msg.Index = len(h.response.Messages) + 1
	h.response.Messages = append(h.response.Messages, msg)
	if countSize {
		h.response.Size += int64(msg.Size)
	}
	return model.GrpcMessageEvent{
		RequestID: h.requestID,
		Message:   msg,
		Size:      h.response.Size,
		Duration:  h.durationMs(),
		Timestamp: time.Now().UnixMilli(),
	}
}

func (h *grpcInvokeHandler) OnReceiveResponse(resp proto.Message) {
	body, err := h.formatter(resp)
	if err != nil {
		body = fmt.Sprintf("Failed to format response message: %v", err)
	}
	h.emitEvent("grpc:message", h.appendMessage(model.GrpcMessage{
		Direction: "incoming",
		Body:      body,
		Size:      proto.Size(resp),
		Timestamp: time.Now().UnixMilli(),
	}, true))
}

func (h *grpcInvokeHandler) OnSendMessage(body string) {
	body = strings.TrimSpace(body)
	if body == "" {
		body = "{}"
	}
	h.emitEvent("grpc:message", h.appendMessage(model.GrpcMessage{
		Direction: "outgoing",
		Body:      body,
		Size:      len([]byte(body)),
		Timestamp: time.Now().UnixMilli(),
	}, false))
}

func (h *grpcInvokeHandler) OnReceiveTrailers(stat *status.Status, md metadata.MD) {
	h.mu.Lock()
	h.response.GrpcCode = stat.Code().String()
	h.response.GrpcMessage = stat.Message()
	h.response.Status = stat.Code().String()
	h.response.Trailers = grpcMetadataToKeyValues(md)
	if stat.Code() != codes.OK {
		if stat.Code() == codes.Canceled {
			h.response.GrpcMessage = "Cancelled on client"
			h.response.Error = "Request canceled"
		} else if stat.Message() != "" {
			h.response.Error = fmt.Sprintf("gRPC %s: %s", stat.Code().String(), stat.Message())
		} else {
			h.response.Error = "gRPC " + stat.Code().String()
		}
	}
	event := model.GrpcTrailersEvent{
		RequestID:   h.requestID,
		GrpcCode:    h.response.GrpcCode,
		GrpcMessage: h.response.GrpcMessage,
		Status:      h.response.Status,
		Trailers:    h.response.Trailers,
		Error:       h.response.Error,
		Duration:    h.durationMs(),
		Timestamp:   time.Now().UnixMilli(),
	}
	h.mu.Unlock()
	h.emitEvent("grpc:trailers", event)
}

func (h *grpcInvokeHandler) durationMs() int64 {
	if h.startedAt.IsZero() {
		return 0
	}
	return time.Since(h.startedAt).Milliseconds()
}

func (h *grpcInvokeHandler) emitEvent(eventName string, payload any) {
	if h.emit != nil && h.requestID != "" {
		h.emit(eventName, payload)
	}
}

func sendGrpcRequest(requestCtx context.Context, req model.GrpcRequest, sm *state.Manager, emit grpcEventEmitter) model.GrpcResponse {
	scope := beginScriptScope(sm, req.CollectionVariables)
	ctx := scope.ctx
	populateScriptGrpcRequestContext(ctx, req)
	ctx.Send = newScriptSender(requestCtx, req.AllowSendRequest, model.HttpRequest{EnableSSLVerification: req.EnableSSLVerification})

	var preResult model.ScriptResult
	if req.PreRequestScript != "" {
		preResult = script.RunPreRequest(req.ScriptEngine, req.PreRequestScript, ctx)
		preResult = redactScriptResult(preResult, req.SecretEnvironmentValues)
		mergeScriptGrpcRequestContext(ctx, &req)
		scope.commit(sm)
		if preResult.Error != "" {
			resp := model.GrpcResponse{
				Error:            "pre-request script failed: " + preResult.Error,
				PreRequestResult: preResult,
			}
			resp.CollectionVariableUpdates, resp.CollectionVariablesRemoved = mergeCollectionVariableResults(preResult)
			emitGrpcDone(emit, req.RequestID, resp)
			return resp
		}
	}

	resp := doGrpcRequest(requestCtx, req, emit)
	resp.PreRequestResult = preResult

	if req.TestScript != "" {
		testScope := beginScriptScope(sm, req.CollectionVariables)
		testCtx := testScope.ctx
		populateScriptGrpcRequestContext(testCtx, req)
		testCtx.Send = newScriptSender(requestCtx, req.AllowSendRequest, model.HttpRequest{EnableSSLVerification: req.EnableSSLVerification})
		testCtx.Response = grpcResponseAsHTTP(resp)
		resp.TestResult = script.RunTests(req.ScriptEngine, req.TestScript, testCtx)
		resp.TestResult = redactScriptResult(resp.TestResult, req.SecretEnvironmentValues)
		testScope.commit(sm)
	}

	resp.CollectionVariableUpdates, resp.CollectionVariablesRemoved = mergeCollectionVariableResults(preResult, resp.TestResult)
	emitGrpcDone(emit, req.RequestID, resp)
	return resp
}

func doGrpcRequest(ctx context.Context, req model.GrpcRequest, emit grpcEventEmitter) model.GrpcResponse {
	start := time.Now()
	resp := model.GrpcResponse{
		Headers:  []model.KeyValue{},
		Trailers: []model.KeyValue{},
		Messages: []model.GrpcMessage{},
	}

	if strings.TrimSpace(req.Target) == "" {
		resp.Error = "gRPC target is empty"
		return resp
	}
	if strings.TrimSpace(req.FullMethod) == "" {
		resp.Error = "Select a gRPC method before invoking the request"
		return resp
	}

	if req.TimeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(req.TimeoutMs)*time.Millisecond)
		defer cancel()
	}

	cc, refClient, source, cleanup, err := grpcPrepareSource(ctx, req, true)
	defer cleanup()
	if err != nil {
		resp.Duration = time.Since(start).Milliseconds()
		resp.Error = err.Error()
		return resp
	}

	rawMessage := strings.TrimSpace(req.Message)
	message := rawMessage
	if message == "" {
		message = "{}"
	}
	parser, formatter, err := grpcurl.RequestParserAndFormatter(grpcurl.FormatJSON, source, strings.NewReader(message), grpcurl.FormatOptions{
		EmitJSONDefaultFields: req.IncludeDefaultValues,
		AllowUnknownFields:    true,
	})
	if err != nil {
		resp.Duration = time.Since(start).Milliseconds()
		resp.Error = err.Error()
		return resp
	}

	handler := &grpcInvokeHandler{
		requestID: req.RequestID,
		startedAt: start,
		formatter: formatter,
		response:  &resp,
		emit:      emit,
	}
	outgoingBodies := grpcOutgoingMessageBodies(rawMessage)
	outgoingIndex := 0
	nextRequest := func(msg proto.Message) error {
		if err := parser.Next(msg); err != nil {
			return err
		}
		outgoingBody := ""
		if outgoingIndex < len(outgoingBodies) {
			outgoingBody = outgoingBodies[outgoingIndex]
		}
		outgoingIndex++
		if grpcShouldRecordOutgoingMessage(outgoingBody) {
			handler.OnSendMessage(outgoingBody)
		}
		return nil
	}
	err = grpcurl.InvokeRPC(ctx, source, cc, normalizeGrpcMethodName(req.FullMethod), grpcMetadataHeaders(req), handler, nextRequest)
	if refClient != nil {
		refClient.Reset()
	}
	resp.Duration = time.Since(start).Milliseconds()
	resp.Timestamp = time.Now().UnixMilli()
	resp.Body = grpcResponseBody(resp.Messages)
	if err != nil {
		resp.Error = err.Error()
		if ctx.Err() == context.Canceled {
			resp.GrpcCode = codes.Canceled.String()
			resp.Status = codes.Canceled.String()
			resp.Error = "Request canceled"
			resp.GrpcMessage = "Cancelled on client"
		} else if ctx.Err() == context.DeadlineExceeded {
			resp.GrpcCode = codes.DeadlineExceeded.String()
			resp.Status = codes.DeadlineExceeded.String()
			resp.Error = "gRPC " + codes.DeadlineExceeded.String() + ": deadline exceeded"
		} else if stat, ok := status.FromError(err); ok && stat.Code() == codes.Canceled {
			resp.GrpcCode = codes.Canceled.String()
			resp.Status = codes.Canceled.String()
			resp.Error = "Request canceled"
			resp.GrpcMessage = "Cancelled on client"
		} else if strings.Contains(strings.ToLower(err.Error()), "context canceled") {
			resp.GrpcCode = codes.Canceled.String()
			resp.Status = codes.Canceled.String()
			resp.Error = "Request canceled"
			resp.GrpcMessage = "Cancelled on client"
		}
	}
	if resp.GrpcCode == "" && resp.Error == "" {
		resp.GrpcCode = codes.OK.String()
		resp.Status = codes.OK.String()
	}
	return resp
}

func emitGrpcDone(emit grpcEventEmitter, requestID string, resp model.GrpcResponse) {
	if emit == nil || requestID == "" {
		return
	}
	emit("grpc:done", model.GrpcDoneEvent{
		RequestID: requestID,
		Response:  resp,
		Timestamp: time.Now().UnixMilli(),
	})
}

func discoverGrpcServices(ctx context.Context, req model.GrpcRequest) model.GrpcServiceDefinition {
	cc, refClient, source, cleanup, err := grpcPrepareSource(ctx, req, req.UseReflection)
	defer cleanup()
	if err != nil {
		return model.GrpcServiceDefinition{Error: err.Error()}
	}
	if refClient != nil {
		defer refClient.Reset()
	}
	_ = cc

	services, err := grpcurl.ListServices(source)
	if err != nil {
		return model.GrpcServiceDefinition{Error: err.Error()}
	}

	methods := make([]model.GrpcMethodInfo, 0)
	for _, service := range services {
		names, err := grpcurl.ListMethods(source, service)
		if err != nil {
			continue
		}
		for _, methodName := range names {
			d, err := source.FindSymbol(methodName)
			if err != nil {
				continue
			}
			md, ok := d.(*desc.MethodDescriptor)
			if !ok {
				continue
			}
			methods = append(methods, grpcMethodInfo(md))
		}
	}

	sourceLabel := "proto"
	hasTarget := strings.TrimSpace(req.Target) != ""
	hasProto := strings.TrimSpace(req.ProtoFilePath) != ""
	if req.UseReflection && hasTarget && hasProto {
		sourceLabel = "reflection + proto"
	} else if req.UseReflection && hasTarget {
		sourceLabel = "reflection"
	}
	return model.GrpcServiceDefinition{Source: sourceLabel, Services: services, Methods: methods}
}

func grpcPrepareSource(ctx context.Context, req model.GrpcRequest, allowReflection bool) (*grpc.ClientConn, *grpcreflect.Client, grpcurl.DescriptorSource, func(), error) {
	cleanup := func() {}
	var fileSource grpcurl.DescriptorSource
	if strings.TrimSpace(req.ProtoFilePath) != "" {
		importPaths := grpcImportPaths(req.ProtoFilePath, req.ProtoImportPaths)
		source, err := grpcurl.DescriptorSourceFromProtoFiles(importPaths, req.ProtoFilePath)
		if err != nil {
			return nil, nil, nil, cleanup, fmt.Errorf("failed to process .proto file: %w", err)
		}
		fileSource = source
	}

	needsReflection := allowReflection && req.UseReflection && strings.TrimSpace(req.Target) != ""
	if !needsReflection {
		if fileSource == nil {
			return nil, nil, nil, cleanup, fmt.Errorf("choose a .proto file or enable server reflection")
		}
		if allowReflection {
			cc, err := grpcDial(ctx, req)
			if err != nil {
				return nil, nil, nil, cleanup, err
			}
			cleanup = func() { _ = cc.Close() }
			return cc, nil, fileSource, cleanup, nil
		}
		return nil, nil, fileSource, cleanup, nil
	}

	cc, err := grpcDial(ctx, req)
	if err != nil {
		return nil, nil, nil, cleanup, err
	}
	cleanup = func() { _ = cc.Close() }
	md := grpcurl.MetadataFromHeaders(grpcMetadataHeaders(req))
	refCtx := metadata.NewOutgoingContext(ctx, md)
	refClient := grpcreflect.NewClientAuto(refCtx, cc)
	refClient.AllowMissingFileDescriptors()
	refSource := grpcurl.DescriptorSourceFromServer(ctx, refClient)
	if fileSource != nil {
		return cc, refClient, grpcCompositeSource{reflection: refSource, file: fileSource}, cleanup, nil
	}
	return cc, refClient, refSource, cleanup, nil
}

func grpcDial(ctx context.Context, req model.GrpcRequest) (*grpc.ClientConn, error) {
	target, useTLS, err := normalizeGrpcTarget(req.Target, req.UseTLS)
	if err != nil {
		return nil, err
	}
	creds := grpcCredentials(req, useTLS)
	opts := grpcDialOptions(req)
	cc, err := grpcurl.BlockingDial(ctx, "tcp", target, creds, opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to %s: %w", target, err)
	}
	return cc, nil
}

func grpcCredentials(req model.GrpcRequest, useTLS bool) credentials.TransportCredentials {
	if !useTLS {
		return nil
	}
	cfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if !req.EnableSSLVerification {
		cfg.InsecureSkipVerify = true
	}
	if strings.TrimSpace(req.ServerName) != "" {
		cfg.ServerName = strings.TrimSpace(req.ServerName)
	}
	return credentials.NewTLS(cfg)
}

func grpcDialOptions(req model.GrpcRequest) []grpc.DialOption {
	opts := []grpc.DialOption{}
	if authority := strings.TrimSpace(req.ServerName); authority != "" {
		opts = append(opts, grpc.WithAuthority(authority))
	}
	maxBytes := grpcMaxReceiveBytes(req.MaxResponseMessageSizeMb)
	if maxBytes > 0 {
		opts = append(opts, grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(maxBytes)))
	}
	return opts
}

func grpcMaxReceiveBytes(mb int) int {
	if mb < 0 {
		return 0
	}
	if mb == 0 {
		return math.MaxInt32
	}
	if mb > math.MaxInt32/(1024*1024) {
		return math.MaxInt32
	}
	return mb * 1024 * 1024
}

func normalizeGrpcTarget(raw string, defaultTLS bool) (string, bool, error) {
	value := strings.TrimSpace(raw)
	if strings.Contains(value, "{{") {
		return "", defaultTLS, fmt.Errorf("target contains an unresolved variable — make sure all {{variables}} are defined in the active environment")
	}
	if value == "" {
		return "", defaultTLS, fmt.Errorf("gRPC target is empty")
	}
	if strings.HasPrefix(value, "//") {
		value = "grpc:" + value
	}
	if strings.Contains(value, "://") {
		u, err := url.Parse(value)
		if err != nil {
			return "", defaultTLS, fmt.Errorf("invalid gRPC target: %w", err)
		}
		if u.Host == "" {
			return "", defaultTLS, fmt.Errorf("invalid gRPC target: missing host")
		}
		switch strings.ToLower(u.Scheme) {
		case "grpc":
			return u.Host, false, nil
		case "grpcs", "https":
			return u.Host, true, nil
		case "http":
			return u.Host, false, nil
		default:
			return "", defaultTLS, fmt.Errorf("unsupported gRPC target scheme %q. Use grpc://, grpcs://, or host:port.", u.Scheme)
		}
	}
	if slash := strings.Index(value, "/"); slash >= 0 {
		value = value[:slash]
	}
	if value == "" {
		return "", defaultTLS, fmt.Errorf("invalid gRPC target: missing host")
	}
	return value, defaultTLS, nil
}

func normalizeGrpcMethodName(method string) string {
	value := strings.TrimSpace(method)
	value = strings.TrimPrefix(value, "/")
	if strings.Contains(value, "/") {
		return value
	}
	if dot := strings.LastIndex(value, "."); dot > 0 && dot < len(value)-1 {
		return value[:dot] + "/" + value[dot+1:]
	}
	return value
}

func grpcMetadataHeaders(req model.GrpcRequest) []string {
	headers := make([]string, 0, len(req.Metadata)+2)
	for _, row := range req.Metadata {
		if row.Enabled && strings.TrimSpace(row.Key) != "" {
			headers = append(headers, fmt.Sprintf("%s: %s", row.Key, row.Value))
		}
	}
	auth := req.Auth
	switch auth.Type {
	case "bearer":
		if auth.Token != "" {
			headers = append(headers, "authorization: Bearer "+auth.Token)
		}
	case "oauth2":
		if auth.Token != "" {
			headers = append(headers, "authorization: Bearer "+auth.Token)
		}
	case "basic":
		if auth.Username != "" || auth.Password != "" {
			token := base64.StdEncoding.EncodeToString([]byte(auth.Username + ":" + auth.Password))
			headers = append(headers, "authorization: Basic "+token)
		}
	case "apikey":
		if auth.KeyName != "" {
			headers = append(headers, fmt.Sprintf("%s: %s", auth.KeyName, auth.KeyValue))
		}
	}
	return headers
}

func grpcImportPaths(protoFilePath string, input []string) []string {
	seen := map[string]bool{}
	var paths []string
	add := func(path string) {
		path = strings.TrimSpace(path)
		if path == "" {
			return
		}
		path = filepath.Clean(path)
		if seen[path] {
			return
		}
		seen[path] = true
		paths = append(paths, path)
	}
	if protoFilePath != "" {
		add(filepath.Dir(protoFilePath))
	}
	for _, path := range input {
		add(path)
	}
	return paths
}

func grpcMethodInfo(md *desc.MethodDescriptor) model.GrpcMethodInfo {
	service := md.GetService().GetFullyQualifiedName()
	return model.GrpcMethodInfo{
		FullName:        service + "/" + md.GetName(),
		Service:         service,
		Name:            md.GetName(),
		RequestType:     md.GetInputType().GetFullyQualifiedName(),
		ResponseType:    md.GetOutputType().GetFullyQualifiedName(),
		ExampleMessage:  grpcExampleMessage(md.GetInputType()),
		ClientStreaming: md.IsClientStreaming(),
		ServerStreaming: md.IsServerStreaming(),
	}
}

func grpcExampleMessage(md *desc.MessageDescriptor) string {
	if md == nil {
		return "{}"
	}
	value := grpcExampleObject(md, map[string]int{})
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return "{}"
	}
	return string(data)
}

func grpcExampleObject(md *desc.MessageDescriptor, seen map[string]int) map[string]interface{} {
	if md == nil {
		return map[string]interface{}{}
	}
	name := md.GetFullyQualifiedName()
	if seen[name] > 1 {
		return map[string]interface{}{}
	}
	seen[name]++
	defer func() { seen[name]-- }()

	value := make(map[string]interface{}, len(md.GetFields()))
	for _, field := range md.GetFields() {
		key := field.GetJSONName()
		if key == "" {
			key = field.GetName()
		}
		if field.IsMap() {
			value[key] = grpcExampleMapValue(field, seen)
			continue
		}
		fieldValue := grpcExampleFieldValue(field, seen)
		if field.IsRepeated() {
			value[key] = []interface{}{fieldValue}
			continue
		}
		value[key] = fieldValue
	}
	return value
}

func grpcExampleMapValue(field *desc.FieldDescriptor, seen map[string]int) map[string]interface{} {
	entry := field.GetMessageType()
	if entry == nil {
		return map[string]interface{}{}
	}
	fields := entry.GetFields()
	if len(fields) < 2 {
		return map[string]interface{}{}
	}
	key := fmt.Sprint(grpcExampleFieldValue(fields[0], seen))
	if key == "" || key == "0" || key == "false" {
		key = "key"
	}
	return map[string]interface{}{key: grpcExampleFieldValue(fields[1], seen)}
}

func grpcExampleFieldValue(field *desc.FieldDescriptor, seen map[string]int) interface{} {
	if field == nil {
		return nil
	}
	if msg := field.GetMessageType(); msg != nil && !field.IsMap() {
		return grpcExampleObject(msg, seen)
	}
	if enum := field.GetEnumType(); enum != nil {
		values := enum.GetValues()
		if len(values) > 0 {
			return values[0].GetName()
		}
		return ""
	}
	switch field.GetType() {
	case descriptor.FieldDescriptorProto_TYPE_BOOL:
		return false
	case descriptor.FieldDescriptorProto_TYPE_BYTES:
		return ""
	case descriptor.FieldDescriptorProto_TYPE_DOUBLE,
		descriptor.FieldDescriptorProto_TYPE_FLOAT:
		return 0
	case descriptor.FieldDescriptorProto_TYPE_FIXED32,
		descriptor.FieldDescriptorProto_TYPE_FIXED64,
		descriptor.FieldDescriptorProto_TYPE_INT32,
		descriptor.FieldDescriptorProto_TYPE_INT64,
		descriptor.FieldDescriptorProto_TYPE_SFIXED32,
		descriptor.FieldDescriptorProto_TYPE_SFIXED64,
		descriptor.FieldDescriptorProto_TYPE_SINT32,
		descriptor.FieldDescriptorProto_TYPE_SINT64,
		descriptor.FieldDescriptorProto_TYPE_UINT32,
		descriptor.FieldDescriptorProto_TYPE_UINT64:
		return 0
	case descriptor.FieldDescriptorProto_TYPE_STRING:
		return ""
	default:
		return nil
	}
}

func grpcMetadataToKeyValues(md metadata.MD) []model.KeyValue {
	keys := make([]string, 0, len(md))
	for key := range md {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	rows := make([]model.KeyValue, 0)
	for _, key := range keys {
		values := md[key]
		for _, value := range values {
			if strings.HasSuffix(strings.ToLower(key), "-bin") {
				value = base64.StdEncoding.EncodeToString([]byte(value))
			}
			rows = append(rows, model.KeyValue{Key: key, Value: value, Enabled: true})
		}
	}
	return rows
}

func grpcOutgoingMessageBodies(message string) []string {
	trimmed := strings.TrimSpace(message)
	if trimmed == "" {
		return []string{}
	}
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	bodies := make([]string, 0, 1)
	for {
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			break
		}
		body := strings.TrimSpace(string(raw))
		if body == "" {
			body = "{}"
		}
		bodies = append(bodies, body)
	}
	if len(bodies) == 0 {
		return []string{trimmed}
	}
	return bodies
}

func grpcShouldRecordOutgoingMessage(message string) bool {
	trimmed := strings.TrimSpace(message)
	if trimmed == "" {
		return false
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &raw); err == nil && len(raw) == 0 {
		return false
	}
	return true
}

func grpcResponseBody(messages []model.GrpcMessage) string {
	incoming := make([]model.GrpcMessage, 0, len(messages))
	for _, msg := range messages {
		if msg.Direction == "outgoing" {
			continue
		}
		incoming = append(incoming, msg)
	}
	if len(incoming) == 0 {
		return ""
	}
	if len(incoming) == 1 {
		return incoming[0].Body
	}
	raw := make([]json.RawMessage, 0, len(incoming))
	for _, msg := range incoming {
		raw = append(raw, json.RawMessage(msg.Body))
	}
	data, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		parts := make([]string, len(incoming))
		for i, msg := range incoming {
			parts[i] = msg.Body
		}
		return strings.Join(parts, "\n")
	}
	return string(data)
}

func populateScriptGrpcRequestContext(ctx *script.Context, req model.GrpcRequest) {
	ctx.RequestURL = req.Target
	ctx.RequestMethod = normalizeGrpcMethodName(req.FullMethod)
	ctx.Info = script.Info{RequestName: req.Name}
	if req.ScriptTimeoutMs > 0 {
		ctx.Timeout = time.Duration(req.ScriptTimeoutMs) * time.Millisecond
	}
	for _, row := range req.Metadata {
		if row.Enabled && row.Key != "" {
			ctx.RequestHeaders[row.Key] = row.Value
		}
	}
}

func mergeScriptGrpcRequestContext(ctx *script.Context, req *model.GrpcRequest) {
	req.Target = ctx.RequestURL
	rows := make([]model.KeyValue, 0, len(ctx.RequestHeaders))
	for key, value := range ctx.RequestHeaders {
		if _, removed := ctx.RemovedHeaders[strings.ToLower(key)]; removed {
			continue
		}
		rows = append(rows, model.KeyValue{Key: key, Value: value, Enabled: true})
	}
	sort.Slice(rows, func(i, j int) bool {
		return strings.ToLower(rows[i].Key) < strings.ToLower(rows[j].Key)
	})
	req.Metadata = rows
}

func grpcResponseAsHTTP(resp model.GrpcResponse) *model.HttpResponse {
	statusCode := 0
	if resp.GrpcCode == codes.OK.String() {
		statusCode = 200
	}
	headers := append([]model.KeyValue{}, resp.Headers...)
	headers = append(headers, resp.Trailers...)
	return &model.HttpResponse{
		StatusCode: statusCode,
		Status:     resp.GrpcCode,
		Headers:    headers,
		Body:       resp.Body,
		Duration:   resp.Duration,
		Size:       resp.Size,
		Error:      resp.Error,
	}
}
