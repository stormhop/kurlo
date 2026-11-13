import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/backend', () => ({
  openDirectoryDialog: vi.fn(),
  readCollectionTextFiles: vi.fn(),
  sendHttpRequest: vi.fn(),
  writeCollectionTextFiles: vi.fn(),
}));

import { sendHttpRequest } from '../lib/backend';
import { openApiNameFromUrl, parseOpenApiResponse } from '../lib/openapi';
import { dialogFeature } from '../lib/stores/features/dialogs';
import { importExportFeature, looksLikeTlsCertificateError, normalizeSpecUrl } from '../lib/stores/features/importExport';

const minimalSpec = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Petstore' },
  paths: { '/pets': { get: { summary: 'List pets' } } },
});

describe('normalizeSpecUrl', () => {
  it('defaults a bare host to https', () => {
    expect(normalizeSpecUrl('api.example.test/openapi.json')).toBe('https://api.example.test/openapi.json');
  });

  it('leaves an explicit scheme alone', () => {
    expect(normalizeSpecUrl('http://localhost:8080/v3/api-docs')).toBe('http://localhost:8080/v3/api-docs');
    expect(normalizeSpecUrl('https://api.example.test/spec.yaml')).toBe('https://api.example.test/spec.yaml');
  });

  it('trims surrounding whitespace from a pasted link', () => {
    expect(normalizeSpecUrl('  https://api.example.test/spec.json \n')).toBe('https://api.example.test/spec.json');
  });

  it('returns nothing for an empty value', () => {
    expect(normalizeSpecUrl('   ')).toBe('');
  });
});

describe('parseOpenApiResponse', () => {
  it('accepts an OpenAPI 3 JSON document', () => {
    expect(parseOpenApiResponse(minimalSpec, 'application/json')).toMatchObject({ openapi: '3.0.0' });
  });

  it('accepts a Swagger 2 document', () => {
    const swagger = JSON.stringify({ swagger: '2.0', info: { title: 'Legacy' }, paths: {} });
    expect(parseOpenApiResponse(swagger, 'application/json')).toMatchObject({ swagger: '2.0' });
  });

  it('accepts YAML, which is how half of these are served', () => {
    const yaml = 'openapi: 3.0.0\ninfo:\n  title: Petstore\npaths: {}\n';
    expect(parseOpenApiResponse(yaml, 'text/yaml')).toMatchObject({ openapi: '3.0.0' });
  });

  it('names the Swagger UI page for what it is', () => {
    const page = '<!DOCTYPE html><html><head><title>Swagger UI</title></head><body></body></html>';
    expect(() => parseOpenApiResponse(page, 'text/html; charset=utf-8')).toThrow(/web page, not a spec/);
    expect(() => parseOpenApiResponse(page, 'text/html')).toThrow(/swagger\.json/);
  });

  it('detects an HTML page even when the content type does not say so', () => {
    expect(() => parseOpenApiResponse('<html><body>hi</body></html>', 'application/octet-stream'))
      .toThrow(/web page, not a spec/);
  });

  it('rejects an empty document', () => {
    expect(() => parseOpenApiResponse('   ', 'application/json')).toThrow(/empty document/);
  });

  it('rejects something that parses but is not a spec', () => {
    expect(() => parseOpenApiResponse(JSON.stringify({ info: { title: 'Nope' } }), 'application/json'))
      .toThrow(/no "openapi" or "swagger" version field/);
  });

  it('rejects junk that no parser makes sense of', () => {
    expect(() => parseOpenApiResponse('{ this is not: valid ]', 'application/json'))
      .toThrow(/not a spec Kurlo can import/);
    expect(() => parseOpenApiResponse('just some words', 'text/plain'))
      .toThrow(/not a spec Kurlo can import/);
  });

  it('rejects a document of the wrong shape entirely', () => {
    expect(() => parseOpenApiResponse('[1, 2, 3]', 'application/json'))
      .toThrow(/not a spec Kurlo can import/);
  });
});

describe('openApiNameFromUrl', () => {
  it('uses a meaningful last path segment', () => {
    expect(openApiNameFromUrl('https://api.example.test/petstore.json')).toBe('petstore');
    expect(openApiNameFromUrl('https://api.example.test/specs/billing.yaml')).toBe('billing');
  });

  it('falls back to the host for a generic segment', () => {
    expect(openApiNameFromUrl('https://api.example.test/v3/api-docs')).toBe('api.example.test');
    expect(openApiNameFromUrl('https://api.example.test/openapi.json')).toBe('api.example.test');
    expect(openApiNameFromUrl('https://api.example.test/swagger.json')).toBe('api.example.test');
  });

  it('handles a root URL and an unparseable one', () => {
    expect(openApiNameFromUrl('https://api.example.test/')).toBe('api.example.test');
    expect(openApiNameFromUrl('not a url')).toBe('');
  });
});

function urlImportHost() {
  const host = {
    collections: [{ id: 'existing' }] as Array<{ id: string }>,
    guardWorkspaceWritable: () => true,
    importOpenApiPayload: vi.fn(async () => {
      host.collections = [...host.collections, { id: 'imported' }];
      return 1;
    }),
    linkImportedOpenApiCollection: vi.fn(async () => {}),
  };
  return host;
}

function lastSentRequest() {
  const calls = vi.mocked(sendHttpRequest).mock.calls;
  return calls[calls.length - 1][0];
}

