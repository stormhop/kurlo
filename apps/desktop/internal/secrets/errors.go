package secrets

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
)

type Kind string

const (
	KindNotAuthenticated Kind = "not_authenticated"
	KindForbidden        Kind = "forbidden"
	KindNotFound         Kind = "not_found"
	KindUntrusted        Kind = "untrusted"
	KindToolMissing      Kind = "tool_missing"
	KindTimeout          Kind = "timeout"
	KindInvalidRef       Kind = "invalid_ref"
	KindUnavailable      Kind = "unavailable"
)

type Error struct {
	Kind     Kind
	Provider string
	Message  string
}

func (e *Error) Error() string {
	if e.Provider == "" {
		return e.Message
	}
	return e.Provider + ": " + e.Message
}

func newError(kind Kind, provider, format string, args ...any) *Error {
	return &Error{Kind: kind, Provider: provider, Message: fmt.Sprintf(format, args...)}
}

func KindOf(err error) Kind {
	var typed *Error
	if errors.As(err, &typed) {
		return typed.Kind
	}
	return KindUnavailable
}

func transportError(provider string, err error) *Error {
	if errors.Is(err, context.DeadlineExceeded) {
		return newError(KindTimeout, provider, "no answer before the timeout")
	}
	if errors.Is(err, context.Canceled) {
		return newError(KindUnavailable, provider, "cancelled")
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return newError(KindTimeout, provider, "no answer before the timeout")
	}
	return newError(KindUnavailable, provider, "%s", strings.TrimSpace(err.Error()))
}

type Failure struct {
	Ref Ref
	Err error
}

type ResolveError struct {
	Failures []Failure
}

func (e *ResolveError) Error() string {
	parts := make([]string, 0, len(e.Failures))
	for _, failure := range e.Failures {
		parts = append(parts, failure.Ref.String()+": "+failure.Err.Error())
	}
	return "cannot resolve linked secrets: " + strings.Join(parts, "; ")
}
