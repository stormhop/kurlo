import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openApiImportFromSpec } from '../lib/openapi';
import { valuesWithBrunoPriority } from '../lib/collectionDefaults';
import { environmentFeature } from '../lib/stores/features/environments';
import { emptyCollectionDefaults } from '../lib/collectionDefaults';
import type { Collection, KVRow, SavedRequest } from '../lib/types/models';

type ServerRow = { key: string; value: string; enabled: boolean };

type ServerCase = {
  name: string;
  spec: Record<string, unknown>;
  sourceUrl: string;
  variables: ServerRow[];
  urls: Record<string, string>;
  requestVars?: Record<string, ServerRow[]>;
  urlsByPath?: boolean;
};

const cases: ServerCase[] = JSON.parse(readFileSync(new URL('../../../internal/api/testdata/openapi-servers.json', import.meta.url), 'utf8'));

function label(entry: ServerCase, request: SavedRequest) {
  return entry.urlsByPath ? `${request.method} ${request.url.replace(/^\{\{[^}]+\}\}/, '')}` : request.name;
}

function plain(rows: KVRow[] | undefined): ServerRow[] {
  return (rows ?? []).map(({ key, value, enabled }) => ({ key, value, enabled }));
}

function resolvedUrl(collectionRows: KVRow[], request: SavedRequest) {
  const collection = { defaults: { ...emptyCollectionDefaults(), variables: collectionRows } } as unknown as Collection;
  const values = valuesWithBrunoPriority(collection, {}, {}, request.vars);
  return environmentFeature.resolveTemplate.call({} as never, request.url, values);
}

describe('OpenAPI servers shared with the MCP importer', () => {
  for (const entry of cases) {
    it(entry.name, () => {
      const imported = openApiImportFromSpec(entry.spec, 'c', 'API', entry.sourceUrl);
      expect(plain(imported.defaults.variables)).toEqual(entry.variables);
      expect(Object.fromEntries(imported.requests.map(request => [label(entry, request), request.url]))).toEqual(entry.urls);
      const requestVars = Object.fromEntries(imported.requests.filter(request => request.vars?.length).map(request => [label(entry, request), plain(request.vars)]));
      expect(requestVars).toEqual(entry.requestVars ?? {});
      for (const request of imported.requests) {
        expect(request.examples?.[0]?.snapshot.url).toBe(request.url);
      }
    });
  }

  it('puts operation servers into the request Vars like Bruno, with alternatives switched off', () => {
    const entry = cases.find(entry => entry.name === 'operation servers without document server')!;
    const { defaults, requests } = openApiImportFromSpec(entry.spec, 'c', 'API');
    const [request] = requests;
    expect(request.url).toBe('{{baseUrl}}/recalculate');
    expect(request.vars?.map(row => row.description)).toEqual(['Production server from the spec', 'Sandbox server from the spec']);
    expect(resolvedUrl(defaults.variables, request)).toBe('https://gost.test/recalculate');
    request.vars = request.vars!.map(row => ({ ...row, enabled: !row.enabled }));
    expect(resolvedUrl(defaults.variables, request)).toBe('https://sandbox.test/secured/recalculate');
  });

  it('keeps document servers on the collection and lets a request override them', () => {
    const entry = cases.find(entry => entry.name === 'operation path document precedence')!;
    const { defaults, requests } = openApiImportFromSpec(entry.spec, 'c', 'API');
    const byName = Object.fromEntries(requests.map(request => [request.name, request]));
    expect(resolvedUrl(defaults.variables, byName.a)).toBe('https://api.test/a');
    expect(resolvedUrl(defaults.variables, byName.b)).toBe('https://files.test/b');
    expect(resolvedUrl(defaults.variables, byName.c)).toBe('https://reports.test/b');
  });

  it('merges labels of a server listed twice in one operation', () => {
    const { requests } = openApiImportFromSpec({
      openapi: '3.0.3',
      paths: { '/a': { get: { summary: 'a', servers: [{ url: 'https://api.test/', description: 'Production' }, { url: 'https://api.test', description: 'Primary' }, { url: 'https://one.test', description: 'Sandbox' }] } } },
    }, 'c', 'API');
    expect(requests[0].vars?.map(row => [row.value, row.enabled, row.description])).toEqual([
      ['https://api.test', true, 'Production, Primary server from the spec'],
      ['https://one.test', false, 'Sandbox server from the spec'],
    ]);
  });

  it('assigns the same rows when path insertion order changes', () => {
    const entry = cases.find(entry => entry.name === 'operation path document precedence')!;
    const paths = entry.spec.paths as Record<string, unknown>;
    const reversed = { ...entry.spec, paths: Object.fromEntries(Object.entries(paths).reverse()) };
    const rows = (spec: Record<string, unknown>) => {
      const imported = openApiImportFromSpec(spec, 'c', 'API');
      return {
        collection: plain(imported.defaults.variables),
        requests: Object.fromEntries(imported.requests.map(request => [request.name, plain(request.vars)])),
      };
    };
    expect(rows(reversed)).toEqual(rows(entry.spec));
  });
});
