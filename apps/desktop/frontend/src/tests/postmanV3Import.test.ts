import { backend, TestApp } from './support/appIntegration';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Collection, Environment, SavedRequest } from '../lib/types/models';

function newApp() {
  backend.state.savedStores = [];
  return new TestApp() as TestApp & Record<string, any>;
}

afterEach(() => {
  vi.mocked(backend.openDirectoryDialog).mockReset().mockResolvedValue('');
  vi.mocked(backend.readCollectionTextFiles).mockReset().mockImplementation(async (root: string) => ({ root, name: '', files: [], error: 'missing' }));
  vi.mocked(backend.readImportFile).mockReset().mockImplementation(async (path: string) => ({ path, name: '', content: '', error: 'missing' }));
});

const project = [
  { path: 'postman/collections/Shop/.resources/definition.yaml', content: '$kind: collection\nname: Shop\nvariables:\n  baseUrl: https://shop.example.com\n' },
  { path: 'postman/collections/Shop/Users/.resources/definition.yaml', content: '$kind: collection\norder: 1000\n' },
  { path: 'postman/collections/Shop/Users/List users.request.yaml', content: '$kind: http-request\nurl: "{{baseUrl}}/users"\nmethod: GET\norder: 1000\n' },
  { path: 'postman/collections/Shop/Users/Create user.request.yaml', content: '$kind: http-request\nurl: "{{baseUrl}}/users"\nmethod: POST\nbody:\n  type: json\n  content: \'{"name":"Ada"}\'\norder: 2000\n' },
  { path: 'postman/collections/Shop/Sensors.request.yaml', content: '$kind: mqtt-request\nurl: mqtts://broker.example.com\n' },
  { path: 'postman/collections/Billing/.resources/definition.yaml', content: '$kind: collection\nname: Billing\n' },
  { path: 'postman/collections/Billing/Invoices.request.yaml', content: '$kind: http-request\nurl: https://billing.example.com/invoices\nmethod: GET\n' },
  { path: 'postman/environments/Staging.environment.yaml', content: 'name: Staging\nvalues:\n  - key: baseUrl\n    value: https://staging.example.com\n    enabled: true\n' },
  { path: 'postman/globals/workspace.globals.yaml', content: 'name: Globals\nvalues:\n  - key: region\n    value: eu\n' },
];

function folderResult(root: string, files = project) {
  return { root, name: root.split('/').pop() ?? '', files, error: '' };
}

function collectionNames(app: Record<string, any>) {
  return (app.collections as Collection[]).map(collection => collection.name);
}

