package script

import (
	"encoding/json"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const postResponseVarsPrelude = `var res = (function () {
  var headers = {};
  var rawHeaders = typeof responseHeaders === 'object' && responseHeaders ? responseHeaders : {};
  for (var name in rawHeaders) headers[String(name).toLowerCase()] = rawHeaders[name];
  var body;
  try { body = pm.response.json(); } catch (e) { body = pm.response.text(); }
  function query(path) {
    if (path === undefined || path === null || path === '') return body;
    var parts = String(path).replace(/\[(\w+)\]/g, '.$1').split('.').filter(function (part) { return part !== ''; });
    var current = body;
    for (var i = 0; i < parts.length; i++) {
      if (current === undefined || current === null) return undefined;
      current = current[parts[i]];
    }
    return current;
  }
  var res = function (path) { return query(path); };
  res.status = pm.response.code;
  res.statusText = pm.response.status;
  res.headers = headers;
  res.body = body;
  res.responseTime = pm.response.responseTime;
  res.getStatus = function () { return res.status; };
  res.getStatusText = function () { return res.statusText; };
  res.getHeader = function (name) { return headers[String(name).toLowerCase()]; };
  res.getHeaders = function () { return headers; };
  res.getBody = function () { return body; };
  res.getResponseTime = function () { return res.responseTime; };
  return res;
})();
function __kurloPostResponseVar(name, source) {
  var value;
  try {
    value = (new Function('res', 'return (' + source + '\n);'))(res);
  } catch (e) {
    console.log('Post-response var "' + name + '" failed: ' + (e && e.message ? e.message : String(e)));
    return;
  }
  if (value === undefined) {
    console.log('Post-response var "' + name + '" is undefined, kept the previous value');
    return;
  }
  pm.variables.set(name, typeof value === 'string' ? value : JSON.stringify(value));
}
`

func RunPostResponseVars(rows []model.KeyValue, ctx *Context) model.ScriptResult {
	var src strings.Builder
	count := 0
	for _, row := range rows {
		key := strings.TrimSpace(row.Key)
		expr := strings.TrimSpace(row.Value)
		if !row.Enabled || key == "" || expr == "" {
			continue
		}
		encodedKey, _ := json.Marshal(key)
		encodedExpr, _ := json.Marshal(expr)
		src.WriteString("__kurloPostResponseVar(")
		src.Write(encodedKey)
		src.WriteString(", ")
		src.Write(encodedExpr)
		src.WriteString(");\n")
		count++
	}
	if count == 0 {
		return model.ScriptResult{}
	}
	return run(string(EngineJS), postResponseVarsPrelude+src.String(), ctx, true)
}
