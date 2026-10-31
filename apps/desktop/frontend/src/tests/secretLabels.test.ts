import { describe, expect, it } from 'vitest';
import { describeWorkspaceSecret, groupWorkspaceSecrets, type SecretLabelContext } from '../lib/secretLabels';
import { makeCollection, normalizeSavedRequest } from '../lib/normalizers';
import type { Environment, Workspace } from '../lib/types/models';

function context(): SecretLabelContext {
  const collection = makeCollection('ws-1', 'Shop API');
  collection.defaults.headers = [{ id: 21, enabled: true, key: 'X-Api-Key', value: '', description: '' }];
  const login = normalizeSavedRequest({ id: 'req-login', name: 'Login user', collectionId: collection.id, folderPath: ['Auth'], method: 'POST', url: 'https://shop.test/login', headers: [{ id: 7, enabled: true, key: 'Authorization', value: '', description: '' }] }, [collection], 'ws-1');
  const environment: Environment = { id: 'env-staging', workspaceId: 'ws-1', name: 'Staging', filesystemName: 'Staging', values: [{ id: 3, enabled: true, key: 'password', value: '', description: '' }] };
  const workspace = { id: 'ws-1', name: 'Main', filesystemName: 'Main', description: '' } as Workspace;
  return { requests: [login], collections: [collection], environments: [environment], workspaces: [workspace], cookies: [{ name: 'session', domain: '.shop.test' }] };
}

describe('workspace secret labels', () => {
  it('names a request secret by the request, its method and location, and the auth field', () => {
    const ctx = context();
    expect(describeWorkspaceSecret('request.req-login.auth.bearerToken', ctx)).toMatchObject({
      groupKind: 'request', groupTitle: 'Login user', groupDetail: 'POST · Shop API / Auth', title: 'Bearer token',
    });
  });

  it('uses the key of the row a header, variable or environment secret belongs to', () => {
    const ctx = context();
    const collectionId = ctx.collections[0].id;
    expect(describeWorkspaceSecret('request.req-login.headers.row.7.value', ctx).title).toBe('Header “Authorization”');
    expect(describeWorkspaceSecret(`collection.${collectionId}.headers.row.21.value`, ctx)).toMatchObject({ groupTitle: 'Collection “Shop API”', title: 'Header “X-Api-Key”' });
    expect(describeWorkspaceSecret('environment.env-staging.row.3.value', ctx)).toMatchObject({ groupTitle: 'Environment “Staging”', title: 'Variable “password”' });
  });

  it('falls back to the row name the workspace file gives when row ids changed on load', () => {
    expect(describeWorkspaceSecret('environment.env-staging.row.99.value', context(), 'token').title).toBe('Variable “token”');
    expect(describeWorkspaceSecret('environment.env-staging.row.99.value', context()).title).toBe('Variable');
  });

  it('names cookies by their cookie name and known domain', () => {
    expect(describeWorkspaceSecret('workspace.ws-1.cookies.session.2ff83fa72e.value', context())).toMatchObject({
      groupKind: 'cookies', groupTitle: 'Saved cookies', groupDetail: 'Cookie jar of Main', title: 'Cookie “session”', detail: 'shop.test',
    });
  });

  it('says when the owner of a secret is gone and keeps unknown keys readable', () => {
    const ctx = context();
    expect(describeWorkspaceSecret('request.req-gone.auth.basicPass', ctx)).toMatchObject({ groupTitle: 'Request no longer in this workspace', title: 'Basic auth password' });
    expect(describeWorkspaceSecret('request.req-login.auth.someNewField', ctx).title).toBe('Some new field');
    expect(describeWorkspaceSecret('globals.thing', ctx)).toMatchObject({ groupKind: 'other', title: 'globals.thing' });
  });

  it('groups secrets by owner with requests first and cookies after environments', () => {
    const ctx = context();
    const groups = groupWorkspaceSecrets([
      { key: 'workspace.ws-1.cookies.session.2ff83fa72e.value' },
      { key: 'environment.env-staging.row.3.value' },
      { key: 'request.req-login.headers.row.7.value' },
      { key: 'request.req-login.auth.bearerToken' },
    ], ctx);
    expect(groups.map(group => group.kind)).toEqual(['request', 'environment', 'cookies']);
    expect(groups[0].items.map(item => item.title)).toEqual(['Header “Authorization”', 'Bearer token']);
  });
});