describe('Postman v3 folder import', () => {
  it('imports collections, environments and globals picked from the import menu', async () => {
    const app = newApp();
    vi.mocked(backend.openDirectoryDialog).mockResolvedValueOnce('/work/repo');
    vi.mocked(backend.readCollectionTextFiles).mockResolvedValueOnce(folderResult('/work/repo'));

    app.selects.push('postman-v3');
    await app.openPostmanImport();

    expect(backend.openDirectoryDialog).toHaveBeenCalledWith('Import Postman v3 collection folder');
    expect(collectionNames(app).sort()).toEqual(['Billing', 'Shop']);
    const requests = app.requests as SavedRequest[];
    expect(requests.map(request => `${request.collection}: ${request.folderPath.join('/')}/${request.name}`).sort()).toEqual([
      'Billing: /Invoices',
      'Shop: Users/Create user',
      'Shop: Users/List users',
    ]);
    const shop = (app.collections as Collection[]).find(collection => collection.name === 'Shop');
    expect(shop?.defaults?.variables.map(row => [row.key, row.value])).toEqual([['baseUrl', 'https://shop.example.com']]);
    expect((app.environments as Environment[]).map(env => env.name)).toContain('Staging');
    expect((app.globalVariables as Array<{ key: string; value: string }>).map(row => [row.key, row.value])).toContainEqual(['region', 'eu']);
    expect(app.collectionImportToast).toBe('Imported 3 requests from 2 collections and 1 environment · skipped 1 unsupported item');
  });

  it('recognises a Postman v3 folder chosen through the Bruno folder import', async () => {
    const app = newApp();
    vi.mocked(backend.openDirectoryDialog).mockResolvedValueOnce('/work/repo');
    vi.mocked(backend.readCollectionTextFiles).mockResolvedValueOnce(folderResult('/work/repo'));

    app.selects.push('bruno');
    await app.openPostmanImport();

    expect(collectionNames(app).sort()).toEqual(['Billing', 'Shop']);
  });

  it('does nothing when the folder dialog is cancelled', async () => {
    const app = newApp();
    app.selects.push('postman-v3');
    await app.openPostmanImport();
    expect(backend.readCollectionTextFiles).not.toHaveBeenCalled();
    expect(app.collections).toHaveLength(0);
  });

  it('imports a dropped Postman v3 folder', async () => {
    const app = newApp();
    vi.mocked(backend.readImportFile).mockImplementation(async (path: string) => ({ path, name: 'repo', content: '', error: 'repo is a folder' }));
    vi.mocked(backend.readCollectionTextFiles).mockResolvedValueOnce(folderResult('/work/repo'));

    await app.importDroppedFiles(['/work/repo']);

    expect(backend.readCollectionTextFiles).toHaveBeenCalledWith('/work/repo');
    expect(collectionNames(app).sort()).toEqual(['Billing', 'Shop']);
  });

  it('keeps the folder error for dropped folders that are not collections', async () => {
    const app = newApp();
    vi.mocked(backend.readImportFile).mockImplementation(async (path: string) => ({ path, name: 'deploy', content: '', error: 'deploy is a folder' }));
    vi.mocked(backend.readCollectionTextFiles).mockResolvedValueOnce(folderResult('/work/deploy', [
      { path: 'docker-compose.yaml', content: 'services:\n  api:\n    image: x\n' },
    ]));

    await app.importDroppedFiles(['/work/deploy']);

    expect(app.collections).toHaveLength(0);
    expect(app.collectionImportToast).toBe('Import failed: deploy is a folder');
  });

  it('imports a single dropped .request.yaml file', async () => {
    const app = newApp();
    vi.mocked(backend.readImportFile).mockImplementation(async (path: string) => ({
      path,
      name: 'Get user.request.yaml',
      content: '$kind: http-request\nurl: https://api.example.com/users/:id\nmethod: GET\npathVariables:\n  id: "7"\n',
      error: '',
    }));

    await app.importDroppedFiles(['/work/Get user.request.yaml']);

    expect(collectionNames(app)).toEqual(['Get user']);
    const [request] = app.requests as SavedRequest[];
    expect(request).toMatchObject({ name: 'Get user', method: 'GET', url: 'https://api.example.com/users/:id' });
    expect(request.pathParams?.map(row => [row.key, row.value])).toEqual([['id', '7']]);
    expect(app.collectionImportToast).toBe('Imported 1 request');
  });

  it('explains why a v3 folder had nothing to import', async () => {
    const app = newApp();
    vi.mocked(backend.openDirectoryDialog).mockResolvedValueOnce('/work/broken');
    vi.mocked(backend.readCollectionTextFiles).mockResolvedValueOnce(folderResult('/work/broken', [
      { path: 'Bad.request.yaml', content: '$kind: http-request\nmethod: GET\n' },
    ]));

    app.selects.push('postman-v3');
    await app.openPostmanImport();

    expect(app.collections).toHaveLength(0);
    expect(app.collectionImportToast).toBe('Import failed: Bad.request.yaml: Request has no URL');
  });

  it('reports a folder the backend cannot read', async () => {
    const app = newApp();
    vi.mocked(backend.openDirectoryDialog).mockResolvedValueOnce('/work/locked');
    vi.mocked(backend.readCollectionTextFiles).mockResolvedValueOnce({ root: '/work/locked', name: 'locked', files: [], error: 'permission denied' });

    app.selects.push('postman-v3');
    await app.openPostmanImport();

    expect(app.collections).toHaveLength(0);
    expect(app.collectionImportToast).toBe('Import failed: permission denied');
  });
});
