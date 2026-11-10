package api

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/fullstorydev/grpcurl"
	"github.com/jhump/protoreflect/desc"
	"github.com/jhump/protoreflect/dynamic"
	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func resolveGrpcMethod(source grpcurl.DescriptorSource, fullMethod string) (*desc.MethodDescriptor, error) {
	service, name, ok := strings.Cut(normalizeGrpcMethodName(fullMethod), "/")
	if !ok || service == "" || name == "" {
		return nil, fmt.Errorf("select a gRPC method before invoking the request")
	}
	descriptor, err := source.FindSymbol(service)
	if err != nil {
		return nil, err
	}
	if svc, ok := descriptor.(*desc.ServiceDescriptor); ok {
		if method := svc.FindMethodByName(name); method != nil {
			return method, nil
		}
	}
	return nil, fmt.Errorf("gRPC method %s was not found", fullMethod)
}

func (s *agentLiveSession) runGRPC(req model.GrpcRequest, sm *state.Manager) {
	defer s.finish()
	resp := sendGrpcRequestWith(s.ctx, req, sm, nil, s.invokeGRPC, grpcRunIteration{})
	if resp.Error != "" {
		s.opened(fmt.Errorf("%s", resp.Error))
	} else if resp.Skipped {
		s.opened(fmt.Errorf("%s", resp.SkipReason))
	}
	s.push("close", map[string]any{
		"grpcCode": resp.GrpcCode, "grpcMessage": resp.GrpcMessage, "error": resp.Error,
		"skipped": resp.Skipped, "skipReason": resp.SkipReason,
		"trailers": mcpSafeHeaders(resp.Trailers, s.secrets), "durationMs": resp.Duration,
		"preRequestResult": resp.PreRequestResult, "testResult": resp.TestResult,
	})
}

func (s *agentLiveSession) invokeGRPC(ctx context.Context, req model.GrpcRequest, _ grpcEventEmitter) (resp model.GrpcResponse) {
	start := time.Now()
	defer func() { resp.Duration = time.Since(start).Milliseconds() }()
	cc, reflection, source, cleanup, err := grpcPrepareSource(ctx, req, true)
	defer cleanup()
	if err != nil {
		resp.Error = err.Error()
		return
	}
	if reflection != nil {
		defer reflection.Reset()
	}
	method, err := resolveGrpcMethod(source, req.FullMethod)
	if err != nil {
		resp.Error = err.Error()
		return
	}
	resp.Method = grpcMethodInfo(method)
	if !method.IsClientStreaming() && !method.IsServerStreaming() {
		resp.Error = "This gRPC method is unary; use run_request."
		return
	}
	streamCtx := metadata.NewOutgoingContext(ctx, grpcurl.MetadataFromHeaders(grpcMetadataHeaders(req)))
	stream, err := cc.NewStream(streamCtx, &grpc.StreamDesc{
		ClientStreams: method.IsClientStreaming(), ServerStreams: method.IsServerStreaming(),
	}, "/"+normalizeGrpcMethodName(req.FullMethod))
	if err != nil {
		resp.Error = err.Error()
		return
	}
	options := grpcurl.FormatOptions{EmitJSONDefaultFields: req.IncludeDefaultValues, AllowUnknownFields: true}
	_, format, err := grpcurl.RequestParserAndFormatter(grpcurl.FormatJSON, source, strings.NewReader(""), options)
	if err != nil {
		resp.Error = err.Error()
		return
	}
	ended := false
	send := func(data string, end bool) error {
		if ended {
			return fmt.Errorf("the gRPC send side is already closed")
		}
		if data != "" || !end {
			message := dynamic.NewMessage(method.GetInputType())
			data = defaultString(strings.TrimSpace(data), "{}")
			parser, _, err := grpcurl.RequestParserAndFormatter(grpcurl.FormatJSON, source, strings.NewReader(data), options)
			if err != nil {
				return err
			}
			if err := parser.Next(message); err != nil {
				return err
			}
			if err := parser.Next(dynamic.NewMessage(method.GetInputType())); err != io.EOF {
				return fmt.Errorf("provide exactly one JSON message")
			}
			if err := stream.SendMsg(message); err != nil {
				return err
			}
		}
		if end {
			ended = true
			return stream.CloseSend()
		}
		return nil
	}
	if method.IsClientStreaming() {
		s.grpcSend = send
	} else {
		if err := send(defaultString(req.Message, "{}"), true); err != nil {
			resp.Error = err.Error()
			return
		}
		s.grpcSend = func(string, bool) error {
			return fmt.Errorf("the saved message was already sent on this server stream")
		}
	}
	s.push("open", resp.Method)
	s.opened(nil)

	headers, err := stream.Header()
	resp.Headers = grpcMetadataToKeyValues(headers)
	if len(resp.Headers) > 0 {
		s.push("headers", mcpSafeHeaders(resp.Headers, s.secrets))
	}
	if err == nil {
		for index := 1; ; index++ {
			message := dynamic.NewMessage(method.GetOutputType())
			err = stream.RecvMsg(message)
			if err != nil {
				break
			}
			body, formatErr := format(message)
			if formatErr != nil {
				body = formatErr.Error()
			}
			event := model.GrpcMessage{Index: index, Direction: "incoming", Body: body, Size: len(body), Timestamp: time.Now().UnixMilli()}
			s.push("message", event)
			resp.Size += int64(event.Size)
			if req.TestScript != "" && index <= 64 {
				event.Body, _ = mcpTruncate(body, 65536)
				resp.Messages = append(resp.Messages, event)
			}
		}
	}
	resp.Trailers = grpcMetadataToKeyValues(stream.Trailer())
	resp.Body = grpcResponseBody(resp.Messages)
	stat := status.Convert(err)
	if err == io.EOF {
		stat = status.New(codes.OK, "")
	}
	resp.GrpcCode, resp.Status, resp.GrpcMessage = stat.Code().String(), stat.Code().String(), stat.Message()
	if stat.Code() != codes.OK {
		resp.Error = stat.Message()
	}
	return
}
