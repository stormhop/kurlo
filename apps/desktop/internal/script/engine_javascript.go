package script

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dop251/goja"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	jsMaxCallStackSize  = 1024
	jsMaxHostValueBytes = 256 * 1024
	jsMaxLogEntries     = 200
	jsMaxTestEntries    = 1000
)

func runJS(src string, ctx *Context, hasResponse bool) string {
	vm := goja.New()
	vm.SetMaxCallStackSize(jsMaxCallStackSize)

	if err := vm.Set("__kurloHost", buildJSHost(vm, ctx, hasResponse)); err != nil {
		return "setup error: " + err.Error()
	}
	if _, err := vm.RunString(jsPrelude); err != nil {
		return "setup error: " + err.Error()
	}

	timeout := resolveTimeout(ctx.Timeout)
	timer := time.AfterFunc(timeout, func() {
		vm.Interrupt("script timed out after " + timeout.String())
	})
	defer timer.Stop()

	_, runErr := vm.RunString(src)
	var interrupted *goja.InterruptedError
	if !errors.As(runErr, &interrupted) {
		func() {
			defer func() { _ = recover() }()
			recordLegacyTests(vm, ctx)
		}()
	}
	if runErr != nil {
		return jsErrorMessage(runErr)
	}
	return ""
}

func recordLegacyTests(vm *goja.Runtime, ctx *Context) {
	tests, ok := vm.Get("tests").(*goja.Object)
	if !ok || tests == nil {
		return
	}
	for _, name := range tests.Keys() {
		if len(ctx.Tests) >= jsMaxTestEntries {
			return
		}
		passed := tests.Get(name).ToBoolean()
		message := ""
		if !passed {
			message = "expected the test to be truthy"
		}
		ctx.Tests = append(ctx.Tests, model.TestResult{Name: limitJSHostString(name), Passed: passed, Error: message})
	}
}

func limitJSHostString(s string) string {
	if len(s) <= jsMaxHostValueBytes {
		return s
	}
	end := jsMaxHostValueBytes
	for end > 0 && !utf8.ValidString(s[:end]) {
		end--
	}
	return s[:end] + fmt.Sprintf("... [truncated after %d bytes]", jsMaxHostValueBytes)
}

const maxScriptFormRows = 500

type scriptFormRow struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	Disabled bool   `json:"disabled,omitempty"`
	Type     string `json:"type,omitempty"`
	FileName string `json:"fileName,omitempty"`
}

func encodeScriptFormData(rows []model.KeyValue) string {
	out := make([]scriptFormRow, 0, len(rows))
	for _, row := range rows {
		entry := scriptFormRow{Key: row.Key, Value: row.Value, Disabled: !row.Enabled, Type: "text"}
		if row.IsFile {
			entry.Type = "file"
			entry.FileName = row.FileName
		}
		out = append(out, entry)
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return "[]"
	}
	return string(encoded)
}

