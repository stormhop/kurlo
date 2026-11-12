import { describe, expect, it } from 'vitest';
import { buildPostmanCollection, postmanRequestsFromItems } from '../lib/postman';
import { buildOpenApiDocument } from '../lib/openapi';
import { buildSnippet, type SnippetRequest } from '../lib/snippets';
import { toCurl } from '../lib/curl';
import { findFields, setFindField } from '../lib/findReplace';
import { authStateHasData, emptyAuthState, jwtAlgorithmUsesSecret, jwtAuthFields, jwtConfigFields, jwtFieldsFromAuth } from '../lib/utils';
import { emptyAuthConfig } from '../lib/wire';
import type { SavedRequest } from '../lib/types/models';

const postmanJwt = {
  type: 'jwt',
  jwt: [
    { key: 'algorithm', value: 'HS384', type: 'string' },
    { key: 'secret', value: 'signing-secret', type: 'string' },
    { key: 'isSecretBase64Encoded', value: true, type: 'boolean' },
    { key: 'payload', value: '{\n  "sub": "{{userId}}"\n}', type: 'string' },
    { key: 'addTokenTo', value: 'queryParam', type: 'string' },
    { key: 'headerPrefix', value: 'JWT', type: 'string' },
    { key: 'queryParamKey', value: 'access_token', type: 'string' },
    { key: 'header', value: '{"kid":"key-1"}', type: 'string' },
  ],
};

function importedRequest(auth: unknown = postmanJwt): SavedRequest {
  const [req] = postmanRequestsFromItems([{
    name: 'Signed',
    request: { method: 'GET', url: 'https://api.example.test/me', auth },
  }], 'collection-1', 'API', undefined);
  return req;
}

function snippetRequest(auth: Partial<SnippetRequest['auth']>): SnippetRequest {
  return {
    method: 'GET', url: 'https://api.example.test/me', params: [], headers: [], formData: [], bodyType: 'none', body: '',
    auth: { type: 'jwt', token: '', keyName: '', keyValue: '', keyIn: 'header', ...auth },
  };
}

