package api

import (
	"context"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	grpcTest "google.golang.org/grpc/interop/grpc_testing"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"
)

type interactiveGrpcServer struct {
	grpcTest.UnimplementedTestServiceServer
}

func (interactiveGrpcServer) StreamingInputCall(stream grpc.ClientStreamingServer[grpcTest.StreamingInputCallRequest, grpcTest.StreamingInputCallResponse]) error {
	total := 0
	for {
		msg, err := stream.Recv()
		if err == io.EOF {
			return stream.SendAndClose(&grpcTest.StreamingInputCallResponse{AggregatedPayloadSize: int32(total)})
		}
		if err != nil {
			return err
		}
		total += len(msg.GetPayload().GetBody())
	}
}

func (interactiveGrpcServer) FullDuplexCall(stream grpc.BidiStreamingServer[grpcTest.StreamingOutputCallRequest, grpcTest.StreamingOutputCallResponse]) error {
	for {
		msg, err := stream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if string(msg.GetPayload().GetBody()) == "stop" {
			return status.Error(codes.Aborted, "server stopped the stream")
		}
		if err := stream.Send(&grpcTest.StreamingOutputCallResponse{Payload: msg.Payload}); err != nil {
			return err
		}
	}
}

func startInteractiveGrpcServer(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	grpcTest.RegisterTestServiceServer(server, interactiveGrpcServer{})
	reflection.Register(server)
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	return listener.Addr().String()
}

type grpcEventLog struct {
	mu       sync.Mutex
	messages []model.GrpcMessage
	streams  []model.GrpcStreamEvent
	changed  chan struct{}
}

func newGrpcEventLog() *grpcEventLog {
	return &grpcEventLog{changed: make(chan struct{}, 64)}
}

func (l *grpcEventLog) emit(name string, payload any) {
	if name == "grpc:stream" {
		l.mu.Lock()
		l.streams = append(l.streams, payload.(model.GrpcStreamEvent))
		l.mu.Unlock()
		return
	}
	if name != "grpc:message" {
		return
	}
	l.mu.Lock()
	l.messages = append(l.messages, payload.(model.GrpcMessageEvent).Message)
	l.mu.Unlock()
	select {
	case l.changed <- struct{}{}:
	default:
	}
}

func (l *grpcEventLog) waitIncoming(t *testing.T, count int) []model.GrpcMessage {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		l.mu.Lock()
		incoming := []model.GrpcMessage{}
		for _, msg := range l.messages {
			if msg.Direction == "incoming" {
				incoming = append(incoming, msg)
			}
		}
		l.mu.Unlock()
		if len(incoming) >= count {
			return incoming
		}
		select {
		case <-l.changed:
		case <-deadline:
			t.Fatalf("waited for %d incoming messages, got %d", count, len(incoming))
		}
	}
}

func waitGrpcResponse(t *testing.T, done <-chan model.GrpcResponse) model.GrpcResponse {
	t.Helper()
	select {
	case resp := <-done:
		return resp
	case <-time.After(5 * time.Second):
		t.Fatal("interactive gRPC call did not finish")
		return model.GrpcResponse{}
	}
}

