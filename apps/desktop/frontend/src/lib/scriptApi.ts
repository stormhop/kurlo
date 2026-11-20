export interface ScriptMember {
  name: string;
  signature: string;
  example: string;
  type: 'method' | 'property';
  result?: string;
}

const catalog = new Map<string, Map<string, ScriptMember>>();

function group(owner: string, receiver = owner) {
  const members = new Map<string, ScriptMember>();
  catalog.set(owner, members);
  return {
    property(name: string, type: string, example = `pm.log(${receiver}.${name})`, result?: string) {
      members.set(name, { name, signature: `${receiver}.${name}: ${type}`, example, type: 'property', result });
    },
    method(names: string, parameters: string, returns: string, args: string, result?: string) {
      for (const name of names.split(' ')) {
        members.set(name, { name, signature: `${receiver}.${name}(${parameters}): ${returns}`, example: `${receiver}.${name}(${args})`, type: 'method', result });
      }
    },
  };
}

const pm = group('pm');
for (const [name, example] of Object.entries({
  variables: 'pm.variables.replaceIn("{{baseUrl}}/users")', environment: 'pm.environment.get("baseUrl")',
  globals: 'pm.globals.get("runId")', collectionVariables: 'pm.collectionVariables.get("version")',
  iterationData: 'pm.iterationData.get("userId")', cookies: 'pm.cookies.names()', crypto: 'pm.crypto.uuid()',
  request: 'pm.log(pm.request.url)', response: 'pm.log(pm.response.code)', info: 'pm.log(pm.info.requestName)',
  execution: 'if (!pm.environment.get("baseUrl")) pm.execution.skipRequest()',
})) pm.property(name, 'object', example, `pm.${name}`);
pm.method('expect', 'value', 'Assertion', 'pm.info.requestName', 'assertion');
pm.method('test', 'name, callback', 'void', '"URL is set", () => pm.expect(pm.request.url).to.be.ok');
pm.method('log', '...values', 'void', 'pm.info.requestName');
pm.method('sendRequest', 'urlOrOptions, callback?', 'Response | callback result', '"https://api.example.com/status"', 'sentResponse');

for (const scope of ['variables', 'environment', 'globals', 'collectionVariables']) {
  const vars = group(`pm.${scope}`);
  vars.method('get', 'key', 'string | undefined', '"baseUrl"');
  vars.method('set', 'key, value', 'void', '"baseUrl", "https://api.example.com"');
  vars.method('unset', 'key', 'void', '"baseUrl"');
  vars.method('clear', '', 'void', '');
  if (scope === 'variables') vars.method('replaceIn', 'text', 'string', '"{{baseUrl}}/users"');
}
group('pm.iterationData').method('get', 'key', 'string | undefined', '"userId"');
const cookies = group('pm.cookies');
cookies.method('get', 'name', 'string | undefined', '"session"');
cookies.method('has', 'name', 'boolean', '"session"');
cookies.method('names', '', 'string[]', '');
group('pm.execution').method('skipRequest', '', 'void', '');
const info = group('pm.info');
info.property('requestName', 'string', 'if (pm.info.requestName === "Login") pm.log("Signing in")');
info.property('eventName', '"prerequest" | "test"');
info.property('iteration', 'number');
info.property('iterationCount', 'number');

const crypto = group('pm.crypto');
crypto.method('md5 sha1 sha256 sha384 sha512', 'data, encoding?', 'string', 'pm.request.body.raw');
crypto.method('hmacSha1 hmacSha256 hmacSha384 hmacSha512', 'data, key, encoding?', 'string', 'pm.request.body.raw, pm.environment.get("secret")');
crypto.method('hash', 'algorithm, data, encoding?', 'string', '"sha256", pm.request.body.raw');
crypto.method('hmac', 'algorithm, data, key, encoding?', 'string', '"sha256", pm.request.body.raw, pm.environment.get("secret")');
crypto.method('base64Encode', 'data', 'string', '"hello"');
crypto.method('base64Decode', 'data', 'string', '"aGVsbG8="');
crypto.method('randomHex', 'bytes?', 'string', '16');
crypto.method('uuid', '', 'string', '');

