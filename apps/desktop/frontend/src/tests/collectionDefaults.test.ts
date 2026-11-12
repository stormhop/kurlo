import { describe, expect, it } from 'vitest';
import {
  applyCollectionDefaultsToRequest,
  collectionDefaultsHaveContent,
  collectionSecretVariableKeys,
  collectionSecretVariableValues,
  collectionSettingsFingerprint,
  emptyCollectionDefaults,
  mergeDefaultRows,
  normalizeCollectionDefaults,
  valuesWithBrunoPriority,
  REQUEST_SETTING_KEYS,
} from '../lib/collectionDefaults';
import { DEFAULT_REQUEST_SETTINGS, mkRow } from '../lib/constants';
import type { Collection, SavedRequest } from '../lib/types/models';
import { emptyAuthState, inheritAuthState, restoreRows } from '../lib/utils';

function row(key: string, value: string, enabled = true) {
  return { ...mkRow(), key, value, enabled };
}

const baseRequest: SavedRequest = {
  id: 'request-1',
  name: 'Users',
  filesystemName: 'Users',
  requestType: 'http',
  collectionId: 'collection-1',
  collection: 'Core',
  folderPath: [],
  method: 'GET',
  url: 'https://example.test/users',
  requestTab: 'params',
  params: [],
  headers: [],
  auth: emptyAuthState(),
  bodyType: 'none',
  rawBodyType: 'json',
  bodyContent: '',
  bodyFilePath: '',
  bodyFileName: '',
  formRows: [],
  graphqlSchema: '',
  preRequestScript: '',
  testScript: '',
  requestNotes: '',
  settings: { ...DEFAULT_REQUEST_SETTINGS },
  sioEvents: [],
  sioEventName: '',
  sioArgs: [],
  sioAck: false,
};

function collection(defaults = emptyCollectionDefaults()): Collection {
  return {
    id: 'collection-1',
    workspaceId: 'workspace-1',
    name: 'Core',
    filesystemName: 'Core',
    description: '',
    collapsed: false,
    defaults,
  };
}