describe('importOpenApiFromUrl TLS verification', () => {
  it('verifies the certificate by default', async () => {
    vi.mocked(sendHttpRequest).mockResolvedValueOnce({ statusCode: 200, body: minimalSpec, headers: [] } as never);
    await importExportFeature.importOpenApiFromUrl.call(urlImportHost() as never, 'https://api.example.test/openapi.json');
    expect(lastSentRequest().enableSSLVerification).toBe(true);
  });

  it('skips the certificate check when asked to', async () => {
    vi.mocked(sendHttpRequest).mockResolvedValueOnce({ statusCode: 200, body: minimalSpec, headers: [] } as never);
    const host = urlImportHost();
    const count = await importExportFeature.importOpenApiFromUrl.call(host as never, 'https://self-signed.example.test/openapi.json', { skipTlsVerification: true });
    expect(lastSentRequest().enableSSLVerification).toBe(false);
    expect(count).toBe(1);
    expect(host.importOpenApiPayload).toHaveBeenCalledOnce();
    expect(host.importOpenApiPayload).toHaveBeenCalledWith(JSON.parse(minimalSpec), 'self-signed.example.test', 'https://self-signed.example.test/openapi.json');
  });

  it('links the new collection to the URL when asked to keep it in sync', async () => {
    vi.mocked(sendHttpRequest).mockResolvedValueOnce({ statusCode: 200, body: minimalSpec, headers: [] } as never);
    const host = urlImportHost();
    await importExportFeature.importOpenApiFromUrl.call(host as never, 'https://api.example.test/openapi.json', { keepInSync: true, skipTlsVerification: true });
    expect(host.linkImportedOpenApiCollection).toHaveBeenCalledWith('imported', { url: 'https://api.example.test/openapi.json', skipTlsVerification: true }, JSON.parse(minimalSpec));
  });

  it('does not link the collection when sync is off', async () => {
    vi.mocked(sendHttpRequest).mockResolvedValueOnce({ statusCode: 200, body: minimalSpec, headers: [] } as never);
    const host = urlImportHost();
    await importExportFeature.importOpenApiFromUrl.call(host as never, 'https://api.example.test/openapi.json');
    expect(host.linkImportedOpenApiCollection).not.toHaveBeenCalled();
  });

  it('points at the skip option when the certificate is rejected', async () => {
    vi.mocked(sendHttpRequest).mockResolvedValueOnce({ statusCode: 0, error: 'tls: failed to verify certificate: x509: certificate signed by unknown authority', headers: [] } as never);
    await expect(importExportFeature.importOpenApiFromUrl.call(urlImportHost() as never, 'https://self-signed.example.test/openapi.json'))
      .rejects.toThrow(/Skip TLS certificate check/);
  });

  it('does not suggest skipping when it is already skipped', async () => {
    vi.mocked(sendHttpRequest).mockResolvedValueOnce({ statusCode: 0, error: 'x509: certificate has expired', headers: [] } as never);
    await expect(importExportFeature.importOpenApiFromUrl.call(urlImportHost() as never, 'https://old.example.test/openapi.json', { skipTlsVerification: true }))
      .rejects.toThrow(/^x509: certificate has expired$/);
  });

  it('recognises certificate errors only', () => {
    expect(looksLikeTlsCertificateError('x509: certificate signed by unknown authority')).toBe(true);
    expect(looksLikeTlsCertificateError('dial tcp: connection refused')).toBe(false);
  });
});

describe('openPromptWithToggleDialog', () => {
  function dialogHost() {
    const host = {
      appDialog: null as import('../lib/types/dialog').AppDialogState | null,
      dialogInputValue: '',
      dialogSelectOpen: false,
      closeFloatingMenus: () => {},
      dismissDialog: () => dialogFeature.dismissDialog.call(host as never),
      submitDialog: () => dialogFeature.submitDialog.call(host as never),
      moveDialogSelection: () => {},
    };
    return host;
  }

  it('starts unticked and reports the ticked state with the value', async () => {
    const host = dialogHost();
    const pending = dialogFeature.openPromptWithToggleDialog.call(host as never, 'Import from URL', '', 'URL', 'Import', { label: 'Skip TLS certificate check' });
    expect(host.appDialog?.mode === 'prompt' && host.appDialog.toggles?.[0]?.checked).toBe(false);
    host.dialogInputValue = 'https://self-signed.example.test/openapi.json';
    if (host.appDialog?.mode === 'prompt' && host.appDialog.toggles?.[0]) host.appDialog.toggles[0].checked = true;
    host.submitDialog();
    await expect(pending).resolves.toEqual({ value: 'https://self-signed.example.test/openapi.json', checked: true, checks: [true] });
  });

  it('reports every toggle and honours a ticked default', async () => {
    const host = dialogHost();
    const pending = dialogFeature.openPromptWithToggleDialog.call(host as never, 'Import from URL', '', 'URL', 'Import', [
      { label: 'Keep in sync with this URL', checked: true },
      { label: 'Skip TLS certificate check' },
    ]);
    expect(host.appDialog?.mode === 'prompt' && host.appDialog.toggles?.map(toggle => toggle.checked)).toEqual([true, false]);
    host.dialogInputValue = 'https://api.example.test/openapi.json';
    host.submitDialog();
    await expect(pending).resolves.toEqual({ value: 'https://api.example.test/openapi.json', checked: true, checks: [true, false] });
  });

  it('resolves to null when dismissed', async () => {
    const host = dialogHost();
    const pending = dialogFeature.openPromptWithToggleDialog.call(host as never, 'Import from URL', '', 'URL', 'Import', { label: 'Skip TLS certificate check' });
    host.dismissDialog();
    await expect(pending).resolves.toBeNull();
  });
});
