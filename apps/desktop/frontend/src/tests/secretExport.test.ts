import { describe, expect, it } from 'vitest';
import { DEFAULT_REQUEST_SETTINGS } from '../lib/constants';
import { emptyCollectionDefaults } from '../lib/collectionDefaults';
import { normalizeRequestExample } from '../lib/examples';
import { buildInsomniaExport } from '../lib/insomnia';
import { buildOpenCollectionFiles } from '../lib/opencollection';
import { buildPostmanCollection } from '../lib/postman';
import { requestsHaveExportSecrets } from '../lib/secretExport';
import type { SavedRequest } from '../lib/types/models';
import { emptyAuthState } from '../lib/utils';

function request(overrides: Partial<SavedRequest> = {}): SavedRequest {
  return {
    id: 'req-secret',
    name: 'Secret request',
    filesystemName: 'Secret-request',
    collectionId: 'collection-1',
    collection: 'API',
    folderPath: [],
    method: 'GET',
    url: 'https://api.example.test/me',
    requestTab: 'auth',
    params: [],
    headers: [],
    auth: emptyAuthState(),
    bodyType: 'none',
    rawBodyType: 'json',
    bodyContent: '',
    bodyFilePath: '',
    bodyFileName: '',
    formRows: [],
    preRequestScript: '',
    testScript: '',
    requestNotes: '',
    settings: { ...DEFAULT_REQUEST_SETTINGS },
    ...overrides,
  };
}

describe('requestsHaveExportSecrets', () => {
  it('treats OAuth refresh tokens as export secrets', () => {
    const req = request({
      auth: {
        ...emptyAuthState(),
        type: 'oauth2',
        oauth2RefreshToken: 'raw-refresh-token',
      },
    });

    expect(requestsHaveExportSecrets([req])).toBe(true);
  });

  it('detects credentials in request settings and saved example snapshots', () => {
    for (const overrides of [
      { settings: { ...DEFAULT_REQUEST_SETTINGS, clientKeyPassword: 'client-password' } },
      { settings: { ...DEFAULT_REQUEST_SETTINGS, proxyUrl: 'http://user:proxy-password@proxy.test' } },
      { examples: [normalizeRequestExample({ snapshot: { method: 'GET', url: 'https://example.test?token=example-token', headers: [] } }, 'req-secret')] },
      { examples: [normalizeRequestExample({ snapshot: { method: 'POST', url: 'https://example.test', headers: [], bodyType: 'json', bodyContent: '{"password":"example-password"}' } }, 'req-secret')] },
    ] satisfies Partial<SavedRequest>[]) {
      expect(requestsHaveExportSecrets([request(overrides)])).toBe(true);
    }
  });
});

describe('safe collection exports', () => {
  const builders = {
    openCollection: (req: SavedRequest, include: boolean) => buildOpenCollectionFiles('API', '', emptyCollectionDefaults(), [req], [], value => value, include),
    postman: (req: SavedRequest, include: boolean) => buildPostmanCollection('API', '', [req], value => value, include),
    insomnia: (req: SavedRequest, include: boolean) => buildInsomniaExport('API', '', [req], value => value, include),
  };

  for (const [format, build] of Object.entries(builders)) {
    it(`redacts custom API keys in ${format} and preserves explicitly included values and templates`, () => {
      const req = request({ auth: { ...emptyAuthState(), type: 'apikey', apiKeyName: 'X-Auth', apiKeyValue: 'raw-api-secret' } });
      expect(JSON.stringify(build(req, false))).not.toContain('raw-api-secret');
      expect(JSON.stringify(build(req, true))).toContain('raw-api-secret');
      const template = request({ auth: { ...req.auth, apiKeyValue: '{{credential}}' } });
      expect(JSON.stringify(build(template, false))).toContain('{{credential}}');
      expect(req.auth.apiKeyValue).toBe('raw-api-secret');
    });

    it(`redacts client key passwords and proxy credentials in ${format}`, () => {
      const req = request({ settings: {
        ...DEFAULT_REQUEST_SETTINGS,
        clientKeyPassword: 'raw-client-password',
        proxyUrl: 'http://alice:raw-proxy-password@proxy.test:8080',
      } });
      const safe = JSON.stringify(build(req, false));
      expect(safe).not.toContain('raw-client-password');
      expect(safe).not.toContain('raw-proxy-password');
      expect(safe).toContain('proxy.test:8080');
      const included = JSON.stringify(build(req, true));
      expect(included).toContain('raw-proxy-password');
      if (format !== 'openCollection') expect(included).toContain('raw-client-password');
      expect(req.settings.clientKeyPassword).toBe('raw-client-password');
      expect(req.settings.proxyUrl).toContain('raw-proxy-password');
    });
  }

  it('redacts saved Postman originalRequest URLs and JSON bodies without changing the saved example', () => {
    const example = normalizeRequestExample({
      name: 'Login',
      snapshot: {
        method: 'POST', url: 'https://user:url-secret@example.test?token=query-secret', headers: [],
        bodyType: 'json', bodyContent: '{"password":"body-secret","user":"alice"}',
      },
    }, 'req-secret');
    const req = request({ examples: [example] });
    const safe = JSON.stringify(builders.postman(req, false));
    for (const secret of ['url-secret', 'query-secret', 'body-secret']) expect(safe).not.toContain(secret);
    expect(safe).toContain('alice');
    const included = JSON.stringify(builders.postman(req, true));
    for (const secret of ['url-secret', 'query-secret', 'body-secret']) expect(included).toContain(secret);
    expect(example.snapshot.bodyContent).toContain('body-secret');
  });
});