describe('collection defaults', () => {
  it('applies collection headers unless a request shadows the same key', () => {
    const merged = mergeDefaultRows(
      [row('X-Team', 'platform'), row('X-Trace', 'collection')],
      [row('X-Trace', 'request'), row('Accept', 'application/json')],
    );

    expect(merged.map(item => [item.key, item.value])).toEqual([
      ['X-Team', 'platform'],
      ['X-Trace', 'request'],
      ['Accept', 'application/json'],
    ]);
  });

  it('inherits auth, scripts and non-default transport settings', () => {
    const defaults = emptyCollectionDefaults();
    defaults.auth = { ...emptyAuthState(), type: 'bearer', bearerToken: '{{token}}' };
    defaults.preRequestScript = 'pm.log("collection")';
    defaults.testScript = 'pm.test("ok", true)';
    defaults.settings = { ...DEFAULT_REQUEST_SETTINGS, timeoutMs: 12000, proxyUrl: 'http://localhost:8080' };

    const merged = applyCollectionDefaultsToRequest({ ...baseRequest, auth: inheritAuthState() }, collection(defaults));

    expect(merged.auth.type).toBe('bearer');
    expect(merged.preRequestScript).toContain('collection');
    expect(merged.testScript).toContain('ok');
    expect(merged.settings.timeoutMs).toBe(12000);
    expect(merged.settings.proxyUrl).toBe('http://localhost:8080');
  });

  it('merges per-engine default scripts independently', () => {
    const defaults = emptyCollectionDefaults();
    defaults.preRequestScript = 'pm.log("tengo-default")';
    defaults.preRequestScriptJs = 'console.log("js-default")';
    defaults.testScriptJs = 'pm.test("js", () => {})';

    const request = { ...baseRequest, preRequestScript: 'pm.log("tengo-req")', preRequestScriptJs: 'console.log("js-req")' };
    const merged = applyCollectionDefaultsToRequest(request, collection(defaults));

    expect(merged.preRequestScript).toContain('tengo-default');
    expect(merged.preRequestScript).toContain('tengo-req');
    expect(merged.preRequestScriptJs).toContain('js-default');
    expect(merged.preRequestScriptJs).toContain('js-req');
    expect(merged.testScriptJs).toContain('js');
  });

  it('treats a JS-only default script as collection content', () => {
    const defaults = emptyCollectionDefaults();
    defaults.preRequestScriptJs = 'console.log("only js")';
    expect(collectionDefaultsHaveContent(defaults)).toBe(true);
  });

  it('inherits every request setting the collection can carry, script settings included', () => {
    expect([...REQUEST_SETTING_KEYS].sort()).toEqual(Object.keys(DEFAULT_REQUEST_SETTINGS).sort());
  });

  it('inherits the script timeout and the pm.sendRequest permission from the collection', () => {
    const defaults = emptyCollectionDefaults();
    defaults.settings = { ...DEFAULT_REQUEST_SETTINGS, scriptTimeoutMs: 15000, allowSendRequest: true };

    const merged = applyCollectionDefaultsToRequest(baseRequest, collection(defaults));

    expect(merged.settings.scriptTimeoutMs).toBe(15000);
    expect(merged.settings.allowSendRequest).toBe(true);
    expect(collectionDefaultsHaveContent(defaults)).toBe(true);
  });

  it('keeps request-specific settings over collection defaults', () => {
    const defaults = emptyCollectionDefaults();
    defaults.settings = { ...DEFAULT_REQUEST_SETTINGS, timeoutMs: 12000 };
    const request = { ...baseRequest, settings: { ...DEFAULT_REQUEST_SETTINGS, timeoutMs: 45000 }, settingsOverrides: { timeoutMs: true } };

    const merged = applyCollectionDefaultsToRequest(request, collection(defaults));

    expect(merged.settings.timeoutMs).toBe(45000);
  });

  it('inherits gRPC reflection from collection settings', () => {
    const defaults = emptyCollectionDefaults();
    defaults.settings = { ...DEFAULT_REQUEST_SETTINGS, grpcUseReflection: false };
    const request: SavedRequest = {
      ...baseRequest,
      requestType: 'grpc',
      method: 'POST',
      settings: { ...DEFAULT_REQUEST_SETTINGS },
    };

    const merged = applyCollectionDefaultsToRequest(request, collection(defaults));

    expect(merged.settings.grpcUseReflection).toBe(false);
  });

  it('keeps explicit no-auth from inheriting collection auth', () => {
    const defaults = emptyCollectionDefaults();
    defaults.auth = { ...emptyAuthState(), type: 'bearer', bearerToken: '{{token}}' };

    const merged = applyCollectionDefaultsToRequest({ ...baseRequest, auth: emptyAuthState() }, collection(defaults));

    expect(merged.auth.type).toBe('none');
  });

  it('lets request settings override collection defaults back to global defaults', () => {
    const defaults = emptyCollectionDefaults();
    defaults.settings = { ...DEFAULT_REQUEST_SETTINGS, followRedirects: false };
    const request = {
      ...baseRequest,
      settings: { ...DEFAULT_REQUEST_SETTINGS, followRedirects: true },
      settingsOverrides: { followRedirects: true },
    };

    const merged = applyCollectionDefaultsToRequest(request, collection(defaults));

    expect(merged.settings.followRedirects).toBe(true);
  });

  it('runs request tests before collection tests like Bruno sandwich post flow', () => {
    const defaults = emptyCollectionDefaults();
    defaults.testScript = 'pm.test("collection", true)';
    const request = { ...baseRequest, testScript: 'pm.test("request", true)' };

    const merged = applyCollectionDefaultsToRequest(request, collection(defaults));

    expect(merged.testScript).toBe('pm.test("request", true)\n\npm.test("collection", true)');
  });

  it('resolves environment variables above collection values like Bruno', () => {
    const defaults = emptyCollectionDefaults();
    defaults.variables = [row('baseUrl', 'https://collection.example.test'), row('tenant', 'core')];

    expect(valuesWithBrunoPriority(collection(defaults), {
      baseUrl: 'https://environment.example.test',
      token: 'env-token',
    })).toEqual({
      baseUrl: 'https://environment.example.test',
      tenant: 'core',
      token: 'env-token',
    });
  });
});

describe('global variables', () => {
  it('sit below collection and environment values', () => {
    const defaults = emptyCollectionDefaults();
    defaults.variables = [row('tenant', 'collection')];

    expect(valuesWithBrunoPriority(collection(defaults), { baseUrl: 'https://env.test' }, {
      baseUrl: 'https://global.test',
      tenant: 'global',
      apiKey: 'global-key',
    })).toEqual({
      baseUrl: 'https://env.test',
      tenant: 'collection',
      apiKey: 'global-key',
    });
  });
});

