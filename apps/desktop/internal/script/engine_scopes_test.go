package script

import (
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func jsCtx() *Context {
	ctx := NewContext(map[string]string{}, map[string]string{})
	ctx.RequestURL = "https://api.example.com/things"
	ctx.RequestMethod = "GET"
	return ctx
}

func runPre(t *testing.T, ctx *Context, src string) model.ScriptResult {
	t.Helper()
	result := RunPreRequest("js", src, ctx)
	if result.Error != "" {
		t.Fatalf("script error: %s", result.Error)
	}
	return result
}

func TestJSCollectionVariablesRead(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	ctx.CollectionVariables["baseUrl"] = "https://staging.example.com"
	runPre(t, ctx, `pm.request.set_url(pm.collectionVariables.get("baseUrl") + "/v1")`)
	if ctx.RequestURL != "https://staging.example.com/v1" {
		t.Errorf("url = %q", ctx.RequestURL)
	}
}

func TestJSCollectionVariablesWriteIsReported(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	ctx.CollectionVariables["keep"] = "untouched"
	ctx.CollectionVariables["drop"] = "gone-soon"
	result := runPre(t, ctx, `
		pm.collectionVariables.set("token", "abc123")
		pm.collectionVariables.unset("drop")
	`)

	if got := result.CollectionVariables["token"]; got != "abc123" {
		t.Errorf("reported collection variables = %#v, want token=abc123", result.CollectionVariables)
	}
	if _, reported := result.CollectionVariables["keep"]; reported {
		t.Errorf("unchanged variable was reported as written: %#v", result.CollectionVariables)
	}
	if len(result.CollectionVariablesRemoved) != 1 || result.CollectionVariablesRemoved[0] != "drop" {
		t.Errorf("removals = %#v, want [drop]", result.CollectionVariablesRemoved)
	}
}

func TestJSCollectionVariablesAreSeparateFromGlobals(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	runPre(t, ctx, `
		pm.collectionVariables.set("scoped", "collection")
		pm.variables.set("scoped", "session")
	`)
	if got := ctx.CollectionVariables["scoped"]; got != "collection" {
		t.Errorf("collection scope = %q, want collection", got)
	}
	if got := ctx.Variables["scoped"]; got != "session" {
		t.Errorf("session scope = %q, want session", got)
	}
}

func TestJSGlobalsAliasTheSessionScope(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	ctx.Variables["existing"] = "from-session"
	result := runPre(t, ctx, `
		pm.test("globals read the session scope", () => pm.expect(pm.globals.get("existing")).to.equal("from-session"))
		pm.globals.set("written", "via-globals")
		pm.test("pm.variables sees it too", () => pm.expect(pm.variables.get("written")).to.equal("via-globals"))
	`)
	for _, test := range result.Tests {
		if !test.Passed {
			t.Errorf("test %q failed: %s", test.Name, test.Error)
		}
	}
	if ctx.Variables["written"] != "via-globals" {
		t.Errorf("pm.globals.set did not reach the session scope: %#v", ctx.Variables)
	}
}

func TestJSVariablesResolutionOrder(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	ctx.Variables["k"] = "global"
	ctx.CollectionVariables["k"] = "collection"
	ctx.Environment["k"] = "environment"
	ctx.IterationData = map[string]string{"k": "data"}

	result := runPre(t, ctx, `pm.test("data wins", () => pm.expect(pm.variables.get("k")).to.equal("data"))`)
	assertAllPassed(t, result)

	ctx.IterationData = nil
	result = runPre(t, jsCtxWith(ctx), `pm.test("environment next", () => pm.expect(pm.variables.get("k")).to.equal("environment"))`)
	assertAllPassed(t, result)

	delete(ctx.Environment, "k")
	result = runPre(t, jsCtxWith(ctx), `pm.test("collection next", () => pm.expect(pm.variables.get("k")).to.equal("collection"))`)
	assertAllPassed(t, result)

	delete(ctx.CollectionVariables, "k")
	result = runPre(t, jsCtxWith(ctx), `pm.test("global last", () => pm.expect(pm.variables.get("k")).to.equal("global"))`)
	assertAllPassed(t, result)
}

func jsCtxWith(src *Context) *Context {
	next := NewContext(src.Variables, src.Environment)
	next.CollectionVariables = src.CollectionVariables
	next.IterationData = src.IterationData
	next.RequestURL = src.RequestURL
	next.RequestMethod = src.RequestMethod
	return next
}

func assertAllPassed(t *testing.T, result model.ScriptResult) {
	t.Helper()
	if len(result.Tests) == 0 {
		t.Fatal("no assertions ran")
	}
	for _, test := range result.Tests {
		if !test.Passed {
			t.Errorf("test %q failed: %s", test.Name, test.Error)
		}
	}
}

func TestJSInfo(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	ctx.Info = Info{RequestName: "Create user", Iteration: 2, IterationCount: 5}
	result := runPre(t, ctx, `
		pm.test("name", () => pm.expect(pm.info.requestName).to.equal("Create user"))
		pm.test("iteration", () => pm.expect(pm.info.iteration).to.equal(2))
		pm.test("count", () => pm.expect(pm.info.iterationCount).to.equal(5))
		pm.test("event", () => pm.expect(pm.info.eventName).to.equal("prerequest"))
	`)
	assertAllPassed(t, result)
}

func TestJSInfoEventNameInTestScript(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	ctx.Response = &model.HttpResponse{StatusCode: 200, Body: "{}"}
	result := RunTests("js", `pm.test("event", () => pm.expect(pm.info.eventName).to.equal("test"))`, ctx)
	if result.Error != "" {
		t.Fatalf("script error: %s", result.Error)
	}
	assertAllPassed(t, result)
}

func TestJSCookies(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	ctx.Cookies = []model.Cookie{{Name: "session", Value: "s-1"}, {Name: "csrf", Value: "c-9"}}
	result := runPre(t, ctx, `
		pm.test("get", () => pm.expect(pm.cookies.get("session")).to.equal("s-1"))
		pm.test("has", () => pm.expect(pm.cookies.has("csrf")).to.be.true)
		pm.test("missing has", () => pm.expect(pm.cookies.has("nope")).to.be.false)
		pm.test("missing get", () => pm.expect(pm.cookies.get("nope")).to.be.undefined)
		pm.test("names", () => pm.expect(pm.cookies.names()).to.have.lengthOf(2))
	`)
	assertAllPassed(t, result)
}

func TestJSSkipRequest(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	result := runPre(t, ctx, `if (pm.variables.get("mode") !== "live") pm.execution.skipRequest()`)
	if !result.SkippedRequest {
		t.Error("skipRequest() should mark the run as skipped")
	}
	if result.Error != "" {
		t.Errorf("skipping must not be an error, got %q", result.Error)
	}
}

func TestJSSkipRequestNotSetWhenNotCalled(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	result := runPre(t, ctx, `pm.variables.set("x", "1")`)
	if result.SkippedRequest {
		t.Error("SkippedRequest should be false when the script never calls it")
	}
}

func TestJSSkipRequestIgnoredInTestScript(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	ctx.Response = &model.HttpResponse{StatusCode: 200}
	result := RunTests("js", `pm.execution.skipRequest()`, ctx)
	if result.SkippedRequest {
		t.Error("skipRequest() in a test script should be ignored")
	}
}

func TestJSCryptoHashes(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	result := runPre(t, ctx, `
		pm.test("md5", () => pm.expect(pm.crypto.md5("")).to.equal("d41d8cd98f00b204e9800998ecf8427e"))
		pm.test("sha1", () => pm.expect(pm.crypto.sha1("abc")).to.equal("a9993e364706816aba3e25717850c26c9cd0d89d"))
		pm.test("sha256", () => pm.expect(pm.crypto.sha256("abc")).to.equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"))
		pm.test("sha512 length", () => pm.expect(pm.crypto.sha512("abc")).to.have.lengthOf(128))
		pm.test("base64 encoding", () => pm.expect(pm.crypto.sha256("abc", "base64")).to.equal("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="))
		pm.test("named hash", () => pm.expect(pm.crypto.hash("sha256", "abc")).to.equal(pm.crypto.sha256("abc")))
	`)
	assertAllPassed(t, result)
}

func TestJSCryptoHMACVector(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	result := runPre(t, ctx, `
		pm.test("rfc4231 case 2", () => pm.expect(pm.crypto.hmacSha256("what do ya want for nothing?", "Jefe"))
			.to.equal("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"))
		pm.test("named hmac", () => pm.expect(pm.crypto.hmac("sha256", "what do ya want for nothing?", "Jefe"))
			.to.equal(pm.crypto.hmacSha256("what do ya want for nothing?", "Jefe")))
	`)
	assertAllPassed(t, result)
}

func TestJSCryptoBase64AndRandom(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	result := runPre(t, ctx, `
		pm.test("encode", () => pm.expect(pm.crypto.base64Encode("kurlo")).to.equal("a3VybG8="))
		pm.test("roundtrip", () => pm.expect(pm.crypto.base64Decode(pm.crypto.base64Encode("hello"))).to.equal("hello"))
		pm.test("randomHex length", () => pm.expect(pm.crypto.randomHex(8)).to.have.lengthOf(16))
		pm.test("randomHex differs", () => pm.expect(pm.crypto.randomHex(8)).to.not.equal(pm.crypto.randomHex(8)))
		pm.test("uuid shape", () => pm.expect(pm.crypto.uuid()).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
	`)
	assertAllPassed(t, result)
}

func TestJSCryptoUnknownAlgorithmThrows(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	result := RunPreRequest("js", `pm.crypto.hash("sha3", "x")`, ctx)
	if result.Error == "" {
		t.Fatal("an unknown algorithm must fail loudly, not sign with an empty digest")
	}
	if !strings.Contains(result.Error, "sha3") {
		t.Errorf("error should name the bad algorithm, got %q", result.Error)
	}
}

func TestJSCryptoJSShim(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	result := runPre(t, ctx, `
		pm.test("SHA256 hex", () => pm.expect(CryptoJS.SHA256("abc").toString())
			.to.equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"))
		pm.test("HmacSHA256 hex", () => pm.expect(CryptoJS.HmacSHA256("what do ya want for nothing?", "Jefe").toString())
			.to.equal("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"))
		pm.test("enc.Hex.stringify", () => pm.expect(CryptoJS.enc.Hex.stringify(CryptoJS.SHA256("abc")))
			.to.equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"))
		pm.test("enc.Base64.stringify", () => pm.expect(CryptoJS.enc.Base64.stringify(CryptoJS.SHA256("abc")))
			.to.equal("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="))
		pm.test("MD5", () => pm.expect(CryptoJS.MD5("").toString()).to.equal("d41d8cd98f00b204e9800998ecf8427e"))
	`)
	assertAllPassed(t, result)
}

func TestJSCryptoJSSigningPattern(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	ctx.Environment["apiSecret"] = "top-secret"
	runPre(t, ctx, `
		const ts = "1700000000"
		const canonical = pm.request.method + "\n" + ts
		const sig = CryptoJS.HmacSHA256(canonical, pm.environment.get("apiSecret")).toString()
		pm.request.headers.set("X-Timestamp", ts)
		pm.request.headers.set("X-Signature", sig)
	`)
	if ctx.RequestHeaders["X-Timestamp"] != "1700000000" {
		t.Errorf("timestamp header missing: %#v", ctx.RequestHeaders)
	}
	sig := ctx.RequestHeaders["X-Signature"]
	if len(sig) != 64 {
		t.Errorf("signature should be a 64-char hex HMAC, got %q", sig)
	}
	expected, err := hmacDigest("sha256", "top-secret", "GET\n1700000000")
	if err != nil {
		t.Fatal(err)
	}
	if sig != encodeDigest(expected, "hex") {
		t.Errorf("signature = %q, want %q", sig, encodeDigest(expected, "hex"))
	}
}

func TestJSTimeoutOverrideAllowsLongerScript(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	src := `
		const start = Date.now()
		while (Date.now() - start < 250) { }
		pm.variables.set("done", "yes")
	`
	short := jsCtx()
	short.Timeout = 50 * time.Millisecond
	if result := RunPreRequest("js", src, short); result.Error == "" {
		t.Error("expected the script to hit the configured timeout")
	}

	ctx.Timeout = 5 * time.Second
	if result := RunPreRequest("js", src, ctx); result.Error != "" {
		t.Errorf("override should have allowed the script to finish, got %q", result.Error)
	}
	if ctx.Variables["done"] != "yes" {
		t.Error("script did not run to completion under the override")
	}
}

func TestResolveTimeout(t *testing.T) {
	t.Parallel()

	if got := resolveTimeout(0); got != 2*time.Second {
		t.Errorf("zero should mean the default, got %s", got)
	}
	if got := resolveTimeout(-5); got != 2*time.Second {
		t.Errorf("negative should mean the default, got %s", got)
	}
	if got := resolveTimeout(10 * time.Second); got != 10*time.Second {
		t.Errorf("a sane override should pass through, got %s", got)
	}
	if got := resolveTimeout(10 * time.Minute); got != maxScriptExecutionTimeout {
		t.Errorf("an over-large override should clamp to %s, got %s", maxScriptExecutionTimeout, got)
	}
}

func TestJSSendRequestDisabledByDefault(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	result := RunPreRequest("js", `pm.sendRequest("https://example.com")`, ctx)
	if result.Error == "" {
		t.Fatal("pm.sendRequest must be unavailable unless it is explicitly enabled")
	}
	if !strings.Contains(result.Error, "disabled") {
		t.Errorf("error should explain how to enable it, got %q", result.Error)
	}
}

func TestJSSendRequestSynchronousForm(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	var got SendRequest
	ctx.Send = func(req SendRequest) SendResponse {
		got = req
		return SendResponse{
			StatusCode: 200,
			Status:     "200 OK",
			Body:       `{"token":"tok-42"}`,
			Headers:    map[string]string{"Content-Type": "application/json"},
			DurationMs: 12,
			Size:       18,
		}
	}
	runPre(t, ctx, `
		const res = pm.sendRequest({ method: "POST", url: "https://auth.example.com/token", header: { "X-Client": "kurlo" }, body: "grant=x" })
		pm.variables.set("token", res.json().token)
		pm.variables.set("code", String(res.code))
		pm.variables.set("ct", res.headers.get("content-type"))
	`)
	if got.Method != "POST" || got.URL != "https://auth.example.com/token" {
		t.Errorf("request not passed through: %#v", got)
	}
	if got.Headers["X-Client"] != "kurlo" {
		t.Errorf("headers not passed through: %#v", got.Headers)
	}
	if got.Body != "grant=x" {
		t.Errorf("body = %q", got.Body)
	}
	if ctx.Variables["token"] != "tok-42" {
		t.Errorf("json() did not parse: %#v", ctx.Variables)
	}
	if ctx.Variables["code"] != "200" {
		t.Errorf("code = %q", ctx.Variables["code"])
	}
	if ctx.Variables["ct"] != "application/json" {
		t.Errorf("case-insensitive header lookup failed: %q", ctx.Variables["ct"])
	}
}

func TestJSSendRequestCallbackForm(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	ctx.Send = func(SendRequest) SendResponse {
		return SendResponse{StatusCode: 201, Status: "201 Created", Body: `{"id":7}`}
	}
	runPre(t, ctx, `
		pm.sendRequest("https://example.com/things", function (err, res) {
			if (err) { pm.variables.set("err", String(err.message)); return }
			pm.variables.set("id", String(res.json().id))
			pm.variables.set("code", String(res.code))
		})
	`)
	if ctx.Variables["err"] != "" {
		t.Fatalf("unexpected callback error: %s", ctx.Variables["err"])
	}
	if ctx.Variables["id"] != "7" || ctx.Variables["code"] != "201" {
		t.Errorf("callback did not receive the response: %#v", ctx.Variables)
	}
}

func TestJSSendRequestStringURLDefaultsToGET(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	var got SendRequest
	ctx.Send = func(req SendRequest) SendResponse {
		got = req
		return SendResponse{StatusCode: 200, Body: "ok"}
	}
	runPre(t, ctx, `pm.sendRequest("https://example.com/ping")`)
	if got.Method != "GET" {
		t.Errorf("method = %q, want GET", got.Method)
	}
	if got.URL != "https://example.com/ping" {
		t.Errorf("url = %q", got.URL)
	}
}

func TestJSSendRequestTransportError(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	ctx.Send = func(SendRequest) SendResponse {
		return SendResponse{Error: "dial tcp: connection refused"}
	}
	runPre(t, ctx, `
		pm.sendRequest("https://down.example.com", function (err, res) {
			pm.variables.set("err", err ? String(err.message) : "")
			pm.variables.set("hasRes", res ? "yes" : "no")
		})
	`)
	if !strings.Contains(ctx.Variables["err"], "connection refused") {
		t.Errorf("callback error = %q", ctx.Variables["err"])
	}
	if ctx.Variables["hasRes"] != "no" {
		t.Error("a failed call must not hand the script a response object")
	}
}

func TestJSSendRequestNon2xxIsNotAnError(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	ctx.Send = func(SendRequest) SendResponse {
		return SendResponse{StatusCode: 404, Status: "404 Not Found", Body: `{"error":"nope"}`}
	}
	result := runPre(t, ctx, `
		const res = pm.sendRequest("https://example.com/missing")
		pm.test("status is surfaced", () => pm.expect(res.code).to.equal(404))
		pm.test("body is readable", () => pm.expect(res.json().error).to.equal("nope"))
	`)
	assertAllPassed(t, result)
}

func TestJSSendRequestHeaderArrayForm(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	var got SendRequest
	ctx.Send = func(req SendRequest) SendResponse {
		got = req
		return SendResponse{StatusCode: 200}
	}
	runPre(t, ctx, `
		pm.sendRequest({
			url: "https://example.com",
			method: "POST",
			header: [{ key: "Authorization", value: "Bearer abc" }, { key: "Accept", value: "application/json" }],
			body: { mode: "raw", raw: "{\"a\":1}" }
		})
	`)
	if got.Headers["Authorization"] != "Bearer abc" || got.Headers["Accept"] != "application/json" {
		t.Errorf("array-form headers not parsed: %#v", got.Headers)
	}
	if got.Body != `{"a":1}` {
		t.Errorf("raw body mode not parsed: %q", got.Body)
	}
}

func TestJSSendRequestRequiresURL(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	ctx.Send = func(SendRequest) SendResponse { return SendResponse{StatusCode: 200} }
	result := RunPreRequest("js", `pm.sendRequest({ method: "GET" })`, ctx)
	if result.Error == "" {
		t.Fatal("expected an error when no url is given")
	}
}

func captureSend(t *testing.T, src string) SendRequest {
	t.Helper()
	ctx := jsCtx()
	var got SendRequest
	ctx.Send = func(req SendRequest) SendResponse {
		got = req
		return SendResponse{StatusCode: 200, Body: "{}"}
	}
	runPre(t, ctx, src)
	return got
}

func TestJSSendRequestPostmanHeaderForms(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"string":          `header: "Content-Type: application/json\nX-Trace: 1"`,
		"string array":    `header: ["Content-Type: application/json", "X-Trace: 1"]`,
		"key value array": `header: [{ key: "Content-Type", value: "application/json" }, { key: "X-Trace", value: 1 }]`,
		"object":          `header: { "Content-Type": "application/json", "X-Trace": "1" }`,
		"headers alias":   `headers: { "Content-Type": "application/json", "X-Trace": "1" }`,
	}
	for name, header := range cases {
		t.Run(name, func(t *testing.T) {
			got := captureSend(t, `pm.sendRequest({ url: "https://example.com", method: "POST", `+header+`, body: { mode: "raw", raw: "{}" } })`)
			if got.Headers["Content-Type"] != "application/json" || got.Headers["X-Trace"] != "1" {
				t.Errorf("headers = %#v", got.Headers)
			}
		})
	}
}

