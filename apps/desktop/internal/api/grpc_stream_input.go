package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

var (
	errGrpcStreamEnded  = errors.New("the gRPC stream is already half-closed; no more messages can be sent")
	errGrpcStreamClosed = errors.New("the gRPC stream is closed")
	errGrpcStreamAbsent = errors.New("no gRPC stream is open for this request")
)

type grpcRejectedMessage struct {
	err error
}

func (r grpcRejectedMessage) Error() string { return r.err.Error() }

func (r grpcRejectedMessage) Unwrap() error { return r.err }

type grpcStreamItem struct {
	body   string
	result chan error
}

type grpcStreamInput struct {
	items    chan grpcStreamItem
	end      chan struct{}
	done     chan struct{}
	endOnce  sync.Once
	doneOnce sync.Once
}

func newGrpcStreamInput() *grpcStreamInput {
	return &grpcStreamInput{
		items: make(chan grpcStreamItem),
		end:   make(chan struct{}),
		done:  make(chan struct{}),
	}
}

func (in *grpcStreamInput) send(ctx context.Context, body string) error {
	select {
	case <-in.done:
		return errGrpcStreamClosed
	case <-in.end:
		return errGrpcStreamEnded
	default:
	}
	item := grpcStreamItem{body: body, result: make(chan error, 1)}
	select {
	case in.items <- item:
	case <-in.end:
		return errGrpcStreamEnded
	case <-in.done:
		return errGrpcStreamClosed
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-item.result:
		return err
	case <-in.done:
		select {
		case err := <-item.result:
			return err
		default:
		}
		return errGrpcStreamClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (in *grpcStreamInput) next(ctx context.Context, accept func(string) error) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		select {
		case item := <-in.items:
			err := accept(item.body)
			item.result <- err
			if err == nil {
				return nil
			}
		case <-in.end:
			if err := ctx.Err(); err != nil {
				return err
			}
			return io.EOF
		case <-in.done:
			if err := ctx.Err(); err != nil {
				return err
			}
			return io.EOF
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (in *grpcStreamInput) closeSend() {
	in.endOnce.Do(func() { close(in.end) })
}

func (in *grpcStreamInput) finish() {
	in.doneOnce.Do(func() { close(in.done) })
}

type grpcStreamSession struct {
	input       *grpcStreamInput
	workspaceID string
	ctx         context.Context

	mu     sync.Mutex
	linked []string
}

type grpcStreamOutgoing struct {
	Message string `json:"message"`
}

func (s *grpcStreamSession) send(message string) model.GrpcStreamSendResult {
	outgoing := grpcStreamOutgoing{Message: message}
	linked, err := resolveLinkedSecretsIn(s.ctx, linkedSecrets, s.workspaceID, &outgoing)
	if err != nil {
		return model.GrpcStreamSendResult{Error: linkedSecretErrorMessage(err)}
	}
	if len(linked) > 0 {
		s.mu.Lock()
		s.linked = append(s.linked, linked...)
		s.mu.Unlock()
	}
	bodies := grpcOutgoingMessageBodies(outgoing.Message)
	if len(bodies) == 0 {
		bodies = []string{"{}"}
	}
	result := model.GrpcStreamSendResult{}
	for index, body := range bodies {
		if err := s.input.send(s.ctx, body); err != nil {
			result.Recorded = errors.As(err, new(grpcRejectedMessage))
			if len(bodies) > 1 {
				err = fmt.Errorf("message %d: %w", index+1, err)
			}
			result.Error = err.Error()
			redactLinkedSecretValues(&result, linked)
			return result
		}
		result.Sent++
	}
	result.OK = true
	return result
}

func (s *grpcStreamSession) linkedValues() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.linked...)
}
