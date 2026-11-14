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