func TestJSSendRequestSkipsDisabledHeaders(t *testing.T) {
	t.Parallel()

	got := captureSend(t, `pm.sendRequest({
		url: "https://example.com", method: "POST",
		header: [{ key: "Content-Type", value: "application/json" }, { key: "Content-Type", value: "text/xml", disabled: true }],
		body: { mode: "raw", raw: "{}" }
	})`)
	if got.Headers["Content-Type"] != "application/json" {
		t.Errorf("disabled header was sent: %#v", got.Headers)
	}
}

func TestJSSendRequestRawLanguageSetsContentType(t *testing.T) {
	t.Parallel()

	got := captureSend(t, `pm.sendRequest({ url: "https://example.com", method: "POST", body: { mode: "raw", raw: "{\"a\":1}", options: { raw: { language: "json" } } } })`)
	if got.Headers["Content-Type"] != "application/json" {
		t.Errorf("headers = %#v", got.Headers)
	}

	got = captureSend(t, `pm.sendRequest({ url: "https://example.com", method: "POST", header: { "content-type": "application/vnd.api+json" }, body: { mode: "raw", raw: "{}", options: { raw: { language: "json" } } } })`)
	if len(got.Headers) != 1 || got.Headers["content-type"] != "application/vnd.api+json" {
		t.Errorf("explicit Content-Type was overridden: %#v", got.Headers)
	}
}

