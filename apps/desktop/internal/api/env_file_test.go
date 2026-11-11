package api

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseDotEnvReadsCommonSyntax(t *testing.T) {
	got := parseDotEnv(strings.Join([]string{
		"# comment",
		"// also a comment",
		"API_URL=https://api.test",
		"export TOKEN=abc123",
		`MSG="line\nnext\ttab \"q\" \\ end"`,
		`DIR="C:\\new\\tmp"`,
		`RAW='C:\new'`,
		`ODD="a\qb"`,
		"PLAIN=value # trailing note",
		"HASH=abc#def",
		"not a pair",
		"1BAD=x",
		"API_URL=https://override.test",
		"EMPTY=",
	}, "\r\n"))
	want := []EnvFileValue{
		{Key: "API_URL", Value: "https://override.test"},
		{Key: "TOKEN", Value: "abc123"},
		{Key: "MSG", Value: "line\nnext\ttab \"q\" \\ end"},
		{Key: "DIR", Value: `C:\new\tmp`},
		{Key: "RAW", Value: `C:\new`},
		{Key: "ODD", Value: `a\qb`},
		{Key: "PLAIN", Value: "value"},
		{Key: "HASH", Value: "abc#def"},
		{Key: "EMPTY", Value: ""},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseDotEnv = %#v\nwant %#v", got, want)
	}
}

func TestReadEnvFileForImportReadsAnyChosenFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env.local")
	if err := os.WriteFile(path, []byte("TOKEN=abc\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	values, err := readEnvFileForImport(path)
	if err != nil || len(values) != 1 || values[0].Value != "abc" {
		t.Fatalf("values = %#v, %v", values, err)
	}
	if _, err := readEnvFileForImport(dir); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("directory error = %v", err)
	}
	if _, err := readEnvFileForImport(filepath.Join(dir, "missing.env")); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("missing error = %v", err)
	}
	big := filepath.Join(dir, "big.env")
	if err := os.WriteFile(big, make([]byte, envImportLimit+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readEnvFileForImport(big); err == nil || !strings.Contains(err.Error(), "1 MiB") {
		t.Fatalf("big file error = %v", err)
	}
}
