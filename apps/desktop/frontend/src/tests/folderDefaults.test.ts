import { describe, expect, it } from 'vitest';
import {
  applyCollectionDefaultsToRequest,
  emptyCollectionDefaults,
  emptyFolderDefaults,
  folderDefaultsChain,
  inheritedAuthSource,
  normalizeFolderDefaultsList,
  removeFolderDefaultsTree,
  renameFolderDefaults,
  withInheritedAuth,
} from '../lib/collectionDefaults';
import { mkRow } from '../lib/constants';
import { normalizeCollection, normalizeSavedRequest } from '../lib/normalizers';
import { buildOpenCollectionFiles, openCollectionBundleFromFiles } from '../lib/opencollection';
import { buildPostmanCollection, postmanCollectionBundle } from '../lib/postman';
import type { AuthState, Collection, FolderDefaults, KVRow, SavedRequest } from '../lib/types/models';
import { emptyAuthState } from '../lib/utils';

function header(key: string, value: string): KVRow {
  return { ...mkRow(), key, value, enabled: true };
}

function bearer(token: string): AuthState {
  return { ...emptyAuthState(), type: 'bearer', bearerToken: token };
}

function folder(path: string[], patch: Partial<FolderDefaults> = {}): FolderDefaults {
  return { ...emptyFolderDefaults(path, `folder-${path.join('-')}`), ...patch };
}

function collection(folderDefaults: FolderDefaults[]): Collection {
  return normalizeCollection({
    id: 'col',
    name: 'Shop',
    defaults: {
      ...emptyCollectionDefaults(),
      headers: [header('X-Team', 'core'), header('Accept', '*/*')],
      auth: bearer('collection-token'),
      preRequestScriptJs: 'collection-pre',
      testScriptJs: 'collection-test',
    },
    folderDefaults,
  }, 'ws');
}

const shop = collection([
  folder(['Orders'], { headers: [header('Accept', 'application/json')], auth: bearer('orders-token'), preRequestScriptJs: 'orders-pre', testScriptJs: 'orders-test' }),
  folder(['Orders', 'Write'], { headers: [header('X-Write', '1')], preRequestScriptJs: 'write-pre', testScriptJs: 'write-test' }),
  folder(['Public'], { auth: emptyAuthState() }),
]);

function request(folderPath: string[], patch: Partial<SavedRequest> = {}): SavedRequest {
  return normalizeSavedRequest({ id: 'req', name: 'Create', collectionId: 'col', folderPath, url: 'https://shop.test', auth: { ...emptyAuthState(), type: 'inherit' }, ...patch }, [shop], 'ws');
}

describe('folder defaults', () => {
  it('layer the collection, every enclosing folder and the request in that order', () => {
    const effective = applyCollectionDefaultsToRequest(request(['Orders', 'Write'], { headers: [header('X-Write', 'request')], preRequestScriptJs: 'request-pre', testScriptJs: 'request-test' }), shop);
    expect(Object.fromEntries(effective.headers.map(row => [row.key, row.value]))).toEqual({ 'X-Team': 'core', Accept: 'application/json', 'X-Write': 'request' });
    expect(effective.auth.bearerToken).toBe('orders-token');
    expect(effective.preRequestScriptJs).toBe('collection-pre\n\norders-pre\n\nwrite-pre\n\nrequest-pre');
    expect(effective.testScriptJs).toBe('request-test\n\nwrite-test\n\norders-test\n\ncollection-test');
  });

  it('let a folder turn auth off and leave other folders on the collection', () => {
    expect(applyCollectionDefaultsToRequest(request(['Public']), shop).auth.type).toBe('none');
    expect(applyCollectionDefaultsToRequest(request(['Elsewhere']), shop).auth.bearerToken).toBe('collection-token');
    expect(applyCollectionDefaultsToRequest(request(['Orders'], { auth: { ...emptyAuthState(), type: 'basic', basicUser: 'me' } }), shop).auth.type).toBe('basic');
  });

  it('drop empty folders and keep the last entry for a path', () => {
    const list = normalizeFolderDefaultsList([
      folder(['A'], { preRequestScriptJs: 'first' }),
      folder(['B']),
      folder(['A'], { preRequestScriptJs: 'second' }),
    ]);
    expect(list.map(item => [item.path.join('/'), item.preRequestScriptJs])).toEqual([['A', 'second']]);
  });

  it('follow a folder when it is renamed and go away with it when it is deleted', () => {
    const renamed = renameFolderDefaults(shop, ['Orders'], ['Sales']);
    expect(folderDefaultsChain(renamed, ['Sales', 'Write']).map(item => item.path.join('/'))).toEqual(['Sales', 'Sales/Write']);
    expect(folderDefaultsChain(renamed, ['Orders', 'Write'])).toEqual([]);
    const removed = removeFolderDefaultsTree(shop, ['Orders']);
    expect(removed.folderDefaults?.map(item => item.path.join('/'))).toEqual(['Public']);
  });

  it('write a refreshed inherited token to the folder that supplies the auth', () => {
    expect(inheritedAuthSource(shop, ['Orders', 'Write'])).toMatchObject({ kind: 'folder', folder: { path: ['Orders'] } });
    const updated = withInheritedAuth(shop, ['Orders', 'Write'], auth => ({ ...auth, bearerToken: 'fresh' }));
    expect(updated.folderDefaults?.find(item => item.path.join('/') === 'Orders')?.auth.bearerToken).toBe('fresh');
    expect(updated.defaults.auth.bearerToken).toBe('collection-token');
    const fromCollection = withInheritedAuth(shop, ['Elsewhere'], auth => ({ ...auth, bearerToken: 'fresh' }));
    expect(fromCollection.defaults.auth.bearerToken).toBe('fresh');
  });
});