describe('JWT Bearer auth', () => {
  it('imports every Postman JWT Bearer setting', () => {
    expect(importedRequest().auth).toMatchObject({
      type: 'jwt', jwtAlgorithm: 'HS384', jwtSecret: 'signing-secret', jwtSecretBase64: true,
      jwtPayload: '{\n  "sub": "{{userId}}"\n}', jwtHeaders: '{"kid":"key-1"}',
      jwtAddTo: 'query', jwtHeaderPrefix: 'JWT', jwtQueryParam: 'access_token',
    });
  });

  it('fills Postman defaults and drops empty JSON placeholders', () => {
    const auth = importedRequest({ type: 'jwt', jwt: [{ key: 'algorithm', value: 'nope' }, { key: 'payload', value: '{}' }, { key: 'header', value: {} }] }).auth;
    expect(auth).toMatchObject({ type: 'jwt', jwtAlgorithm: 'HS256', jwtPayload: '', jwtHeaders: '', jwtAddTo: 'header', jwtHeaderPrefix: 'Bearer', jwtQueryParam: 'token' });
  });

  it('exports to Postman without the secret unless asked, and round-trips with it', () => {
    const req = importedRequest();
    const redacted = JSON.stringify(buildPostmanCollection('API', '', [req], s => s, false));
    expect(redacted).not.toContain('signing-secret');
    expect(redacted).toContain('"type":"jwt"');
    expect(redacted).toContain('"queryParamKey"');

    const full = buildPostmanCollection('API', '', [req], s => s, true) as { item: Array<{ request: { auth: unknown } }> };
    const again = importedRequest(full.item[0].request.auth);
    expect(again.auth).toMatchObject({ ...req.auth });
  });

  it('keeps private keys out of a redacted export', () => {
    const req = importedRequest({ type: 'jwt', jwt: [{ key: 'algorithm', value: 'RS256' }, { key: 'privateKey', value: '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----' }] });
    expect(req.auth.jwtAlgorithm).toBe('RS256');
    expect(JSON.stringify(buildPostmanCollection('API', '', [req], s => s, false))).not.toContain('MIIabc');
  });

  it('builds editor fields and the backend config with defaults and resolved variables', () => {
    const blank = { ...emptyAuthState(), type: 'jwt' as const };
    expect(authStateHasData(blank)).toBe(false);
    expect(jwtFieldsFromAuth(blank)).toMatchObject({ algorithm: 'HS256', addTo: 'header', headerPrefix: 'Bearer', queryParam: 'token', secretBase64: false });
    const auth = { ...blank, jwtSecret: '{{key}}', jwtPayload: '{"sub":"{{user}}"}' };
    expect(authStateHasData(auth)).toBe(true);
    const config = { ...emptyAuthConfig(), type: 'jwt', ...jwtConfigFields(auth, value => value.replace('{{key}}', 'k').replace('{{user}}', '42')) };
    expect(config).toMatchObject({ type: 'jwt', jwtAlgorithm: 'HS256', jwtSecret: 'k', jwtPayload: '{"sub":"42"}', jwtAddTo: 'header', jwtHeaderPrefix: 'Bearer' });
    expect(jwtAlgorithmUsesSecret('HS512')).toBe(true);
    expect(jwtAlgorithmUsesSecret('ES256')).toBe(false);
  });

  it('matches between a loaded request and the editor, so an untouched request is not dirty', async () => {
    const { normalizeSavedRequest } = await import('../lib/normalizers');
    for (const raw of [
      { id: 'r1', name: 'r1', method: 'GET', url: 'https://api.test' },
      { id: 'r2', name: 'r2', method: 'GET', url: 'https://api.test', auth: { type: 'jwt', jwtSecret: 'k' } },
    ]) {
      const loaded = normalizeSavedRequest(raw, [], '');
      const editor = jwtAuthFields(jwtFieldsFromAuth(loaded.auth));
      for (const [key, value] of Object.entries(editor)) {
        expect(loaded.auth[key as keyof typeof loaded.auth]).toEqual(value);
      }
    }
  });

  it('writes a placeholder token in code snippets instead of signing with redacted secrets', () => {
    const header = buildSnippet('curl', snippetRequest({ jwtHeaderPrefix: 'JWT' }), toCurl);
    expect(header).toContain('Authorization: JWT {{jwtToken}}');
    expect(header).toContain('Kurlo signs a fresh token on every send');

    const query = buildSnippet('python', snippetRequest({ jwtAddTo: 'query', jwtQueryParam: 'access_token' }), toCurl);
    expect(query).toContain('access_token={{jwtToken}}');
    expect(query).not.toContain('Authorization');

    const curl = toCurl({ ...snippetRequest({ jwtAddTo: 'query' }), params: [{ key: 'page', value: '2', enabled: true }] });
    expect(curl).toContain('https://api.example.test/me?page=2&token={{jwtToken}}');
  });

  it('exports an OpenAPI bearer scheme with the JWT format', () => {
    const header = buildOpenApiDocument('API', '', [importedRequest({ type: 'jwt', jwt: [{ key: 'secret', value: 'k' }] })], s => s) as { components: { securitySchemes: Record<string, unknown> } };
    expect(header.components.securitySchemes.jwtBearerAuth).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    const query = buildOpenApiDocument('API', '', [importedRequest()], s => s) as { components: { securitySchemes: Record<string, unknown> } };
    expect(query.components.securitySchemes.jwtQuery).toMatchObject({ type: 'apiKey', in: 'query', name: 'access_token' });
  });

  it('offers the payload to Find and replace, but not the secret', () => {
    const req = importedRequest();
    const fields = findFields(req);
    expect(fields.find(field => field.id === 'auth.jwtPayload')?.value).toContain('{{userId}}');
    expect(fields.some(field => field.value.includes('signing-secret'))).toBe(false);
    expect(setFindField(req, 'auth.jwtPayload', '{"sub":"{{accountId}}"}').auth.jwtPayload).toBe('{"sub":"{{accountId}}"}');
  });
});