func TestJSSendRequestURLEncodedBody(t *testing.T) {
	t.Parallel()

	got := captureSend(t, `pm.sendRequest({
		url: "https://auth.example.com/token", method: "POST",
		body: { mode: "urlencoded", urlencoded: [
			{ key: "grant_type", value: "password" },
			{ key: "username", value: "a b&c" },
			{ key: "skip", value: "x", disabled: true }
		] }
	})`)
	if got.Body != "grant_type=password&username=a%20b%26c" {
		t.Errorf("body = %q", got.Body)
	}
	if got.Headers["Content-Type"] != "application/x-www-form-urlencoded" {
		t.Errorf("headers = %#v", got.Headers)
	}
}

func TestJSSendRequestFormDataBody(t *testing.T) {
	t.Parallel()

	got := captureSend(t, `pm.sendRequest({
		url: "https://example.com/upload", method: "POST",
		header: { "Content-Type": "multipart/form-data" },
		body: { mode: "formdata", formdata: [{ key: "name", value: "kurlo" }, { key: "off", value: "x", disabled: true }] }
	})`)
	contentType := got.Headers["Content-Type"]
	boundary, ok := strings.CutPrefix(contentType, "multipart/form-data; boundary=")
	if !ok || boundary == "" {
		t.Fatalf("Content-Type = %q", contentType)
	}
	want := "--" + boundary + "\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\nkurlo\r\n--" + boundary + "--\r\n"
	if got.Body != want {
		t.Errorf("body = %q, want %q", got.Body, want)
	}
}

