import { backend, TestApp } from './support/appIntegration';
import { describe, it, vi, expect } from 'vitest';
import { type HttpResponse, type HttpRequest } from '../lib/backend';
import { type SavedRequest } from '../lib/types/models';

describe('importing a spec from a URL', () => {
  const petstoreSpec = {
    openapi: '3.0.0',
    info: { title: 'Petstore API', version: '1.0.0' },
    servers: [{ url: 'https://api.petstore.test/v2' }],
    paths: {
      '/pets': {
        get: { summary: 'List pets', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' }, example: 10 }] },
        post: { summary: 'Create a pet' },
      },
      '/pets/{petId}': {
        get: { summary: 'Get a pet', parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }] },
      },
    },
  };

  function specResponse(body: string, contentType = 'application/json'): HttpResponse {
    return {
      statusCode: 200,
      status: '200 OK',
      headers: [{ key: 'Content-Type', value: contentType, enabled: true, isFile: false, fileName: '' }],
      body,
      duration: 8,
      size: body.length,
      error: '',
      preRequestResult: { tests: [] },
      testResult: { tests: [] },
    } as unknown as HttpResponse;
  }

  function newApp() {
    backend.state.savedStores = [];
    backend.state.sentHttpRequests = [];
    return new TestApp() as TestApp & Record<string, any>;
  }

  it('fetches the spec and builds a collection from it', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(async (req: HttpRequest) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('https://api.petstore.test/openapi.json');
      expect(req.followRedirects).toBe(true);
      expect(req.disableCookieJar).toBe(true);
      return specResponse(JSON.stringify(petstoreSpec));
    });

    app.selects.push('openapi-url');
    app.prompts.push('api.petstore.test/openapi.json');
    await app.openPostmanImport();

    expect(app.collections).toHaveLength(1);
    expect(app.collections[0].name).toBe('Petstore API');
    expect(app.requests.map((req: SavedRequest) => `${req.method} ${req.url}`).sort()).toEqual([
      'GET {{baseUrl}}/pets',
      'GET {{baseUrl}}/pets/:petId',
      'POST {{baseUrl}}/pets',
    ]);
    expect(app.requests.every((req: SavedRequest) => req.collectionId === app.collections[0].id)).toBe(true);
    expect(app.collectionImportToast).toMatch(/Imported 3 requests/);

    const persisted = backend.state.savedStores.at(-1);
    expect(persisted?.collections?.[0]?.name).toBe('Petstore API');
    expect(persisted?.requests).toHaveLength(3);
  });

  it('accepts a YAML spec', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(async () => specResponse(
      'openapi: 3.0.0\ninfo:\n  title: YAML API\npaths:\n  /ping:\n    get:\n      summary: Ping\n',
      'text/yaml',
    ));

    app.selects.push('openapi-url');
    app.prompts.push('https://api.example.test/spec.yaml');
    await app.openPostmanImport();

    expect(app.collections[0].name).toBe('YAML API');
    expect(app.requests).toHaveLength(1);
  });

  it('explains a link to the Swagger UI page instead of importing nothing', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(async () => specResponse(
      '<!DOCTYPE html><html><head><title>Swagger UI</title></head><body></body></html>',
      'text/html; charset=utf-8',
    ));

    app.selects.push('openapi-url');
    app.prompts.push('https://api.example.test/swagger-ui/index.html');
    await app.openPostmanImport();

    expect(app.collections).toHaveLength(0);
    expect(app.alerts.at(-1)?.title).toBe('Import from URL failed');
    expect(app.alerts.at(-1)?.message).toMatch(/web page, not a spec/);
    expect(app.collectionImportToast).toBe('');
  });

  it('reports the status when the URL does not serve a spec', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(async () => ({
      ...specResponse('Not Found'),
      statusCode: 404,
      status: '404 Not Found',
    }));

    app.selects.push('openapi-url');
    app.prompts.push('https://api.example.test/nope.json');
    await app.openPostmanImport();

    expect(app.collections).toHaveLength(0);
    expect(app.alerts.at(-1)?.message).toMatch(/404 Not Found/);
  });

  it('surfaces a network failure rather than swallowing it', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(async () => ({
      ...specResponse(''),
      statusCode: 0,
      status: '',
      error: 'dial tcp: no such host',
    }));

    app.selects.push('openapi-url');
    app.prompts.push('https://nowhere.invalid/openapi.json');
    await app.openPostmanImport();

    expect(app.collections).toHaveLength(0);
    expect(app.alerts.at(-1)?.message).toMatch(/no such host/);
  });

  it('skips the certificate check when the box is ticked', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(async (req: HttpRequest) => {
      expect(req.enableSSLVerification).toBe(false);
      return specResponse(JSON.stringify(petstoreSpec));
    });

    app.selects.push('openapi-url');
    app.prompts.push('https://self-signed.petstore.test/openapi.json');
    app.toggles.push(true);
    await app.openPostmanImport();

    expect(app.collections[0].name).toBe('Petstore API');
    expect(app.requests).toHaveLength(3);
  });

  it('suggests skipping the certificate check when it is rejected', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(async (req: HttpRequest) => {
      expect(req.enableSSLVerification).toBe(true);
      return {
        ...specResponse(''),
        statusCode: 0,
        status: '',
        error: 'tls: failed to verify certificate: x509: certificate signed by unknown authority',
      };
    });

    app.selects.push('openapi-url');
    app.prompts.push('https://self-signed.petstore.test/openapi.json');
    await app.openPostmanImport();

    expect(app.collections).toHaveLength(0);
    expect(app.alerts.at(-1)?.message).toMatch(/unknown authority\. If you trust this server, import again with "Skip TLS certificate check" ticked\./);
  });

  it('does nothing when the URL prompt is dismissed', async () => {
    const app = newApp();
    app.selects.push('openapi-url');
    app.prompts.push('');
    await app.openPostmanImport();

    expect(app.collections).toHaveLength(0);
    expect(backend.state.sentHttpRequests).toHaveLength(0);
    expect(app.alerts).toHaveLength(0);
  });
});
