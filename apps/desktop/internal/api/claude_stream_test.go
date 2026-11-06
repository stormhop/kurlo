package api

import (
	"errors"
	"io"
	"strings"
	"testing"
)

func TestReadClaudeStream(t *testing.T) {
	stream := strings.NewReader(`{"type":"system","subtype":"init","session_id":"session-1"}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}
{"type":"result","subtype":"success","result":"Hello"}`)
	var sessionID, text string
	err := readClaudeStream(stream, func(event claudeStreamEvent) error {
		if event.Type == "system" && event.Subtype == "init" {
			sessionID = event.SessionID
		}
		if event.Event.Delta.Type == "text_delta" {
			text += event.Event.Delta.Text
		}
		return nil
	})
	if err != nil || sessionID != "session-1" || text != "Hello" {
		t.Fatalf("session = %q, text = %q, error = %v", sessionID, text, err)
	}
}

func TestReadClaudeStreamRequiresResult(t *testing.T) {
	err := readClaudeStream(strings.NewReader(`{"type":"system"}`), func(claudeStreamEvent) error { return nil })
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("error = %v, want unexpected EOF", err)
	}
}