func TestJSSendRequestGraphQLAndObjectBodies(t *testing.T) {
	t.Parallel()

	got := captureSend(t, `pm.sendRequest({ url: "https://example.com/graphql", method: "POST", body: { mode: "graphql", graphql: { query: "{ me { id } }", variables: "{\"a\":1}" } } })`)
	if got.Body != `{"query":"{ me { id } }","variables":{"a":1}}` || got.Headers["Content-Type"] != "application/json" {
		t.Errorf("graphql: body = %q headers = %#v", got.Body, got.Headers)
	}

	got = captureSend(t, `pm.sendRequest({ url: "https://example.com", method: "POST", body: { a: 1 } })`)
	if got.Body != `{"a":1}` || got.Headers["Content-Type"] != "application/json" {
		t.Errorf("object: body = %q headers = %#v", got.Body, got.Headers)
	}
}

func TestJSSendRequestURLObject(t *testing.T) {
	t.Parallel()

	got := captureSend(t, `pm.sendRequest({ url: { raw: "https://example.com/a?b=1" } })`)
	if got.URL != "https://example.com/a?b=1" {
		t.Errorf("url = %q", got.URL)
	}
}

func TestJSSendRequestUnsupportedBodiesFail(t *testing.T) {
	t.Parallel()

	for _, body := range []string{
		`{ mode: "file", file: { src: "/tmp/x" } }`,
		`{ mode: "formdata", formdata: [{ key: "f", type: "file", src: "/tmp/x" }] }`,
	} {
		ctx := jsCtx()
		ctx.Send = func(SendRequest) SendResponse { return SendResponse{StatusCode: 200} }
		result := RunPreRequest("js", `pm.sendRequest({ url: "https://example.com", method: "POST", body: `+body+` })`, ctx)
		if !strings.Contains(result.Error, "not supported") {
			t.Errorf("body %s: error = %q", body, result.Error)
		}
	}
}