func decodeScriptFormData(payload string, previous []model.KeyValue) ([]model.KeyValue, error) {
	var incoming []scriptFormRow
	if err := json.Unmarshal([]byte(payload), &incoming); err != nil {
		return nil, fmt.Errorf("expected a list of { key, value } fields")
	}
	if len(incoming) > maxScriptFormRows {
		return nil, fmt.Errorf("a form body is limited to %d fields", maxScriptFormRows)
	}
	fileNames := make(map[string]string, len(previous))
	for _, row := range previous {
		if row.IsFile && row.FileName != "" {
			fileNames[row.Key] = row.FileName
		}
	}
	rows := make([]model.KeyValue, 0, len(incoming))
	for _, entry := range incoming {
		row := model.KeyValue{
			Key:     limitJSHostString(entry.Key),
			Value:   limitJSHostString(entry.Value),
			Enabled: !entry.Disabled,
			IsFile:  strings.EqualFold(entry.Type, "file"),
		}
		if row.IsFile {
			row.FileName = entry.FileName
			if row.FileName == "" {
				row.FileName = fileNames[row.Key]
			}
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func rawBodyWriteWarning(ctx *Context) string {
	switch PostmanBodyMode(ctx.RequestBodyType) {
	case "urlencoded":
		return "pm.request.body: this request sends an x-www-form-urlencoded body, so a raw write is ignored — edit pm.request.body.urlencoded instead."
	case "formdata":
		return "pm.request.body: this request sends a multipart form body, so a raw write is ignored — edit pm.request.body.formdata instead."
	case "file":
		if ctx.RequestBodyFilePath != "" {
			return "pm.request.body: this request sends a file from disk, so a raw write is ignored — the script never saw those bytes."
		}
	}
	return ""
}

func logScriptWarning(ctx *Context, message string) {
	for _, existing := range ctx.Logs {
		if existing == message {
			return
		}
	}
	if len(ctx.Logs) >= jsMaxLogEntries {
		return
	}
	ctx.Logs = append(ctx.Logs, message)
}

func jsErrorMessage(err error) string {
	switch e := err.(type) {
	case *goja.InterruptedError:
		if s, ok := e.Value().(string); ok {
			return s
		}
		return e.Error()
	case *goja.Exception:
		if v := e.Value(); v != nil {
			return v.String()
		}
		return e.Error()
	default:
		return err.Error()
	}
}

func buildJSHost(vm *goja.Runtime, ctx *Context, hasResponse bool) map[string]interface{} {
	undef := goja.Undefined()

	headerGet := func(store map[string]string, key string) goja.Value {
		for k, v := range store {
			if strings.EqualFold(k, key) {
				return vm.ToValue(v)
			}
		}
		return undef
	}

	host := map[string]interface{}{
		"varGet": func(k string) goja.Value {
			if v, ok := ctx.ResolveVariable(k); ok {
				return vm.ToValue(v)
			}
			return undef
		},
		"varSet":   func(k, v string) { ctx.Variables[limitJSHostString(k)] = limitJSHostString(v) },
		"varUnset": func(k string) { delete(ctx.Variables, limitJSHostString(k)) },
		"varClear": func() {
			for k := range ctx.Variables {
				delete(ctx.Variables, k)
			}
		},

		"globalGet": func(k string) goja.Value {
			if v, ok := ctx.Variables[k]; ok {
				return vm.ToValue(v)
			}
			return undef
		},

		"collGet": func(k string) goja.Value {
			if v, ok := ctx.CollectionVariables[k]; ok {
				return vm.ToValue(v)
			}
			return undef
		},
		"collSet": func(k, v string) {
			ctx.CollectionVariables[limitJSHostString(k)] = limitJSHostString(v)
		},
		"collUnset": func(k string) { delete(ctx.CollectionVariables, limitJSHostString(k)) },
		"collClear": func() {
			for k := range ctx.CollectionVariables {
				delete(ctx.CollectionVariables, k)
			}
		},

		"envGet": func(k string) goja.Value {
			if v, ok := ctx.Environment[k]; ok {
				return vm.ToValue(v)
			}
			return undef
		},
		"envSet":   func(k, v string) { ctx.Environment[limitJSHostString(k)] = limitJSHostString(v) },
		"envUnset": func(k string) { delete(ctx.Environment, limitJSHostString(k)) },
		"envClear": func() {
			for k := range ctx.Environment {
				delete(ctx.Environment, k)
			}
		},

		"iterGet": func(k string) goja.Value {
			if v, ok := ctx.IterationData[k]; ok {
				return vm.ToValue(v)
			}
			return undef
		},

		"reqGetUrl":    func() string { return ctx.RequestURL },
		"reqSetUrl":    func(u string) { ctx.RequestURL = limitJSHostString(u) },
		"reqGetMethod": func() string { return ctx.RequestMethod },

		"schemaValidate": func(schemaJSON, dataJSON string) string {
			errs, err := ValidateJSONSchemaText(schemaJSON, dataJSON)
			payload := map[string]any{}
			if err != nil {
				payload["error"] = err.Error()
			} else {
				if errs == nil {
					errs = []string{}
				}
				payload["errors"] = errs
			}
			encoded, marshalErr := json.Marshal(payload)
			if marshalErr != nil {
				return `{"error":"could not encode validation result"}`
			}
			return string(encoded)
		},

		"reqGetBody":     func() string { return ctx.RequestBody },
		"reqGetBodyMode": func() string { return PostmanBodyMode(ctx.RequestBodyType) },
		"reqSetBody": func(b string) {
			ctx.RequestBody = limitJSHostString(b)
			ctx.RequestBodyChanged = true
			if warning := rawBodyWriteWarning(ctx); warning != "" {
				logScriptWarning(ctx, warning)
			}
		},

		"reqGetFormData": func() string { return encodeScriptFormData(ctx.RequestFormData) },
		"reqSetFormData": func(payload string) string {
			rows, err := decodeScriptFormData(payload, ctx.RequestFormData)
			if err != nil {
				return err.Error()
			}
			ctx.RequestFormData = rows
			ctx.RequestFormDataChanged = true
			return ""
		},

		"reqHeaderGet": func(k string) goja.Value { return headerGet(ctx.RequestHeaders, k) },
		"reqHeaderSet": func(k, v string) {
			ctx.SetRequestHeader(limitJSHostString(k), limitJSHostString(v))
		},
		"reqHeaderUnset": func(k string) {
			ctx.UnsetRequestHeader(limitJSHostString(k))
		},

		"reqParamGet": func(k string) goja.Value {
			if v, ok := ctx.RequestParams[k]; ok {
				return vm.ToValue(v)
			}
			return undef
		},
		"reqParamSet": func(k, v string) {
			ctx.SetRequestParam(limitJSHostString(k), limitJSHostString(v))
		},
		"reqParamUnset": func(k string) {
			ctx.UnsetRequestParam(limitJSHostString(k))
		},

		"reqPathVarGet": func(k string) goja.Value {
			if v, ok := ctx.RequestPathParams[k]; ok {
				return vm.ToValue(v)
			}
			return undef
		},
		"reqPathVarSet": func(k, v string) {
			ctx.SetRequestPathParam(limitJSHostString(k), limitJSHostString(v))
		},
		"reqPathVarAll": func() string {
			encoded, err := json.Marshal(ctx.RequestPathParams)
			if err != nil {
				return "{}"
			}
			return string(encoded)
		},

		"recordTest": func(name string, passed bool, errMsg string) {
			if len(ctx.Tests) >= jsMaxTestEntries {
				return
			}
			ctx.Tests = append(ctx.Tests, model.TestResult{Name: limitJSHostString(name), Passed: passed, Error: limitJSHostString(errMsg)})
		},
		"log": func(msg string) {
			if len(ctx.Logs) >= jsMaxLogEntries {
				return
			}
			ctx.Logs = append(ctx.Logs, limitJSHostString(msg))
		},

		"infoRequestName":    func() string { return ctx.Info.RequestName },
		"infoIteration":      func() int { return ctx.Info.Iteration },
		"infoIterationCount": func() int { return ctx.Info.IterationCount },

		"skipRequest": func() {
			if !hasResponse {
				ctx.SkipRequest = true
			}
		},

		"cookieGet": func(name string) goja.Value {
			for _, cookie := range ctx.Cookies {
				if cookie.Name == name {
					return vm.ToValue(cookie.Value)
				}
			}
			return undef
		},
		"cookieHas": func(name string) bool {
			for _, cookie := range ctx.Cookies {
				if cookie.Name == name {
					return true
				}
			}
			return false
		},
		"cookieNames": func() goja.Value {
			names := make([]string, 0, len(ctx.Cookies))
			for _, cookie := range ctx.Cookies {
				names = append(names, cookie.Name)
			}
			return vm.ToValue(names)
		},

		"cryptoHash": func(algorithm, data, encoding string) goja.Value {
			digest, err := hashDigest(algorithm, data)
			if err != nil {
				panic(vm.NewTypeError(err.Error()))
			}
			return vm.ToValue(encodeDigest(digest, encoding))
		},
		"cryptoHmac": func(algorithm, key, data, encoding string) goja.Value {
			digest, err := hmacDigest(algorithm, key, data)
			if err != nil {
				panic(vm.NewTypeError(err.Error()))
			}
			return vm.ToValue(encodeDigest(digest, encoding))
		},
		"cryptoReencode": func(hexDigest, encoding string) goja.Value {
			raw, err := hex.DecodeString(hexDigest)
			if err != nil {
				panic(vm.NewTypeError("not a hex digest: " + err.Error()))
			}
			return vm.ToValue(encodeDigest(raw, encoding))
		},
		"cryptoBase64Encode": func(data string) string {
			return base64.StdEncoding.EncodeToString([]byte(data))
		},
		"cryptoBase64Decode": func(data string) goja.Value {
			decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(data))
			if err != nil {
				panic(vm.NewTypeError("base64 decode failed: " + err.Error()))
			}
			return vm.ToValue(string(decoded))
		},
		"cryptoRandomHex": func(n int) goja.Value {
			out, err := randomHex(n)
			if err != nil {
				panic(vm.NewTypeError(err.Error()))
			}
			return vm.ToValue(out)
		},
		"cryptoUUID": func() goja.Value {
			out, err := randomUUID()
			if err != nil {
				panic(vm.NewTypeError(err.Error()))
			}
			return vm.ToValue(out)
		},

		"replaceIn": func(value string) string { return limitJSHostString(ctx.ReplaceIn(value)) },
		"xml2Json": func(source string) goja.Value {
			encoded, err := xmlToJSON(source)
			if err != nil {
				return goja.Null()
			}
			return vm.ToValue(encoded)
		},

		"hasResponse": hasResponse && ctx.Response != nil,
		"canSend":     ctx.Send != nil,
	}

	if ctx.Send != nil {
		host["sendRequest"] = func(method, url string, headers map[string]string, body string) goja.Value {
			resp := ctx.Send(SendRequest{
				Method:  method,
				URL:     url,
				Headers: headers,
				Body:    body,
			})
			out := map[string]any{
				"code":         resp.StatusCode,
				"status":       resp.Status,
				"body":         resp.Body,
				"responseTime": resp.DurationMs,
				"size":         resp.Size,
				"headers":      resp.Headers,
				"error":        resp.Error,
			}
			return vm.ToValue(out)
		}
	}

	if hasResponse && ctx.Response != nil {
		resp := ctx.Response
		host["resCode"] = func() int { return resp.StatusCode }
		host["resStatus"] = func() string { return resp.Status }
		host["resTime"] = func() int64 { return resp.Duration }
		host["resSize"] = func() int64 { return resp.Size }
		host["resBody"] = func() string { return resp.Body }
		host["resHeadersJSON"] = func() string {
			headers := map[string]string{}
			for _, h := range resp.Headers {
				if _, seen := headers[h.Key]; !seen {
					headers[h.Key] = h.Value
				}
			}
			encoded, _ := json.Marshal(headers)
			return string(encoded)
		}
		host["resHeaderGet"] = func(k string) goja.Value {
			for _, h := range resp.Headers {
				if strings.EqualFold(h.Key, k) {
					return vm.ToValue(h.Value)
				}
			}
			return undef
		}
	}

	return host
}

const jsPrelude = `
var __kurloAPI = (function (host) {
  function valStr(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    return String(v);
  }
  function fmt(v) {
    if (typeof v === 'string') return v;
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'function') return v.toString();
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }
  function deepEqual(a, b) {
    if (a === b) return true;
    var ta = typeOf(a), tb = typeOf(b);
    if (ta !== tb) return false;
    if (ta === 'array') {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) { if (!deepEqual(a[i], b[i])) return false; }
      return true;
    }
    if (ta === 'object') {
      var ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (var j = 0; j < ka.length; j++) {
        var k = ka[j];
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!deepEqual(a[k], b[k])) return false;
      }
      return true;
    }
    return false;
  }

  function Assertion(obj) { this._obj = obj; this._neg = false; this._deep = false; }
  function check(self, pass, msg, negMsg) {
    var ok = self._neg ? !pass : pass;
    if (!ok) throw new Error(self._neg ? negMsg : msg);
    return self;
  }
  function num(self) { return typeof self._obj === 'number' ? self._obj : Number(self._obj); }

  var chains = ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'of', 'same', 'but', 'does', 'still', 'at'];
  for (var ci = 0; ci < chains.length; ci++) {
    (function (name) {
      Object.defineProperty(Assertion.prototype, name, { get: function () { return this; }, configurable: true });
    })(chains[ci]);
  }
  Object.defineProperty(Assertion.prototype, 'not', { get: function () { this._neg = !this._neg; return this; }, configurable: true });
  Object.defineProperty(Assertion.prototype, 'deep', { get: function () { this._deep = true; return this; }, configurable: true });
  Object.defineProperty(Assertion.prototype, 'all', { get: function () { this._any = false; return this; }, configurable: true });
  Object.defineProperty(Assertion.prototype, 'any', { get: function () { this._any = true; return this; }, configurable: true });

  function getAssert(name, fn) {
    Object.defineProperty(Assertion.prototype, name, { get: function () { return fn.call(this); }, configurable: true });
  }
  getAssert('ok', function () { return check(this, !!this._obj, 'expected ' + fmt(this._obj) + ' to be truthy', 'expected ' + fmt(this._obj) + ' to be falsy'); });
  getAssert('true', function () { return check(this, this._obj === true, 'expected ' + fmt(this._obj) + ' to be true', 'expected ' + fmt(this._obj) + ' to not be true'); });
  getAssert('false', function () { return check(this, this._obj === false, 'expected ' + fmt(this._obj) + ' to be false', 'expected ' + fmt(this._obj) + ' to not be false'); });
  getAssert('null', function () { return check(this, this._obj === null, 'expected ' + fmt(this._obj) + ' to be null', 'expected ' + fmt(this._obj) + ' to not be null'); });
  getAssert('undefined', function () { return check(this, this._obj === undefined, 'expected ' + fmt(this._obj) + ' to be undefined', 'expected ' + fmt(this._obj) + ' to not be undefined'); });
  getAssert('exist', function () { return check(this, this._obj !== null && this._obj !== undefined, 'expected ' + fmt(this._obj) + ' to exist', 'expected ' + fmt(this._obj) + ' to not exist'); });
  getAssert('empty', function () {
    var o = this._obj, isEmpty;
    if (o === null || o === undefined) isEmpty = true;
    else if (typeof o === 'string' || Array.isArray(o)) isEmpty = o.length === 0;
    else if (typeof o === 'object') isEmpty = Object.keys(o).length === 0;
    else isEmpty = false;
    return check(this, isEmpty, 'expected ' + fmt(o) + ' to be empty', 'expected ' + fmt(o) + ' to not be empty');
  });

  Assertion.prototype.equal = function (v) {
    var pass = this._deep ? deepEqual(this._obj, v) : (this._obj === v);
    return check(this, pass, 'expected ' + fmt(this._obj) + ' to equal ' + fmt(v), 'expected ' + fmt(this._obj) + ' to not equal ' + fmt(v));
  };
  Assertion.prototype.equals = Assertion.prototype.equal;
  Assertion.prototype.eq = Assertion.prototype.equal;
  Assertion.prototype.eql = function (v) {
    return check(this, deepEqual(this._obj, v), 'expected ' + fmt(this._obj) + ' to deeply equal ' + fmt(v), 'expected ' + fmt(this._obj) + ' to not deeply equal ' + fmt(v));
  };
  Assertion.prototype.eqls = Assertion.prototype.eql;
  Assertion.prototype.a = function (type) {
    var actual = typeOf(this._obj);
    return check(this, actual === type, 'expected ' + fmt(this._obj) + ' to be a ' + type + ' but got ' + actual, 'expected ' + fmt(this._obj) + ' to not be a ' + type);
  };
  Assertion.prototype.an = Assertion.prototype.a;
  Assertion.prototype.include = function (v) {
    var o = this._obj, pass = false;
    if (typeof o === 'string') pass = o.indexOf(v) !== -1;
    else if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) { if (deepEqual(o[i], v)) { pass = true; break; } } }
    else if (o && typeof o === 'object') {
      if (v && typeof v === 'object') { pass = true; for (var k in v) { if (!deepEqual(o[k], v[k])) { pass = false; break; } } }
      else { pass = Object.prototype.hasOwnProperty.call(o, v); }
    }
    return check(this, pass, 'expected ' + fmt(o) + ' to include ' + fmt(v), 'expected ' + fmt(o) + ' to not include ' + fmt(v));
  };
  Assertion.prototype.contain = Assertion.prototype.include;
  Assertion.prototype.contains = Assertion.prototype.include;
  Assertion.prototype.includes = Assertion.prototype.include;
  Assertion.prototype.property = function (name, val) {
    var has = this._obj !== null && this._obj !== undefined && Object.prototype.hasOwnProperty.call(Object(this._obj), name);
    if (arguments.length < 2) return check(this, has, 'expected ' + fmt(this._obj) + ' to have property ' + fmt(name), 'expected ' + fmt(this._obj) + ' to not have property ' + fmt(name));
    return check(this, has && deepEqual(this._obj[name], val), 'expected property ' + fmt(name) + ' to equal ' + fmt(val), 'expected property ' + fmt(name) + ' to not equal ' + fmt(val));
  };
  Assertion.prototype.lengthOf = function (n) {
    var len = (this._obj === null || this._obj === undefined) ? undefined : this._obj.length;
    return check(this, len === n, 'expected length ' + fmt(len) + ' to equal ' + fmt(n), 'expected length ' + fmt(len) + ' to not equal ' + fmt(n));
  };
  Assertion.prototype.length = Assertion.prototype.lengthOf;
  Assertion.prototype.keys = function (first) {
    var expected = Array.isArray(first) ? first.slice() : (first && typeof first === 'object' ? Object.keys(first) : Array.prototype.slice.call(arguments));
    var o = this._obj;
    var actual = o !== null && o !== undefined && typeof o === 'object' ? Object.keys(o) : [];
    var present = function (key) { return actual.indexOf(String(key)) !== -1; };
    var pass, wording;
    if (this._any) {
      pass = expected.some(present);
      wording = 'any of keys ';
    } else {
      pass = expected.every(present) && actual.length === expected.length;
      wording = 'all keys ';
    }
    return check(this, expected.length > 0 && pass, 'expected ' + fmt(o) + ' to have ' + wording + fmt(expected), 'expected ' + fmt(o) + ' to not have ' + wording + fmt(expected));
  };
  Assertion.prototype.key = Assertion.prototype.keys;
  Assertion.prototype.above = function (n) { return check(this, num(this) > n, 'expected ' + fmt(this._obj) + ' to be above ' + fmt(n), 'expected ' + fmt(this._obj) + ' to not be above ' + fmt(n)); };
  Assertion.prototype.gt = Assertion.prototype.above;
  Assertion.prototype.greaterThan = Assertion.prototype.above;
  Assertion.prototype.below = function (n) { return check(this, num(this) < n, 'expected ' + fmt(this._obj) + ' to be below ' + fmt(n), 'expected ' + fmt(this._obj) + ' to not be below ' + fmt(n)); };
  Assertion.prototype.lt = Assertion.prototype.below;
  Assertion.prototype.lessThan = Assertion.prototype.below;
  Assertion.prototype.least = function (n) { return check(this, num(this) >= n, 'expected ' + fmt(this._obj) + ' to be at least ' + fmt(n), 'expected ' + fmt(this._obj) + ' to be below ' + fmt(n)); };
  Assertion.prototype.most = function (n) { return check(this, num(this) <= n, 'expected ' + fmt(this._obj) + ' to be at most ' + fmt(n), 'expected ' + fmt(this._obj) + ' to be above ' + fmt(n)); };
  Assertion.prototype.within = function (a, b) { var x = num(this); return check(this, x >= a && x <= b, 'expected ' + fmt(this._obj) + ' to be within ' + a + '..' + b, 'expected ' + fmt(this._obj) + ' to not be within ' + a + '..' + b); };
  Assertion.prototype.match = function (re) { return check(this, re.test(String(this._obj)), 'expected ' + fmt(this._obj) + ' to match ' + re, 'expected ' + fmt(this._obj) + ' to not match ' + re); };
  Assertion.prototype.oneOf = function (arr) { var o = this._obj, pass = false; for (var i = 0; i < arr.length; i++) { if (deepEqual(arr[i], o)) { pass = true; break; } } return check(this, pass, 'expected ' + fmt(o) + ' to be one of ' + fmt(arr), 'expected ' + fmt(o) + ' to not be one of ' + fmt(arr)); };
  function schemaErrors(schema, data) {
    var result = JSON.parse(host.schemaValidate(JSON.stringify(schema === undefined ? null : schema), JSON.stringify(data === undefined ? null : data)));
    if (result.error) throw new Error(result.error);
    return result.errors || [];
  }
  function assertionSubject(obj) {
    if (obj && typeof obj.json === 'function') {
      try { return obj.json(); } catch (e) { throw new Error('response body is not JSON: ' + e.message); }
    }
    return obj;
  }
  Assertion.prototype.jsonSchema = function (schema) {
    var errs = schemaErrors(schema, assertionSubject(this._obj));
    return check(this, errs.length === 0,
      'expected the value to match the JSON schema (' + errs.join('; ') + ')',
      'expected the value not to match the JSON schema');
  };
  Assertion.prototype.jsonBody = function (path, value) {
    var body = assertionSubject(this._obj);
    if (arguments.length === 0) {
      return check(this, body !== undefined && body !== null, 'expected a JSON body', 'expected no JSON body');
    }
    if (typeof path === 'object' && path !== null) {
      return check(this, deepEqual(body, path), 'expected body ' + fmt(body) + ' to equal ' + fmt(path), 'expected body not to equal ' + fmt(path));
    }
    var current = body, parts = String(path).split('.');
    for (var i = 0; i < parts.length; i++) {
      if (current === null || current === undefined) { current = undefined; break; }
      current = current[parts[i]];
    }
    if (arguments.length < 2) {
      return check(this, current !== undefined, 'expected body to have ' + fmt(path), 'expected body to not have ' + fmt(path));
    }
    return check(this, deepEqual(current, value), 'expected body ' + fmt(path) + ' to equal ' + fmt(value) + ' but got ' + fmt(current), 'expected body ' + fmt(path) + ' to not equal ' + fmt(value));
  };
  Assertion.prototype.status = function (n) { var code = (this._obj && typeof this._obj === 'object' && 'code' in this._obj) ? this._obj.code : this._obj; return check(this, code === n, 'expected status ' + fmt(code) + ' to equal ' + fmt(n), 'expected status ' + fmt(code) + ' to not equal ' + fmt(n)); };
  Assertion.prototype.header = function (name) { var o = this._obj; var val = (o && o.headers && o.headers.get) ? o.headers.get(name) : undefined; return check(this, val !== undefined && val !== null, 'expected response to have header ' + fmt(name), 'expected response to not have header ' + fmt(name)); };

  function expect(obj) { return new Assertion(obj); }

  function kv(getName, setName, unsetName, clearName) {
    return {
      get: function (k) { return host[getName](String(k)); },
      set: function (k, v) { host[setName](String(k), valStr(v)); },
      unset: function (k) { host[unsetName](String(k)); },
      clear: function () { host[clearName](); }
    };
  }

  function hostHash(alg) {
    return function (data, enc) { return host.cryptoHash(alg, valStr(data), enc === undefined ? 'hex' : String(enc)); };
  }
  function hostHmac(alg) {
    return function (data, key, enc) { return host.cryptoHmac(alg, valStr(key), valStr(data), enc === undefined ? 'hex' : String(enc)); };
  }

  var crypto = {
    md5: hostHash('md5'),
    sha1: hostHash('sha1'),
    sha256: hostHash('sha256'),
    sha384: hostHash('sha384'),
    sha512: hostHash('sha512'),
    hash: function (alg, data, enc) { return host.cryptoHash(String(alg), valStr(data), enc === undefined ? 'hex' : String(enc)); },
    hmacSha1: hostHmac('sha1'),
    hmacSha256: hostHmac('sha256'),
    hmacSha384: hostHmac('sha384'),
    hmacSha512: hostHmac('sha512'),
    hmac: function (alg, data, key, enc) { return host.cryptoHmac(String(alg), valStr(key), valStr(data), enc === undefined ? 'hex' : String(enc)); },
    base64Encode: function (data) { return host.cryptoBase64Encode(valStr(data)); },
    base64Decode: function (data) { return host.cryptoBase64Decode(valStr(data)); },
    randomHex: function (n) { return host.cryptoRandomHex(n === undefined ? 16 : Number(n)); },
    uuid: function () { return host.cryptoUUID(); }
  };

  var pm = {
    variables: kv('varGet', 'varSet', 'varUnset', 'varClear'),
    environment: kv('envGet', 'envSet', 'envUnset', 'envClear'),
    globals: {
      get: function (k) { return host.globalGet(String(k)); },
      set: function (k, v) { host.varSet(String(k), valStr(v)); },
      unset: function (k) { host.varUnset(String(k)); },
      clear: function () { host.varClear(); }
    },
    collectionVariables: kv('collGet', 'collSet', 'collUnset', 'collClear'),
    crypto: crypto,
    cookies: {
      get: function (k) { return host.cookieGet(String(k)); },
      has: function (k) { return host.cookieHas(String(k)); },
      names: function () { return host.cookieNames(); }
    },
    execution: {
      skipRequest: function () { host.skipRequest(); }
    },
    iterationData: { get: function (k) { return host.iterGet(String(k)); } },
    request: {
      set_url: function (u) { host.reqSetUrl(String(u)); },
      setUrl: function (u) { host.reqSetUrl(String(u)); },
      headers: {
        get: function (k) { return host.reqHeaderGet(String(k)); },
        set: function (k, v) { host.reqHeaderSet(String(k), valStr(v)); },
        unset: function (k) { host.reqHeaderUnset(String(k)); },
        add: function (h) { if (h && h.key !== undefined) host.reqHeaderSet(String(h.key), valStr(h.value)); }
      },
      params: {
        get: function (k) { return host.reqParamGet(String(k)); },
        set: function (k, v) { host.reqParamSet(String(k), valStr(v)); },
        unset: function (k) { host.reqParamUnset(String(k)); }
      },
      pathVariables: {
        get: function (k) { return host.reqPathVarGet(String(k)); },
        set: function (k, v) { host.reqPathVarSet(String(k), valStr(v)); },
        has: function (k) { return host.reqPathVarGet(String(k)) !== undefined; },
        toObject: function () { try { return JSON.parse(host.reqPathVarAll()) || {}; } catch (e) { return {}; } }
      }
    },
    test: function (name, fn) {
      try {
        if (typeof fn === 'function') fn();
        else if (!fn) throw new Error('expected condition to be truthy');
        host.recordTest(String(name), true, '');
      } catch (e) {
        var msg = (e && e.message !== undefined) ? String(e.message) : String(e);
        host.recordTest(String(name), false, msg);
      }
    },
    expect: expect,
    log: function () { var a = []; for (var i = 0; i < arguments.length; i++) a.push(fmt(arguments[i])); host.log(a.join(' ')); }
  };
  Object.defineProperty(pm.request, 'url', { get: function () { return host.reqGetUrl(); }, configurable: true });
  Object.defineProperty(pm.request, 'method', { get: function () { return host.reqGetMethod(); }, configurable: true });

  function formRows() {
    try { return JSON.parse(host.reqGetFormData()) || []; } catch (e) { return []; }
  }
  function writeFormRows(rows) {
    var problem = host.reqSetFormData(JSON.stringify(rows));
    if (problem) throw new Error('pm.request.body: ' + problem);
  }
  function asFormRow(item, fallbackValue) {
    if (item === null || item === undefined) throw new Error('pm.request.body: a field needs a key');
    if (typeof item === 'string') return { key: item, value: valStr(fallbackValue === undefined ? '' : fallbackValue), type: 'text' };
    var row = { key: String(item.key === undefined ? '' : item.key), value: valStr(item.value === undefined ? '' : item.value) };
    if (item.disabled === true) row.disabled = true;
    if (item.type === 'file' || item.src !== undefined) {
      row.type = 'file';
      if (item.src !== undefined) row.value = valStr(item.src);
      if (item.fileName !== undefined) row.fileName = String(item.fileName);
    } else {
      row.type = 'text';
    }
    return row;
  }
  function makeFormList() {
    return {
      all: function () { return formRows(); },
      count: function () { return formRows().length; },
      one: function (key) {
        var rows = formRows();
        for (var i = 0; i < rows.length; i++) { if (rows[i].key === key) return rows[i]; }
        return undefined;
      },
      get: function (key) { var row = this.one(key); return row ? row.value : undefined; },
      has: function (key) { return this.one(key) !== undefined; },
      each: function (fn) { var rows = formRows(); for (var i = 0; i < rows.length; i++) fn(rows[i], i); },
      add: function (item, value) { var rows = formRows(); rows.push(asFormRow(item, value)); writeFormRows(rows); },
      upsert: function (item, value) {
        var next = asFormRow(item, value), rows = formRows(), replaced = false;
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].key === next.key) {
            if (rows[i].type === 'file' && next.type !== 'file') { next.type = 'file'; next.fileName = rows[i].fileName; }
            rows[i] = next; replaced = true; break;
          }
        }
        if (!replaced) rows.push(next);
        writeFormRows(rows);
      },
      remove: function (match) {
        var rows = formRows(), kept = [];
        for (var i = 0; i < rows.length; i++) {
          var drop = typeof match === 'function' ? match(rows[i], i) : rows[i].key === match;
          if (!drop) kept.push(rows[i]);
        }
        writeFormRows(kept);
      },
      clear: function () { writeFormRows([]); },
      toObject: function () {
        var out = {}, rows = formRows();
        for (var i = 0; i < rows.length; i++) { if (!rows[i].disabled) out[rows[i].key] = rows[i].value; }
        return out;
      },
      toJSON: function () { return formRows(); }
    };
  }

  var formList = makeFormList();
  var requestBody = {
    update: function (v) {
      if (v !== null && typeof v === 'object' && typeof v.mode === 'string') {
        if (v.mode === 'urlencoded' || v.mode === 'formdata') { writeFormRows((v[v.mode] || []).map(function (item) { return asFormRow(item); })); return; }
        host.reqSetBody(valStr(v.raw === undefined ? '' : v.raw));
        return;
      }
      host.reqSetBody(valStr(v));
    },
    toString: function () { return host.reqGetBody(); },
    json: function () { return JSON.parse(host.reqGetBody()); }
  };
  Object.defineProperty(requestBody, 'raw', {
    get: function () { return host.reqGetBody(); },
    set: function (v) { host.reqSetBody(valStr(v)); },
    configurable: true
  });
  Object.defineProperty(requestBody, 'mode', { get: function () { return host.reqGetBodyMode(); }, configurable: true });
  Object.defineProperty(requestBody, 'urlencoded', { get: function () { return host.reqGetBodyMode() === 'urlencoded' ? formList : undefined; }, configurable: true });
  Object.defineProperty(requestBody, 'formdata', { get: function () { return host.reqGetBodyMode() === 'formdata' ? formList : undefined; }, configurable: true });
  pm.request.body = requestBody;
  pm.request.setBody = function (v) { host.reqSetBody(valStr(v)); };

  pm.info = {};
  Object.defineProperty(pm.info, 'requestName', { get: function () { return host.infoRequestName(); }, configurable: true });
  Object.defineProperty(pm.info, 'iteration', { get: function () { return host.infoIteration(); }, configurable: true });
  Object.defineProperty(pm.info, 'iterationCount', { get: function () { return host.infoIterationCount(); }, configurable: true });
  Object.defineProperty(pm.info, 'eventName', { get: function () { return host.hasResponse ? 'test' : 'prerequest'; }, configurable: true });

  function wrapSentResponse(raw) {
    var headers = raw.headers || {};
    var res = {
      code: raw.code,
      status: raw.status,
      responseTime: raw.responseTime,
      time: raw.responseTime,
      size: raw.size,
      text: function () { return raw.body; },
      body: function () { return raw.body; },
      json: function () { return JSON.parse(raw.body); },
      headers: {
        get: function (name) {
          var want = String(name).toLowerCase();
          for (var key in headers) {
            if (String(key).toLowerCase() === want) return headers[key];
          }
          return undefined;
        }
      }
    };
    Object.defineProperty(res, 'to', { get: function () { return new Assertion(res); }, configurable: true });
    return res;
  }

  pm.sendRequest = function (options, callback) {
    if (!host.canSend) {
      var disabled = new Error('pm.sendRequest is disabled — turn on "Allow pm.sendRequest" in the Settings tab of this request, or pass --allow-send-request to kurlo run');
      if (typeof callback === 'function') return callback(disabled, undefined);
      throw disabled;
    }

    var method = 'GET', url = '', headers = {}, body = '';
    if (typeof options === 'string') {
      url = options;
    } else if (options && typeof options === 'object') {
      url = String(options.url || '');
      if (options.method) method = String(options.method).toUpperCase();
      var h = options.header || options.headers;
      if (Array.isArray(h)) {
        for (var i = 0; i < h.length; i++) {
          if (h[i] && h[i].key !== undefined) headers[String(h[i].key)] = valStr(h[i].value);
        }
      } else if (h && typeof h === 'object') {
        for (var k in h) headers[String(k)] = valStr(h[k]);
      }
      if (options.body !== undefined && options.body !== null) {
        var b = options.body;
        if (typeof b === 'string') body = b;
        else if (b.raw !== undefined) body = valStr(b.raw);
        else if (b.mode === 'raw') body = valStr(b.raw);
        else body = valStr(b);
      }
    } else {
      throw new Error('pm.sendRequest expects a URL string or an options object');
    }
    if (!url) throw new Error('pm.sendRequest requires a url');

    var raw = host.sendRequest(method, url, headers, body);
    if (raw.error) {
      var err = new Error(raw.error);
      if (typeof callback === 'function') return callback(err, undefined);
      throw err;
    }
    var wrapped = wrapSentResponse(raw);
    if (typeof callback === 'function') return callback(null, wrapped);
    return wrapped;
  };

  if (host.hasResponse) {
    var resp = {
      text: function () { return host.resBody(); },
      body: function () { return host.resBody(); },
      json: function () { return JSON.parse(host.resBody()); },
      headers: { get: function (k) { return host.resHeaderGet(String(k)); } }
    };
    Object.defineProperty(resp, 'code', { get: function () { return host.resCode(); }, configurable: true });
    Object.defineProperty(resp, 'status', { get: function () { return host.resStatus(); }, configurable: true });
    Object.defineProperty(resp, 'responseTime', { get: function () { return host.resTime(); }, configurable: true });
    Object.defineProperty(resp, 'time', { get: function () { return host.resTime(); }, configurable: true });
    Object.defineProperty(resp, 'size', { get: function () { return host.resSize(); }, configurable: true });
    Object.defineProperty(resp, 'to', { get: function () { return new Assertion(resp); }, configurable: true });
    pm.response = resp;
  }

  var console = { log: pm.log, info: pm.log, warn: pm.log, error: pm.log, debug: pm.log };

  pm.variables.replaceIn = function (value) { return host.replaceIn(valStr(value)); };

  function xml2Json(xml) {
    var encoded = host.xml2Json(valStr(xml));
    return encoded === null ? null : JSON.parse(encoded);
  }

  var postman = {
    setEnvironmentVariable: function (k, v) { pm.environment.set(k, v); },
    getEnvironmentVariable: function (k) { return pm.environment.get(k); },
    clearEnvironmentVariable: function (k) { pm.environment.unset(k); },
    clearEnvironmentVariables: function () { pm.environment.clear(); },
    setGlobalVariable: function (k, v) { pm.globals.set(k, v); },
    getGlobalVariable: function (k) { return pm.globals.get(k); },
    clearGlobalVariable: function (k) { pm.globals.unset(k); },
    clearGlobalVariables: function () { pm.globals.clear(); },
    getResponseHeader: function (k) { return pm.response ? pm.response.headers.get(k) : undefined; },
    setNextRequest: function () { throw new Error("postman.setNextRequest is not supported — Kurlo's Collection Runner runs requests in their declared order"); }
  };

  var legacy = { tests: {}, postman: postman, xml2Json: xml2Json };
  if (host.hasResponse) {
    legacy.responseBody = host.resBody();
    legacy.responseCode = { code: host.resCode(), name: host.resStatus(), detail: host.resStatus() };
    legacy.responseHeaders = JSON.parse(host.resHeadersJSON());
    legacy.responseTime = host.resTime();
  }

  function wordArray(hex) {
    return {
      __kurloDigestHex: hex,
      toString: function (encoder) {
        if (encoder && encoder.__kurloEnc && encoder.__kurloEnc !== 'hex') return host.cryptoReencode(hex, encoder.__kurloEnc);
        return hex;
      }
    };
  }
  function cryptoJSDigest(alg) {
    return function (message) { return wordArray(host.cryptoHash(alg, valStr(message), 'hex')); };
  }
  function cryptoJSHmac(alg) {
    return function (message, key) { return wordArray(host.cryptoHmac(alg, valStr(key), valStr(message), 'hex')); };
  }
  var CryptoJS = {
    MD5: cryptoJSDigest('md5'),
    SHA1: cryptoJSDigest('sha1'),
    SHA256: cryptoJSDigest('sha256'),
    SHA384: cryptoJSDigest('sha384'),
    SHA512: cryptoJSDigest('sha512'),
    HmacMD5: cryptoJSHmac('md5'),
    HmacSHA1: cryptoJSHmac('sha1'),
    HmacSHA256: cryptoJSHmac('sha256'),
    HmacSHA384: cryptoJSHmac('sha384'),
    HmacSHA512: cryptoJSHmac('sha512'),
    enc: {
      Hex: { __kurloEnc: 'hex', stringify: function (wa) { return wa.toString(); } },
      Base64: { __kurloEnc: 'base64', stringify: function (wa) { return wa.toString({ __kurloEnc: 'base64' }); } },
      Utf8: {
        __kurloEnc: 'hex',
        parse: function (s) { return valStr(s); },
        stringify: function (wa) { return wa.toString(); }
      }
    }
  };


  function pathParts(path) {
    if (Array.isArray(path)) return path;
    return String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(function (part) { return part !== ''; });
  }
  function iteratee(value) {
    if (typeof value === 'function') return value;
    if (value === null || value === undefined) return function (item) { return item; };
    if (typeof value === 'object') {
      return function (item) {
        for (var key in value) { if (!deepEqual(item ? item[key] : undefined, value[key])) return false; }
        return true;
      };
    }
    return function (item) { return lodashGet(item, value); };
  }
  function lodashGet(obj, path, fallback) {
    var current = obj, parts = pathParts(path);
    for (var i = 0; i < parts.length; i++) {
      if (current === null || current === undefined) return fallback;
      current = current[parts[i]];
    }
    return current === undefined ? fallback : current;
  }
  function toArray(collection) {
    if (Array.isArray(collection)) return collection;
    if (collection === null || collection === undefined) return [];
    if (typeof collection === 'object') {
      var out = [];
      for (var key in collection) out.push(collection[key]);
      return out;
    }
    return [collection];
  }
  function mergeDeep(target, source) {
    for (var key in source) {
      var value = source[key];
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
        mergeDeep(target[key], value);
      } else {
        target[key] = value;
      }
    }
    return target;
  }

  var lodash = {
    get: lodashGet,
    set: function (obj, path, value) {
      var parts = pathParts(path), current = obj;
      for (var i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] === null || typeof current[parts[i]] !== 'object') current[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
        current = current[parts[i]];
      }
      if (parts.length) current[parts[parts.length - 1]] = value;
      return obj;
    },
    has: function (obj, path) { return lodashGet(obj, path, undefined) !== undefined; },
    isNil: function (v) { return v === null || v === undefined; },
    isEmpty: function (v) {
      if (v === null || v === undefined) return true;
      if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
      if (typeof v === 'object') return Object.keys(v).length === 0;
      return false;
    },
    isEqual: deepEqual,
    isArray: function (v) { return Array.isArray(v); },
    isObject: function (v) { return v !== null && (typeof v === 'object' || typeof v === 'function'); },
    isString: function (v) { return typeof v === 'string'; },
    isNumber: function (v) { return typeof v === 'number'; },
    isFunction: function (v) { return typeof v === 'function'; },
    keys: function (obj) { return obj ? Object.keys(obj) : []; },
    values: toArray,
    size: function (v) { return typeof v === 'string' || Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0); },
    pick: function (obj, keys) {
      var out = {}, list = Array.isArray(keys) ? keys : Array.prototype.slice.call(arguments, 1);
      for (var i = 0; i < list.length; i++) { if (obj && list[i] in obj) out[list[i]] = obj[list[i]]; }
      return out;
    },
    omit: function (obj, keys) {
      var out = {}, list = Array.isArray(keys) ? keys : Array.prototype.slice.call(arguments, 1);
      for (var key in obj) { if (list.indexOf(key) === -1) out[key] = obj[key]; }
      return out;
    },
    merge: function (target) {
      for (var i = 1; i < arguments.length; i++) { if (arguments[i]) mergeDeep(target, arguments[i]); }
      return target;
    },
    assign: function (target) {
      for (var i = 1; i < arguments.length; i++) { for (var key in arguments[i]) target[key] = arguments[i][key]; }
      return target;
    },
    defaults: function (target) {
      for (var i = 1; i < arguments.length; i++) { for (var key in arguments[i]) { if (target[key] === undefined) target[key] = arguments[i][key]; } }
      return target;
    },
    cloneDeep: function (v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); },
    map: function (collection, fn) { return toArray(collection).map(iteratee(fn)); },
    filter: function (collection, fn) { return toArray(collection).filter(iteratee(fn)); },
    reject: function (collection, fn) { var f = iteratee(fn); return toArray(collection).filter(function (item, i) { return !f(item, i); }); },
    find: function (collection, fn) {
      var items = toArray(collection), f = iteratee(fn);
      for (var i = 0; i < items.length; i++) { if (f(items[i], i)) return items[i]; }
      return undefined;
    },
    findIndex: function (collection, fn) {
      var items = toArray(collection), f = iteratee(fn);
      for (var i = 0; i < items.length; i++) { if (f(items[i], i)) return i; }
      return -1;
    },
    some: function (collection, fn) { return toArray(collection).some(iteratee(fn)); },
    every: function (collection, fn) { return toArray(collection).every(iteratee(fn)); },
    forEach: function (collection, fn) { toArray(collection).forEach(fn); return collection; },
    reduce: function (collection, fn, seed) { return toArray(collection).reduce(fn, seed); },
    includes: function (collection, value) { return toArray(collection).some(function (item) { return deepEqual(item, value); }); },
    uniq: function (items) {
      var out = [];
      toArray(items).forEach(function (item) { if (!out.some(function (kept) { return deepEqual(kept, item); })) out.push(item); });
      return out;
    },
    uniqBy: function (items, fn) {
      var f = iteratee(fn), seen = [], out = [];
      toArray(items).forEach(function (item) {
        var key = f(item);
        if (!seen.some(function (kept) { return deepEqual(kept, key); })) { seen.push(key); out.push(item); }
      });
      return out;
    },
    compact: function (items) { return toArray(items).filter(function (item) { return Boolean(item); }); },
    flatten: function (items) { return toArray(items).reduce(function (acc, item) { return acc.concat(item); }, []); },
    flattenDeep: function flattenDeep(items) {
      return toArray(items).reduce(function (acc, item) { return acc.concat(Array.isArray(item) ? lodash.flattenDeep(item) : item); }, []);
    },
    chunk: function (items, size) {
      var list = toArray(items), step = Math.max(1, Math.floor(size || 1)), out = [];
      for (var i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
      return out;
    },
    groupBy: function (collection, fn) {
      var f = iteratee(fn), out = {};
      toArray(collection).forEach(function (item) {
        var key = String(f(item));
        (out[key] = out[key] || []).push(item);
      });
      return out;
    },
    countBy: function (collection, fn) {
      var f = iteratee(fn), out = {};
      toArray(collection).forEach(function (item) {
        var key = String(f(item));
        out[key] = (out[key] || 0) + 1;
      });
      return out;
    },
    keyBy: function (collection, fn) {
      var f = iteratee(fn), out = {};
      toArray(collection).forEach(function (item) { out[String(f(item))] = item; });
      return out;
    },
    sortBy: function (collection, fn) {
      var f = iteratee(fn);
      return toArray(collection).slice().sort(function (a, b) {
        var left = f(a), right = f(b);
        if (left === right) return 0;
        return left > right ? 1 : -1;
      });
    },
    maxBy: function (collection, fn) {
      var f = iteratee(fn), best;
      toArray(collection).forEach(function (item) { if (best === undefined || f(item) > f(best)) best = item; });
      return best;
    },
    minBy: function (collection, fn) {
      var f = iteratee(fn), best;
      toArray(collection).forEach(function (item) { if (best === undefined || f(item) < f(best)) best = item; });
      return best;
    },
    sum: function (items) { return toArray(items).reduce(function (acc, item) { return acc + Number(item); }, 0); },
    sumBy: function (items, fn) { var f = iteratee(fn); return toArray(items).reduce(function (acc, item) { return acc + Number(f(item)); }, 0); },
    head: function (items) { return toArray(items)[0]; },
    last: function (items) { var list = toArray(items); return list[list.length - 1]; },
    difference: function (items, other) {
      var exclude = toArray(other);
      return toArray(items).filter(function (item) { return !exclude.some(function (o) { return deepEqual(o, item); }); });
    },
    intersection: function (items, other) {
      var keep = toArray(other);
      return toArray(items).filter(function (item) { return keep.some(function (o) { return deepEqual(o, item); }); });
    },
    range: function (start, end, step) {
      if (end === undefined) { end = start; start = 0; }
      var by = step || 1, out = [];
      for (var i = start; by > 0 ? i < end : i > end; i += by) out.push(i);
      return out;
    },
    times: function (n, fn) { var out = []; for (var i = 0; i < n; i++) out.push(fn ? fn(i) : i); return out; },
    toPairs: function (obj) { return Object.keys(obj || {}).map(function (key) { return [key, obj[key]]; }); },
    fromPairs: function (pairs) { var out = {}; toArray(pairs).forEach(function (pair) { out[pair[0]] = pair[1]; }); return out; },
    trim: function (s) { return String(s === undefined || s === null ? '' : s).trim(); },
    capitalize: function (s) { var text = String(s || ''); return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase(); },
    upperFirst: function (s) { var text = String(s || ''); return text.charAt(0).toUpperCase() + text.slice(1); },
    random: function (min, max) {
      if (max === undefined) { max = min || 1; min = 0; }
      return Math.floor(Math.random() * (max - min + 1)) + min;
    },
    sample: function (items) { var list = toArray(items); return list[Math.floor(Math.random() * list.length)]; }
  };
  lodash.each = lodash.forEach;
  lodash.first = lodash.head;
  lodash.contains = lodash.includes;

  var lodashModule = typeof Proxy === 'function' ? new Proxy(lodash, {
    get: function (target, name) {
      if (name in target || typeof name === 'symbol') return target[name];
      throw new Error('lodash.' + String(name) + ' is not available in Kurlo\'s script sandbox');
    }
  }) : lodash;

  function schemaErrorObjects(schema, data) {
    return schemaErrors(schema, data).map(function (message) {
      var at = message.indexOf(': ');
      return { dataPath: at > 0 ? message.slice(0, at) : '', message: at > 0 ? message.slice(at + 2) : message, toString: function () { return message; } };
    });
  }

  var tv4 = {
    error: null,
    validate: function (data, schema) {
      var errs = schemaErrorObjects(schema, data);
      tv4.error = errs.length ? errs[0] : null;
      return errs.length === 0;
    },
    validateResult: function (data, schema) {
      var errs = schemaErrorObjects(schema, data);
      return { valid: errs.length === 0, error: errs.length ? errs[0] : null, errors: errs };
    },
    validateMultiple: function (data, schema) {
      var errs = schemaErrorObjects(schema, data);
      return { valid: errs.length === 0, errors: errs };
    }
  };

  function Ajv() {
    if (!(this instanceof Ajv)) return new Ajv();
    this.errors = null;
  }
  Ajv.prototype.validate = function (schema, data) {
    var errs = schemaErrorObjects(schema, data);
    this.errors = errs.length ? errs : null;
    return errs.length === 0;
  };
  Ajv.prototype.compile = function (schema) {
    var owner = this;
    var validator = function (data) { return owner.validate(schema, data); };
    Object.defineProperty(validator, 'errors', { get: function () { return owner.errors; }, configurable: true });
    return validator;
  };
  Ajv.prototype.errorsText = function (errs) {
    return (errs || this.errors || []).map(function (e) { return e.toString(); }).join(', ') || 'No errors';
  };
  Ajv.prototype.addSchema = function () { return this; };
  Ajv.prototype.addFormat = function () { return this; };

  var uuidModule = {
    v4: function () { return host.cryptoUUID(); },
    validate: function (value) { return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(value)); }
  };

  var MODULES = {
    lodash: lodashModule,
    underscore: lodashModule,
    'lodash.get': lodashGet,
    ajv: Ajv,
    tv4: tv4,
    uuid: uuidModule,
    'crypto-js': CryptoJS,
    chai: { expect: expect },
    'postman-collection': undefined
  };

  function require(name) {
    var key = String(name);
    if (Object.prototype.hasOwnProperty.call(MODULES, key) && MODULES[key] !== undefined) return MODULES[key];
    throw new Error('require("' + key + '") is not available in Kurlo\'s script sandbox (supported: ' +
      Object.keys(MODULES).filter(function (k) { return MODULES[k] !== undefined; }).join(', ') + ')');
  }

  function atob(encoded) { return host.cryptoBase64Decode(valStr(encoded)); }
  function btoa(raw) { return host.cryptoBase64Encode(valStr(raw)); }

  return { pm: pm, expect: expect, console: console, CryptoJS: CryptoJS, require: require, _: lodashModule, tv4: tv4, Ajv: Ajv, atob: atob, btoa: btoa, legacy: legacy };
})(__kurloHost);

(function (globalScope) {
  globalScope.pm = __kurloAPI.pm;
  globalScope.expect = __kurloAPI.expect;
  globalScope.console = __kurloAPI.console;
  globalScope.CryptoJS = __kurloAPI.CryptoJS;
  globalScope.require = __kurloAPI.require;
  globalScope._ = __kurloAPI._;
  globalScope.tv4 = __kurloAPI.tv4;
  globalScope.Ajv = __kurloAPI.Ajv;
  globalScope.atob = __kurloAPI.atob;
  globalScope.btoa = __kurloAPI.btoa;
  for (var name in __kurloAPI.legacy) globalScope[name] = __kurloAPI.legacy[name];
})(typeof globalThis !== 'undefined' ? globalThis : this);
__kurloHost = undefined;
__kurloAPI = undefined;
`