describe('folder defaults in Postman', () => {
  it('import folder auth and scripts onto the folder and export them back', () => {
    const bundle = postmanCollectionBundle({
      info: { name: 'Shop' },
      item: [{
        name: 'Orders',
        auth: { type: 'bearer', bearer: [{ key: 'token', value: 'orders-token' }] },
        event: [{ listen: 'prerequest', script: { exec: ['pm.variables.set("scope", "orders")'] } }],
        item: [
          { name: 'List', request: { method: 'GET', url: 'https://shop.test/orders' } },
          { name: 'Open', item: [{ name: 'Ping', request: { method: 'GET', url: 'https://shop.test/ping' } }], auth: { type: 'noauth' } },
        ],
      }],
    }, 'col', 'Shop');
    expect(bundle.requests.map(req => [req.name, req.auth.type, req.preRequestScript])).toEqual([['List', 'inherit', ''], ['Ping', 'inherit', '']]);
    expect(bundle.folderDefaults.map(item => [item.path.join('/'), item.auth.type, item.auth.bearerToken, item.preRequestScript])).toEqual([
      ['Orders', 'bearer', 'orders-token', 'pm.variables.set("scope", "orders")'],
      ['Orders/Open', 'none', '', ''],
    ]);

    const exported = buildPostmanCollection('Shop', '', bundle.requests, source => source, true, undefined, bundle.folderDefaults) as { item: Array<Record<string, unknown>> };
    const orders = exported.item[0];
    expect(orders.auth).toMatchObject({ type: 'bearer' });
    expect(JSON.stringify(orders.event)).toContain('scope');
    expect((orders.item as Array<Record<string, unknown>>).find(item => item.name === 'Open')?.auth).toEqual({ type: 'noauth' });
  });
});

describe('folder defaults in Bruno / OpenCollection', () => {
  it('survive an export and import round trip', () => {
    const folders = [
      folder(['Orders'], { headers: [header('Accept', 'application/json')], auth: bearer('orders-token'), preRequestScript: 'orders-pre', testScript: 'orders-test' }),
      folder(['Public'], { auth: emptyAuthState() }),
    ];
    const files = buildOpenCollectionFiles('Shop', '', emptyCollectionDefaults(), [request(['Orders'])], [], source => source, true, [], folders);
    const bundle = openCollectionBundleFromFiles(files, 'col', 'Shop', 'ws');
    expect(bundle.folderDefaults.map(item => [item.path.join('/'), item.auth.type, item.auth.bearerToken, item.headers.map(row => row.key), item.preRequestScript, item.testScript])).toEqual([
      ['Orders', 'bearer', 'orders-token', ['Accept'], 'orders-pre', 'orders-test'],
      ['Public', 'none', '', [], '', ''],
    ]);
  });

  it('read folder.bru headers, auth and scripts and treat a missing auth block as inherit', () => {
    const bundle = openCollectionBundleFromFiles([
      { path: 'bruno.json', content: '{"name":"Legacy"}' },
      { path: 'orders/folder.bru', content: 'meta {\n  name: Orders\n}\n\nheaders {\n  X-Scope: orders\n}\n\nauth {\n  mode: bearer\n}\n\nauth:bearer {\n  token: folder-token\n}\n\nscript:pre-request {\n  bru.setVar("a", 1)\n}\n' },
      { path: 'orders/list.bru', content: 'meta {\n  name: List\n  type: http\n}\n\nget {\n  url: https://shop.test/orders\n  auth: inherit\n}\n' },
      { path: 'misc/folder.bru', content: 'meta {\n  name: Misc\n}\n' },
    ], 'col', 'Legacy', 'ws');
    expect(bundle.folderDefaults).toHaveLength(1);
    expect(bundle.folderDefaults[0]).toMatchObject({ path: ['Orders'], auth: { type: 'bearer', bearerToken: 'folder-token' }, preRequestScript: 'bru.setVar("a", 1)' });
    expect(bundle.folderDefaults[0].headers.map(row => [row.key, row.value])).toEqual([['X-Scope', 'orders']]);
  });
});