func TestJSConsoleLevelsAreMarked(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	result := runPre(t, ctx, `
		console.log("plain", 1)
		console.info("info")
		console.warn("careful")
		console.error("broken", { a: 1 })
	`)
	want := []string{"plain 1", "info", "[warn] careful", `[error] broken {"a":1}`}
	if strings.Join(result.Logs, "\n") != strings.Join(want, "\n") {
		t.Errorf("logs = %#v, want %#v", result.Logs, want)
	}
}

func TestJSSendRequestCallsAreLogged(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	ctx.Send = func(req SendRequest) SendResponse {
		switch req.URL {
		case "https://example.com/ok":
			return SendResponse{StatusCode: 200, Status: "200 OK", DurationMs: 7}
		case "https://example.com/bad":
			return SendResponse{StatusCode: 415, Status: "415 Unsupported Media Type", DurationMs: 3}
		}
		return SendResponse{Error: "dial tcp: connection refused"}
	}
	result := runPre(t, ctx, `
		pm.sendRequest("https://example.com/ok")
		pm.sendRequest({ url: "https://example.com/bad", method: "POST" })
		pm.sendRequest("https://down.example.com", function () {})
	`)
	want := []string{
		"[request] pm.sendRequest GET https://example.com/ok → 200 OK · 7 ms",
		"[warn] pm.sendRequest POST https://example.com/bad → 415 Unsupported Media Type · 3 ms",
		"[error] pm.sendRequest GET https://down.example.com failed: dial tcp: connection refused",
	}
	if strings.Join(result.Logs, "\n") != strings.Join(want, "\n") {
		t.Errorf("logs = %#v, want %#v", result.Logs, want)
	}
}

