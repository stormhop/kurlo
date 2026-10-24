import { describe, expect, it } from 'vitest';
import { buildPostmanCollection, postmanRequestsFromItems } from '../lib/postman';
import { buildInsomniaExport, insomniaRequestsFromResources } from '../lib/insomnia';
import { authStateHasData, emptyAuthState, oauth1ConfigFields, oauth1FieldsFromAuth } from '../lib/utils';
import type { SavedRequest } from '../lib/types/models';

const postmanOAuth1 = {
  type: 'oauth1',
  oauth1: [
    { key: 'consumerKey', value: 'ck', type: 'string' },
    { key: 'consumerSecret', value: 'cs', type: 'string' },
    { key: 'token', value: 'tk', type: 'string' },
    { key: 'tokenSecret', value: 'ts', type: 'string' },
    { key: 'signatureMethod', value: 'HMAC-SHA256', type: 'string' },
    { key: 'realm', value: 'Photos', type: 'string' },
    { key: 'callback', value: 'https://example.test/cb', type: 'string' },
    { key: 'verifier', value: 'v1', type: 'string' },
    { key: 'version', value: '1.0', type: 'string' },
    { key: 'addParamsToHeader', value: false, type: 'boolean' },
    { key: 'includeBodyHash', value: true, type: 'boolean' },
    { key: 'addEmptyParamsToSign', value: true, type: 'boolean' },
  ],
};

function importedRequest(): SavedRequest {
  const [req] = postmanRequestsFromItems([{
    name: 'Signed',
    request: { method: 'GET', url: 'https://api.example.test/photos', auth: postmanOAuth1 },
  }], 'collection-1', 'API', undefined);
  return req;
}

describe('OAuth 1.0', () => {
  it('imports every Postman OAuth 1.0 setting', () => {
    const auth = importedRequest().auth;
    expect(auth).toMatchObject({
      type: 'oauth1',
      oauth1ConsumerKey: 'ck', oauth1ConsumerSecret: 'cs', oauth1Token: 'tk', oauth1TokenSecret: 'ts',
      oauth1SignatureMethod: 'HMAC-SHA256', oauth1Realm: 'Photos', oauth1Callback: 'https://example.test/cb',
      oauth1Verifier: 'v1', oauth1Version: '1.0', oauth1AddTo: 'query',
      oauth1IncludeBodyHash: true, oauth1AddEmptyParams: true,
    });
  });

  it('exports to Postman without secrets unless asked, and round-trips with them', () => {
    const req = importedRequest();
    const strip = (s: string) => s;
    const redacted = JSON.stringify(buildPostmanCollection('API', '', [req], strip, false));
    expect(redacted).not.toContain('"cs"');
    expect(redacted).not.toContain('"ts"');
    expect(redacted).toContain('"consumerKey"');

    const full = buildPostmanCollection('API', '', [req], strip, true) as { item: Array<{ request: { auth: unknown } }> };
    const [again] = postmanRequestsFromItems([{ name: 'Signed', request: { method: 'GET', url: 'https://api.example.test/photos', auth: full.item[0].request.auth } }], 'collection-1', 'API', undefined);
    expect(again.auth).toMatchObject({ ...req.auth });
  });

  it('round-trips through Insomnia', () => {
    const req = importedRequest();
    const exported = buildInsomniaExport('API', '', [req], s => s, true);
    const [again] = insomniaRequestsFromResources(exported, 'collection-1', 'API');
    expect(again.auth).toMatchObject({
      type: 'oauth1', oauth1ConsumerKey: 'ck', oauth1ConsumerSecret: 'cs', oauth1Token: 'tk',
      oauth1TokenSecret: 'ts', oauth1SignatureMethod: 'HMAC-SHA256', oauth1Realm: 'Photos',
    });
  });

  it('fills the backend config with defaults and resolved variables', () => {
    const auth = { ...emptyAuthState(), type: 'oauth1' as const, oauth1ConsumerKey: '{{key}}' };
    expect(authStateHasData(auth)).toBe(true);
    expect(oauth1FieldsFromAuth(auth)).toMatchObject({ signatureMethod: 'HMAC-SHA1', addTo: 'header', version: '1.0' });
    expect(oauth1ConfigFields(auth, value => value.replace('{{key}}', 'resolved'))).toMatchObject({
      oauth1ConsumerKey: 'resolved', oauth1SignatureMethod: 'HMAC-SHA1', oauth1AddTo: 'header',
    });
  });
});

describe('OAuth 1.0 defaults', () => {
  it('match between a loaded request and the editor, so an untouched request is not dirty', async () => {
    const { normalizeSavedRequest } = await import('../lib/normalizers');
    const { oauth1AuthFields } = await import('../lib/utils');
    const loaded = normalizeSavedRequest({ id: 'r1', name: 'r1', method: 'GET', url: 'https://api.test' }, [], '');
    const editor = oauth1AuthFields(oauth1FieldsFromAuth(loaded.auth));
    for (const [key, value] of Object.entries(editor)) {
      expect(loaded.auth[key as keyof typeof loaded.auth]).toEqual(value);
    }
  });
});
