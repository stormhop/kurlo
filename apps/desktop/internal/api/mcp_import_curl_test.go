package api

import "testing"

func TestImportCurlCombinedShortFlags(t *testing.T) {
	tests := []struct {
		name      string
		source    string
		method    string
		redirects bool
		checkTLS  bool
		verifyTLS bool
	}{
		{name: "silent location", source: `curl -sSL https://example.test/a`, method: "GET", redirects: true},
		{name: "fail silent location", source: `curl -fsSL https://example.test/a`, method: "GET", redirects: true},
		{name: "silent insecure", source: `curl -sSk https://example.test/a`, method: "GET", checkTLS: true, verifyTLS: false},
		{name: "cluster then value flag", source: `curl -sSX POST https://example.test/a`, method: "POST"},
		{name: "cluster with attached method", source: `curl -sSXPUT https://example.test/a`, method: "PUT"},
		{name: "separate flags", source: `curl -sS -L https://example.test/a`, method: "GET", redirects: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request, err := importCurl(test.source)
			if err != nil {
				t.Fatal(err)
			}
			if got := stringValue(request, "url"); got != "https://example.test/a" {
				t.Fatalf("url = %q", got)
			}
			if got := stringValue(request, "method"); got != test.method {
				t.Fatalf("method = %q, want %q", got, test.method)
			}
			settings, _ := request["settings"].(map[string]any)
			if got, _ := settings["followRedirects"].(bool); got != test.redirects {
				t.Fatalf("followRedirects = %v, want %v", got, test.redirects)
			}
			if test.checkTLS {
				got, ok := settings["enableSSLVerification"].(bool)
				if !ok || got != test.verifyTLS {
					t.Fatalf("enableSSLVerification = %v (set %v), want %v", got, ok, test.verifyTLS)
				}
			}
		})
	}
}

func TestImportCurlDoesNotExpandOptionValues(t *testing.T) {
	request, err := importCurl(`curl -d -sS https://example.test/a`)
	if err != nil {
		t.Fatal(err)
	}
	if got := stringValue(request, "bodyContent"); got != "-sS" {
		t.Fatalf("bodyContent = %q", got)
	}
}