func TestJSDroppedLogLinesAreReported(t *testing.T) {
	t.Parallel()

	ctx := jsCtx()
	result := runPre(t, ctx, `for (let i = 1; i <= 250; i++) console.log("line", i)`)
	if len(result.Logs) != jsMaxLogEntries+1 {
		t.Fatalf("got %d log lines, want %d plus a notice", len(result.Logs), jsMaxLogEntries)
	}
	if result.Logs[jsMaxLogEntries-1] != "line 200" {
		t.Errorf("last kept line = %q", result.Logs[jsMaxLogEntries-1])
	}
	want := "[warn] 50 more log lines were not shown: a script keeps its first 200 log lines"
	if got := result.Logs[jsMaxLogEntries]; got != want {
		t.Errorf("notice = %q, want %q", got, want)
	}

	ctx = jsCtx()
	result = runPre(t, ctx, `for (let i = 1; i <= 201; i++) console.log(i)`)
	if got := result.Logs[len(result.Logs)-1]; !strings.HasPrefix(got, "[warn] 1 more log line was not shown") {
		t.Errorf("singular notice = %q", got)
	}

	ctx = jsCtx()
	result = runPre(t, ctx, `for (let i = 1; i <= 200; i++) console.log(i)`)
	if len(result.Logs) != jsMaxLogEntries {
		t.Errorf("a script at the limit got a notice: %d lines", len(result.Logs))
	}
}