func waitGrpcStream(t *testing.T, app *App, requestID string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok := app.grpcStreams.Load(requestID); ok {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("interactive gRPC stream was not registered")
}

func TestInteractiveGrpcClientStreamSendsMessagesUntilEnd(t *testing.T) {
	target := startInteractiveGrpcServer(t)
	app := NewApp()
	done := make(chan model.GrpcResponse, 1)
	go func() {
		done <- app.SendGrpcRequest(model.GrpcRequest{
			RequestID:     "client-stream",
			Target:        target,
			FullMethod:    "grpc.testing.TestService/StreamingInputCall",
			Message:       `{"payload":{"body":"aWdub3JlZA=="}}`,
			Interactive:   true,
			UseReflection: true,
		})
	}()
	waitGrpcStream(t, app, "client-stream")
	if result := app.GrpcStreamSend("client-stream", `{"payload":{"body":"YWJj"}}`); !result.OK || result.Sent != 1 {
		t.Fatalf("first send = %#v", result)
	}
	if result := app.GrpcStreamSend("client-stream", `{"payload":{"body":"ZGVm"}} {"payload":{"body":"Z2g="}}`); !result.OK || result.Sent != 2 {
		t.Fatalf("batched send = %#v", result)
	}
	if result := app.GrpcStreamSend("client-stream", `{"payload":`); result.OK || result.Error == "" || !result.Recorded {
		t.Fatalf("invalid JSON was accepted: %#v", result)
	}
	if result := app.GrpcStreamSend("client-stream", `{"unknownField":1}`); !result.OK {
		t.Fatalf("send after a rejected message = %#v", result)
	}
	if result := app.GrpcStreamEnd("client-stream"); !result.OK {
		t.Fatalf("end = %#v", result)
	}
	resp := waitGrpcResponse(t, done)
	if resp.Error != "" || resp.GrpcCode != "OK" {
		t.Fatalf("response = %#v", resp)
	}
	if !strings.Contains(resp.Body, `"aggregatedPayloadSize": 8`) {
		t.Fatalf("server did not receive the streamed messages only: %s", resp.Body)
	}
	outgoing := 0
	for _, msg := range resp.Messages {
		if msg.Direction == "outgoing" {
			outgoing++
		}
	}
	if outgoing != 4 {
		t.Fatalf("outgoing messages = %d, want 4: %#v", outgoing, resp.Messages)
	}
	failures := 0
	for _, msg := range resp.Messages {
		if msg.Direction == "error" {
			failures++
		}
	}
	if failures != 1 || strings.Contains(resp.Body, "error") {
		t.Fatalf("rejected message is not recorded once outside the body: %#v", resp)
	}
	if result := app.GrpcStreamSend("client-stream", `{}`); result.OK || result.Error != errGrpcStreamAbsent.Error() {
		t.Fatalf("send after the call finished = %#v", result)
	}
}

func TestInteractiveGrpcBidiEchoesEachMessageBeforeEnd(t *testing.T) {
	target := startInteractiveGrpcServer(t)
	events := newGrpcEventLog()
	session := &grpcStreamSession{input: newGrpcStreamInput(), ctx: t.Context()}
	done := make(chan model.GrpcResponse, 1)
	go func() {
		done <- sendGrpcRequestWith(t.Context(), model.GrpcRequest{
			RequestID:     "bidi",
			Target:        target,
			FullMethod:    "grpc.testing.TestService/FullDuplexCall",
			Interactive:   true,
			UseReflection: true,
		}, state.New(), events.emit, doInteractiveGrpcRequest(session.input), grpcRunIteration{})
	}()
	if result := session.send(`{"payload":{"body":"b25l"}}`); !result.OK {
		t.Fatalf("first send = %#v", result)
	}
	if first := events.waitIncoming(t, 1); !strings.Contains(first[0].Body, "b25l") {
		t.Fatalf("first echo = %#v", first)
	}
	if result := session.send(`{"payload":{"body":"dHdv"}}`); !result.OK {
		t.Fatalf("second send = %#v", result)
	}
	if second := events.waitIncoming(t, 2); !strings.Contains(second[1].Body, "dHdv") {
		t.Fatalf("second echo = %#v", second)
	}
	session.input.closeSend()
	if result := session.send(`{}`); result.OK || result.Error != errGrpcStreamEnded.Error() {
		t.Fatalf("send after half-close = %#v", result)
	}
	resp := waitGrpcResponse(t, done)
	if resp.Error != "" || resp.GrpcCode != "OK" || len(resp.Messages) != 4 {
		t.Fatalf("response = %#v", resp)
	}
	events.mu.Lock()
	defer events.mu.Unlock()
	if len(events.streams) != 1 || events.streams[0].RequestID != "bidi" || !events.streams[0].Method.ClientStreaming || !events.streams[0].Method.ServerStreaming {
		t.Fatalf("stream events = %#v", events.streams)
	}
}

func TestInteractiveGrpcBidiFinishesWhenServerClosesFirst(t *testing.T) {
	target := startInteractiveGrpcServer(t)
	session := &grpcStreamSession{input: newGrpcStreamInput(), ctx: t.Context()}
	done := make(chan model.GrpcResponse, 1)
	go func() {
		done <- sendGrpcRequestWith(t.Context(), model.GrpcRequest{
			RequestID:     "bidi-stop",
			Target:        target,
			FullMethod:    "grpc.testing.TestService/FullDuplexCall",
			Interactive:   true,
			UseReflection: true,
		}, state.New(), nil, doInteractiveGrpcRequest(session.input), grpcRunIteration{})
	}()
	if result := session.send(`{"payload":{"body":"c3RvcA=="}}`); !result.OK {
		t.Fatalf("send = %#v", result)
	}
	resp := waitGrpcResponse(t, done)
	if resp.GrpcCode != codes.Aborted.String() || !strings.Contains(resp.Error, "server stopped the stream") {
		t.Fatalf("response = %#v", resp)
	}
	if result := session.send(`{}`); result.OK || result.Error != errGrpcStreamClosed.Error() {
		t.Fatalf("send after the server closed = %#v", result)
	}
}

func TestInteractiveGrpcCancelUnblocksAnOpenStream(t *testing.T) {
	target := startInteractiveGrpcServer(t)
	app := NewApp()
	done := make(chan model.GrpcResponse, 1)
	go func() {
		done <- app.SendGrpcRequest(model.GrpcRequest{
			RequestID:     "cancel-stream",
			Target:        target,
			FullMethod:    "grpc.testing.TestService/FullDuplexCall",
			Interactive:   true,
			UseReflection: true,
		})
	}()
	waitGrpcStream(t, app, "cancel-stream")
	app.CancelRequest("cancel-stream")
	resp := waitGrpcResponse(t, done)
	if resp.GrpcCode != codes.Canceled.String() || resp.Error != "Request canceled" {
		t.Fatalf("response = %#v", resp)
	}
}

func TestInteractiveFlagKeepsUnaryAndServerStreamingCallsUnchanged(t *testing.T) {
	target := startInteractiveGrpcServer(t)
	app := NewApp()
	resp := app.SendGrpcRequest(model.GrpcRequest{
		RequestID:     "unary",
		Target:        target,
		FullMethod:    "grpc.testing.TestService/EmptyCall",
		Interactive:   true,
		UseReflection: true,
	})
	if resp.GrpcCode != codes.Unimplemented.String() {
		t.Fatalf("unary call with the interactive flag = %#v", resp)
	}
}

func TestGrpcStreamInputStopsWaitingWhenContextEnds(t *testing.T) {
	input := newGrpcStreamInput()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := input.send(ctx, `{}`); err != context.Canceled {
		t.Fatalf("send on a canceled context = %v", err)
	}
	if err := input.next(ctx, func(string) error { return nil }); err != context.Canceled {
		t.Fatalf("next on a canceled context = %v", err)
	}
}
