package api

import (
	"reflect"
	"testing"
)

func TestMCPGetRequestMasksLiteralCredentialHeaders(t *testing.T) {
	rows := []cliKV{
		{Key: "Authorization", Value: "Bearer abc123", Enabled: true},
		{Key: "X-API-Key", Value: "raw-key", Enabled: true},
		{Key: "Cookie", Value: "{{sessionCookie}}", Enabled: true},
		{Key: "Accept", Value: "application/json", Enabled: true},
		{Key: "X-Token", Value: "flagged", Enabled: true, Secret: true},
	}
	got := mcpEnabledRows(rows, mcpSensitiveRequestHeaders)
	want := []mcpKeyValue{
		{Key: "Authorization", Value: "[secret]"},
		{Key: "X-API-Key", Value: "[secret]"},
		{Key: "Cookie", Value: "{{sessionCookie}}"},
		{Key: "Accept", Value: "application/json"},
		{Key: "X-Token", Value: "<secret>"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("headers = %+v, want %+v", got, want)
	}
	if params := mcpEnabledRows([]cliKV{{Key: "authorization", Value: "visible", Enabled: true}}, nil); params[0].Value != "visible" {
		t.Fatalf("rows without a sensitive set must stay as is: %+v", params)
	}
}