describe('collection settings round-trip into requests', () => {
  it('applies headers, secret vars, auth, scripts and settings after a store persistence round-trip', () => {


    const stored = normalizeCollectionDefaults({
      headers: [{ ...mkRow(), key: 'X-Env', value: 'prod', description: 'environment' }],
      variables: [{ ...mkRow(), key: 'apiKey', value: 'sk-live-123', secret: true }],
      auth: { ...emptyAuthState(), type: 'bearer', bearerToken: '{{apiKey}}' },
      preRequestScript: 'pm.log("collection")',
      testScript: 'pm.test("collection", true)',
      settings: { ...DEFAULT_REQUEST_SETTINGS, timeoutMs: 9000 },
    });
    const col = collection(stored);

    const merged = applyCollectionDefaultsToRequest({ ...baseRequest, auth: inheritAuthState() }, col);

    const header = merged.headers.find(item => item.key === 'X-Env');
    expect(header?.value).toBe('prod');
    expect('isFile' in (header ?? {})).toBe(false);
    expect('secret' in (header ?? {})).toBe(false);
    expect(merged.auth.type).toBe('bearer');
    expect(merged.auth.bearerToken).toBe('{{apiKey}}');
    expect(merged.preRequestScript).toContain('collection');
    expect(merged.testScript).toContain('collection');
    expect(merged.settings.timeoutMs).toBe(9000);
    expect(collectionSecretVariableKeys(col)).toEqual(['apiKey']);
    expect(collectionSecretVariableValues(col)).toEqual(['sk-live-123']);
  });

  it('still resolves secret collection variables (masking) after cloneRowsForStore', () => {
    const stored = normalizeCollectionDefaults({
      variables: [
        { ...mkRow(), key: 'token', value: 's3cr3t', secret: true },
        { ...mkRow(), key: 'plain', value: 'visible' },
        { ...mkRow(), key: 'disabledSecret', value: 'skip', secret: true, enabled: false },
      ],
    });

    expect(collectionSecretVariableKeys(collection(stored))).toEqual(['token']);
    expect(collectionSecretVariableValues(collection(stored))).toEqual(['s3cr3t']);
  });

  it('keeps the settings fingerprint stable across a clone round-trip (no false dirty / "updated elsewhere")', () => {
    const raw = {
      headers: [{ ...mkRow(), key: 'X-Env', value: 'prod' }],
      variables: [{ ...mkRow(), key: 'apiKey', value: 'sk', secret: true }],
      settings: { ...DEFAULT_REQUEST_SETTINGS, followRedirects: false },
    };
    const once = normalizeCollectionDefaults(raw);

    const loaded = collectionSettingsFingerprint({ name: 'Core', description: 'docs', defaults: once });
    const draft = collectionSettingsFingerprint({ name: 'Core', description: 'docs', defaults: normalizeCollectionDefaults(once) });

    expect(draft).toBe(loaded);
  });

  it('fingerprint matches when only volatile row ids differ (external update with no local edits reloads seamlessly)', () => {
    const defaults = normalizeCollectionDefaults({
      headers: [{ ...mkRow(), key: 'X-Env', value: 'prod' }],
      variables: [{ ...mkRow(), key: 'token', value: 's3cr3t', secret: true }],
    });

    const reloaded = normalizeCollectionDefaults({
      headers: restoreRows(defaults.headers),
      variables: restoreRows(defaults.variables),
    });

    expect(defaults.headers[0].id).not.toBe(reloaded.headers[0].id);
    expect(collectionSettingsFingerprint({ name: 'Core', description: 'd', defaults }))
      .toBe(collectionSettingsFingerprint({ name: 'Core', description: 'd', defaults: reloaded }));
  });

  it('fingerprint still changes when actual content changes (id-stripping is not over-broad)', () => {
    const base = normalizeCollectionDefaults({ headers: [{ ...mkRow(), key: 'X-Env', value: 'prod' }] });
    const edited = normalizeCollectionDefaults({ headers: [{ ...mkRow(), key: 'X-Env', value: 'staging' }] });

    expect(collectionSettingsFingerprint({ name: 'Core', description: '', defaults: base }))
      .not.toBe(collectionSettingsFingerprint({ name: 'Core', description: '', defaults: edited }));
  });
});
