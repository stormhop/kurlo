import { describe, expect, it } from 'vitest';
import { normalizeSavedRequest } from '../lib/normalizers';
import { resolveFormRequestTab } from '../lib/requestTabPreferences';

describe('restoring a request section', () => {
  it('accepts available legacy sections when normalizing a saved request', () => {
    expect(normalizeSavedRequest({ requestType: 'graphql', requestTab: 'examples' }, [], 'w').requestTab).toBe('examples');
    expect(normalizeSavedRequest({ requestType: 'ws', requestTab: 'auth' }, [], 'w').requestTab).toBe('auth');
  });

  it('falls back to a visible section for the protocol and method', () => {
    expect(resolveFormRequestTab('http', 'SSE', 'scripts', 'headers')).toBe('headers');
    expect(resolveFormRequestTab('http', 'SSE', 'examples')).toBe('params');
    expect(resolveFormRequestTab('graphql', 'POST', 'settings')).toBe('query');
    expect(resolveFormRequestTab('grpc', 'POST', 'params')).toBe('body');
    expect(resolveFormRequestTab('grpc', 'POST', 'metadata')).toBe('metadata');
    expect(resolveFormRequestTab('http', 'GET', 'file', 'headers')).toBe('headers');
  });
});
