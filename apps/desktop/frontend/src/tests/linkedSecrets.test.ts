import { describe, expect, it } from 'vitest';
import { backend, TestApp, row, httpResponse } from './support/appIntegration';
import { environmentRowValue, isLinkedSecretMarker, linkedSecretMarker, normalizeSecretRef } from '../lib/linkedSecrets';
import { cloneRowsForStore, restoreRows } from '../lib/utils';
import type { HttpRequest } from '../lib/backend';

describe('linked secret markers', () => {
  it('encodes references exactly like the Go side', () => {
    expect(linkedSecretMarker({ provider: 'vault-prod', path: 'secret/data/app', field: 'password' }))
      .toBe('{{kurloRef:eyJwIjoidmF1bHQtcHJvZCIsInBhdGgiOiJzZWNyZXQvZGF0YS9hcHAiLCJmIjoicGFzc3dvcmQifQ}}');
    expect(linkedSecretMarker({ provider: 'op', path: 'op://Payments/Stripe/api key', field: 'crédential', version: '3' }))
      .toBe('{{kurloRef:eyJwIjoib3AiLCJwYXRoIjoib3A6Ly9QYXltZW50cy9TdHJpcGUvYXBpIGtleSIsImYiOiJjcsOpZGVudGlhbCIsInYiOiIzIn0}}');
  });

  it('accepts only complete references', () => {
    expect(normalizeSecretRef({ provider: ' vault ', path: ' kv/app ', field: '' })).toEqual({ provider: 'vault', path: 'kv/app' });
    expect(normalizeSecretRef({ provider: 'vault' })).toBeUndefined();
    expect(normalizeSecretRef('vault:kv/app')).toBeUndefined();
    expect(environmentRowValue({ value: 'plain' })).toBe('plain');
    expect(isLinkedSecretMarker(environmentRowValue({ value: 'stale', secretRef: { provider: 'ci', path: 'TOKEN' } }))).toBe(true);
  });

  it('keeps the link when rows are stored and restored, and never stores a value for it', () => {
    const linked = { ...row('dbPassword', ''), secretRef: { provider: 'vault-prod', path: 'secret/data/app', field: 'password' } };
    const stored = cloneRowsForStore([linked, row('baseUrl', 'https://api.test')]);
    expect(stored[0]).toMatchObject({ key: 'dbPassword', secret: true, secretRef: { provider: 'vault-prod', path: 'secret/data/app', field: 'password' } });
    expect(stored[1]).not.toHaveProperty('secretRef');
    const restored = restoreRows(JSON.parse(JSON.stringify(stored)));
    expect(restored[0]).toMatchObject({ key: 'dbPassword', secret: true, secretRef: { provider: 'vault-prod', path: 'secret/data/app', field: 'password' } });
  });
});

describe('sending with linked environment variables', () => {
  it('sends a marker in place of the value and keeps it out of the masking list', async () => {
    backend.state.savedStores = [];
    backend.state.sentHttpRequests = [];
    backend.state.environment = {};
    backend.state.globals = {};
    const app = new TestApp() as TestApp & Record<string, any>;
    app.prompts.push('Linked');
    await app.createCollection();
    await app.createNewRequest(app.collections[0].id);
    app.url = 'https://api.test/orders';
    app.method = 'GET';
    app.selectAuthType('bearer');
    app.bearerToken = '{{dbPassword}}';
    await app.saveActiveRequest();
    const workspaceId = app.activeWorkspaceId;
    const ref = { provider: 'vault-prod', path: 'secret/data/app', field: 'password' };
    app.environments = [{ id: 'prod', workspaceId, name: 'Prod', values: [{ ...row('dbPassword', ''), secret: true, secretRef: ref }, row('baseUrl', 'https://api.test')] }];
    app.activeEnvironmentId = 'prod';

    let sent: HttpRequest | undefined;
    backend.sendHttpRequest.mockImplementationOnce(async (request: HttpRequest) => {
      sent = request;
      return httpResponse(200, { ok: true });
    });
    await app.runActiveRequest();

    expect(sent?.resolveTemplates).toBe(true);
    expect(sent?.auth.token).toBe('{{dbPassword}}');
    expect(sent?.templateValues?.dbPassword).toBe(linkedSecretMarker(ref));
    expect(sent?.scriptEnvironment?.dbPassword).toBe(linkedSecretMarker(ref));
    const direct = app.savedRequestToRunnableHttpRequest(app.snapshotActiveRequest());
    expect(direct.auth.token).toBe(linkedSecretMarker(ref));
    expect(sent?.workspaceId).toBe(workspaceId);
    expect(app.activeSecretEnvironmentValues()).not.toContain(linkedSecretMarker(ref));
    expect(app.activeSecretEnvironmentKeys()).toContain('dbPassword');
    const stored = backend.state.savedStores.at(-1)!;
    expect(stored.environments.find(environment => environment.id === 'prod')?.values[0]).toMatchObject({ key: 'dbPassword', value: '', secret: true, secretRef: ref });
  });
});

describe('linked secrets in Postman import and export', () => {
  it('finds Postman Vault references anywhere in the payload', async () => {
    const { postmanVaultReferences, postmanVaultNotice } = await import('../lib/postman');
    const payload = {
      item: [{ request: { url: 'https://api.test?k={{vault:stripe-key}}', header: [{ key: 'X', value: '{{ vault:db pass }} and {{vault:stripe-key}}' }] } }],
      variable: [{ key: 'plain', value: '{{notVault}}' }],
    };
    const names = postmanVaultReferences(payload);
    expect(names).toEqual(['db pass', 'stripe-key']);
    expect(postmanVaultNotice(names)).toContain('{{vault:db pass}}, {{vault:stripe-key}}');
    expect(postmanVaultReferences({ item: [] })).toEqual([]);
  });

  it('exports a linked row as an empty secret even when secrets are included', async () => {
    const { buildPostmanEnvironment } = await import('../lib/postman');
    const env = {
      id: 'env', name: 'Prod', workspaceId: 'ws',
      values: [{ ...row('dbPassword', 'stale-value'), secretRef: { provider: 'vault-prod', path: 'secret/data/app' } }],
    } as never;
    const exported = buildPostmanEnvironment(env, true);
    expect(exported.values).toEqual([{ key: 'dbPassword', value: '', enabled: true, type: 'secret' }]);
  });
});