const req = group('pm.request');
req.property('method', 'string');
req.property('url', 'string');
req.method('set_url setUrl', 'url', 'void', '"https://api.example.com/users"');
req.method('setBody', 'value', 'void', '{ active: true }');
for (const [name, key] of [['headers', 'Accept'], ['params', 'page'], ['pathVariables', 'id']]) {
  const receiver = `pm.request.${name}`;
  req.property(name, 'object', `${receiver}.get("${key}")`, receiver);
  const fields = group(receiver);
  fields.method('get', 'key', 'string | undefined', `"${key}"`);
  fields.method('set', 'key, value', 'void', `"${key}", "${name === 'headers' ? 'application/json' : '1'}"`);
  if (name === 'pathVariables') {
    fields.method('has', 'key', 'boolean', '"id"');
    fields.method('toObject', '', 'object', '');
  } else fields.method('unset', 'key', 'void', `"${key}"`);
  if (name === 'headers') fields.method('add', 'header', 'void', '{ key: "Accept", value: "application/json" }');
}
req.property('auth', 'object', 'pm.request.auth.parameters().all()', 'pm.request.auth');
const auth = group('pm.request.auth');
auth.property('type', 'string');
auth.method('parameters', '', 'ParameterList', '', 'pm.request.auth.parameters()');
req.property('body', 'object', 'pm.request.body.json()', 'pm.request.body');
const body = group('pm.request.body');
body.property('raw', 'string');
body.property('mode', 'string');
body.method('update', 'value', 'void', '{ active: true }');
body.method('toString', '', 'string', '');
body.method('json', '', 'JSON', '');
const authTypes = ['bearer', 'basic', 'digest', 'ntlm', 'apikey', 'awsv4', 'oauth1', 'oauth2', 'jwt', 'noauth'];
for (const kind of authTypes) {
  auth.property(kind, 'ParameterList | undefined', `pm.request.auth.${kind}?.all()`, `pm.request.auth.${kind}`);
}
for (const kind of ['formdata', 'urlencoded']) body.property(kind, 'FieldList | undefined', `pm.request.body.${kind}?.all()`, `pm.request.body.${kind}`);
for (const receiver of [...['parameters()', ...authTypes].map(kind => `pm.request.auth.${kind}`), 'pm.request.body.formdata', 'pm.request.body.urlencoded']) {
  const list = group(receiver);
  const form = receiver.startsWith('pm.request.body.');
  const key = form ? 'scope' : 'token';
  list.method('get', 'key', 'value | undefined', `"${key}"`);
  list.method('has', 'key', 'boolean', `"${key}"`);
  list.method('one', 'key', 'entry | undefined', `"${key}"`, form ? 'formEntry' : 'authEntry');
  list.method('all toJSON', '', 'entry[]', '');
  list.method('count', '', 'number', '');
  list.method('each', 'callback', 'void', 'entry => pm.log(entry.key)');
  list.method('toObject', '', 'object', '');
  if (form) {
    list.method('add upsert', 'fieldOrKey, value?', 'void', '{ key: "scope", value: "read" }');
    list.method('remove', 'keyOrPredicate', 'void', '"scope"');
    list.method('clear', '', 'void', '');
  }
}
for (const [owner, receiver] of [['formEntry', 'pm.request.body.formdata.one("scope")'], ['authEntry', 'pm.request.auth.parameters().one("token")']]) {
  const entry = group(owner, receiver);
  for (const key of ['key', 'value', 'type']) entry.property(key, key === 'value' ? 'value' : 'string');
  if (owner === 'formEntry') {
    entry.property('disabled', 'boolean | undefined');
    entry.property('fileName', 'string | undefined');
    entry.property('contentType', 'string | undefined');
  }
}

for (const owner of ['pm.response', 'sentResponse']) {
  const sent = owner === 'sentResponse';
  const receiver = sent ? 'pm.sendRequest("https://api.example.com/status")' : owner;
  const res = group(owner, receiver);
  for (const name of ['code', 'responseTime', 'time', 'size']) res.property(name, 'number');
  res.property('status', 'string');
  res.property('headers', 'object', `${receiver}.headers.get("Content-Type")`, `${owner}.headers`);
  group(`${owner}.headers`, `${receiver}.headers`).method('get', 'name', 'string | undefined', '"Content-Type"');
  res.property('to', 'Assertion', `${receiver}.to.have.status(200)`, 'assertion');
  res.method('json', '', 'JSON', '');
  res.method('text', '', 'string', '');
  if (sent) res.method('body', '', 'string', '');
  else {
    res.property('body', 'string');
    res.method('llm', '', 'AI response', '', 'pm.response.llm()');
  }
}
const llm = group('pm.response.llm()');
for (const name of ['text', 'thinking', 'stopReason', 'model', 'error']) llm.property(name, 'string');
for (const name of ['steps', 'toolCalls']) llm.property(name, 'object[]');
for (const [name, keys] of [['usage', ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'cost']], ['timing', ['firstToken', 'total']]] as const) {
  const path = `pm.response.llm().${name}`;
  llm.property(name, 'object', `pm.log(${path}.${keys[0]})`, path);
  const fields = group(path);
  for (const key of keys) fields.property(key, 'number');
}

const assertion = group('assertion', 'pm.expect(value)');
for (const name of 'to be been is that which and has have with of same but does still at not deep all any'.split(' ')) {
  assertion.property(name, 'Assertion', `pm.expect(value).${name}.equal(expected)`, 'assertion');
}
for (const name of 'ok true false null undefined exist empty'.split(' ')) {
  assertion.property(name, 'Assertion', `pm.expect(value).to.be.${name}`, 'assertion');
}
assertion.method('equal equals eq eql eqls', 'expected', 'Assertion', 'expected', 'assertion');
assertion.method('a an', 'type', 'Assertion', '"string"', 'assertion');
assertion.method('include includes contain contains', 'expected', 'Assertion', '"active"', 'assertion');
assertion.method('property', 'name, value?', 'Assertion', '"id"', 'assertion');
assertion.method('keys key', '...keys', 'Assertion', '"id", "name"', 'assertion');
assertion.method('lengthOf length', 'length', 'Assertion', '2', 'assertion');
assertion.method('above gt greaterThan below lt lessThan least most', 'number', 'Assertion', '100', 'assertion');
assertion.method('within', 'min, max', 'Assertion', '1, 10', 'assertion');
assertion.method('match', 'pattern', 'Assertion', '/active/i', 'assertion');
assertion.method('oneOf', 'values', 'Assertion', '[200, 201]', 'assertion');
assertion.method('jsonSchema', 'schema', 'Assertion', '{ type: "object", required: ["id"] }', 'assertion');
assertion.method('jsonBody', 'pathOrObject?, value?', 'Assertion', '"user.id", 1', 'assertion');
assertion.method('status', 'code', 'Assertion', '200', 'assertion');
assertion.method('header', 'name', 'Assertion', '"Content-Type"', 'assertion');

export function scriptMembers(owner: string) {
  return catalog.get(owner);
}
