import { describe, expect, it } from 'vitest';
import { emptyCollectionDefaults } from '../lib/collectionDefaults';
import { DEFAULT_REQUEST_SETTINGS, mkRow } from '../lib/constants';
import { buildOpenApiDocument } from '../lib/openapi';
import { buildOpenCollectionFiles, openCollectionBundleFromFiles } from '../lib/opencollection';
import { buildPostmanCollection, postmanRequestsFromItems } from '../lib/postman';
import { parseRunnerDataFile } from '../lib/runnerData';
import { buildCollectionRunnerReportHtml } from '../lib/runnerReport';
import type { CollectionRunnerResult, Environment, KVRow, SavedRequest } from '../lib/types/models';
import { emptyAuthState } from '../lib/utils';

const strip = (source: string) => source;

function row(key: string, value: string, overrides: Partial<KVRow> = {}): KVRow {
  return { ...mkRow(), key, value, ...overrides };
}

function request(overrides: Partial<SavedRequest>): SavedRequest {
  return {
    id: 'req-base',
    name: 'Base request',
    filesystemName: 'Base-request',
    nameAuto: false,
    requestType: 'http',
    isDraft: false,
    collectionId: 'collection-1',
    collection: 'Smoke API',
    folderPath: [],
    method: 'GET',
    url: 'https://api.example.test/health',
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
    preRequestScript: '',
    testScript: '',
    preRequestScriptJs: '',
    testScriptJs: '',
    requestNotes: '',
    settings: { ...DEFAULT_REQUEST_SETTINGS },
    settingsOverrides: {},
    ...overrides,
  };
}

describe('core workflow smoke', () => {
  it('moves a mixed collection through exports, imports, runner data, and report generation', () => {
    const defaults = emptyCollectionDefaults();
    defaults.headers = [row('X-Workspace', '{{workspaceId}}')];
    defaults.variables = [row('baseUrl', 'https://api.example.test')];
    defaults.auth = { ...emptyAuthState(), type: 'bearer', bearerToken: '{{token}}' };
    defaults.settings = { ...DEFAULT_REQUEST_SETTINGS, timeoutMs: 5000, followRedirects: false };

    const environment: Environment = {
      id: 'env-1',
      workspaceId: 'workspace-1',
      name: 'Local',
      filesystemName: 'Local',
      values: [row('token', 'raw-token', { secret: true }), row('workspaceId', 'local')],
    };

    const login = request({
      id: 'req-login',
      name: 'Login',
      filesystemName: 'Login',
      folderPath: ['Auth'],
      method: 'POST',
      url: '{{baseUrl}}/login?api_key=raw-key',
      params: [row('dryRun', 'true')],
      headers: [row('Authorization', 'Bearer {{token}}')],
      auth: { ...emptyAuthState(), type: 'bearer', bearerToken: '{{token}}' },
      bodyType: 'json',
      bodyContent: '{"username":"ada","password":"raw-password"}',
      testScriptJs: 'pm.test("status", () => pm.response.to.have.status(200));',
      settingsOverrides: { timeoutMs: true, followRedirects: true },
    });
    const viewer = request({
      id: 'req-viewer',
      name: 'Viewer',
      filesystemName: 'Viewer',
      requestType: 'graphql',
      method: 'POST',
      url: '{{baseUrl}}/graphql',
      requestTab: 'query',
      bodyType: 'graphql',
      bodyContent: JSON.stringify({ query: 'query Viewer { viewer { id } }', variables: {} }),
    });
    const socket = request({
      id: 'req-socket',
      name: 'Events',
      filesystemName: 'Events',
      requestType: 'ws',
      url: 'wss://api.example.test/events',
      requestTab: 'body',
      bodyType: 'text',
      rawBodyType: 'text',
      bodyContent: 'ping',
    });

    const postman = buildPostmanCollection('Smoke API', 'Smoke run', [login, viewer, socket], strip);
    const postmanJson = JSON.stringify(postman);
    expect(postmanJson).toContain('api_key=');
    expect(postmanJson).not.toContain('raw-key');
    expect(postmanRequestsFromItems(postman.item, 'collection-2', 'Smoke API', undefined).map(req => req.requestType)).toEqual(['http', 'graphql', 'ws']);

    const files = buildOpenCollectionFiles('Smoke API', 'Smoke run', defaults, [login, viewer, socket], [environment], strip);
    expect(files.map(file => file.path)).toEqual(expect.arrayContaining([
      'opencollection.yml',
      'Auth/folder.yml',
      'Auth/Login.yml',
      'Viewer.yml',
      'Events.yml',
      'environments/Local.yml',
    ]));
    const bundle = openCollectionBundleFromFiles(files, 'collection-3', 'Fallback', 'workspace-1');
    expect(bundle.requests.map(req => req.requestType).sort()).toEqual(['graphql', 'http', 'ws']);
    expect(bundle.environments[0].values).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'token', secret: true, value: '' }),
    ]));

    const openApi = buildOpenApiDocument('Smoke API', 'Smoke run', [login], strip);
    expect(openApi.paths['/login']?.post?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'api_key', in: 'query' }),
      expect.objectContaining({ name: 'dryRun', in: 'query', example: 'true' }),
    ]));

    const dataRows = parseRunnerDataFile('username,expectedStatus\nada,200', 'smoke.csv');
    const result: CollectionRunnerResult = {
      runId: 'run-1',
      requestId: login.id,
      iteration: 1,
      name: login.name,
      method: login.method,
      url: login.url,
      status: 'passed',
      statusCode: 200,
      duration: 31,
      testsPassed: 1,
      testsTotal: 1,
      error: '',
      tests: [{ name: 'status', passed: true }],
    };
    const html = buildCollectionRunnerReportHtml({
      title: 'Smoke API',
      generatedAt: '2026-05-27T10:00:00.000Z',
      summary: { total: 1, completed: 1, passed: 1, failed: 0, skipped: 0, testsPassed: 1, testsTotal: 1, duration: 31, allPassed: true },
      results: [result],
      iterations: 1,
      delayMs: 0,
      parallel: false,
      includeTags: 'smoke',
      excludeTags: '',
      dataFileName: 'smoke.csv',
      dataRows,
    });
    expect(html).toContain('Smoke API');
    expect(html).toContain('smoke.csv (1 rows)');
    expect(html).toContain('status');
  });
});
