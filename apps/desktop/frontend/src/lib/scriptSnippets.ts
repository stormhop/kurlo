
export type ScriptSnippet = { label: string; code: string };

export const preRequestSnippets: readonly ScriptSnippet[] = [
  { label: 'Set environment variable', code: 'pm.environment.set("baseUrl", "https://api.example.com")' },
  { label: 'Set collection variable', code: 'pm.collectionVariables.set("key", "value")' },
  { label: 'Set global variable', code: 'pm.globals.set("key", "value")' },
  { label: 'Add header', code: 'pm.request.headers.set("X-Token", pm.environment.get("token"))' },
  { label: 'Add query param', code: 'pm.request.params.set("page", "1")' },
  { label: 'Rewrite URL', code: 'pm.request.set_url("https://api.example.com/v2/users")' },
  {
    label: 'Edit JSON body',
    code: [
      'const body = pm.request.body.json()',
      'body.timestamp = Date.now()',
      'pm.request.body.update(JSON.stringify(body))',
    ].join('\n'),
  },
  {
    label: 'Sign body (HMAC)',
    code: [
      'const signature = pm.crypto.hmacSha256(pm.request.body.raw, pm.environment.get("secret"))',
      'pm.request.headers.set("X-Signature", signature)',
    ].join('\n'),
  },
  {
    label: 'Fetch a token first',
    code: [
      'pm.sendRequest({',
      '  url: pm.environment.get("tokenUrl"),',
      '  method: "POST",',
      '  header: { "Content-Type": "application/json" },',
      '  body: JSON.stringify({ client_id: pm.environment.get("clientId") })',
      '}, (err, res) => {',
      '  if (err) throw err',
      '  pm.environment.set("token", res.json().access_token)',
      '})',
    ].join('\n'),
  },
  { label: 'Skip this request', code: 'if (!pm.environment.get("token")) pm.execution.skipRequest()' },
  { label: 'Log a value', code: 'console.log("token", pm.environment.get("token"))' },
];

export const testSnippets: readonly ScriptSnippet[] = [
  { label: 'Status is 200', code: 'pm.test("Status is 200", () => pm.response.to.have.status(200))' },
  { label: 'Status is one of', code: 'pm.test("Status is 2xx", () => pm.expect([200, 201, 204]).to.include(pm.response.code))' },
  { label: 'Response is fast', code: 'pm.test("Under 500ms", () => pm.expect(pm.response.responseTime).to.be.below(500))' },
  { label: 'Header is present', code: 'pm.test("Has Content-Type", () => pm.response.to.have.header("Content-Type"))' },
  {
    label: 'Body has property',
    code: [
      'const data = pm.response.json()',
      'pm.test("Has id", () => pm.expect(data).to.have.property("id"))',
    ].join('\n'),
  },
  { label: 'Body contains text', code: 'pm.test("Mentions ok", () => pm.expect(pm.response.text()).to.include("ok"))' },
  {
    label: 'Body matches JSON schema',
    code: [
      'const schema = {',
      '  type: "object",',
      '  required: ["id", "name"],',
      '  properties: {',
      '    id: { type: "integer" },',
      '    name: { type: "string" }',
      '  }',
      '}',
      'pm.test("Body matches the schema", () => pm.response.to.have.jsonSchema(schema))',
    ].join('\n'),
  },
  { label: 'Every item has a field', code: 'pm.test("All items have ids", () => pm.expect(pm.response.json().every(item => item.id !== undefined)).to.be.true)' },
  { label: 'Save value for next request', code: 'pm.environment.set("userId", String(pm.response.json().id))' },
  { label: 'Use lodash', code: 'const _ = require("lodash")\npm.test("Has an admin", () => pm.expect(_.some(pm.response.json(), { role: "admin" })).to.be.true)' },
];

export function appendSnippet(source: string, code: string): string {
  const existing = source.replace(/\s+$/, '');
  return existing ? `${existing}\n${code}\n` : `${code}\n`;
}
