import { describe, expect, it } from 'vitest';
import { makeCollection, makeWorkspace, normalizeCollection, normalizeEnvironment, normalizeSavedRequest, normalizeWorkspace } from '../lib/normalizers';

const garbage: unknown[] = [42, 'text', { a: 1 }, [1, 'x', null], null, true, [{ key: 5, value: { x: 1 } }]];
const kind = (value: unknown) => Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;

function everyFieldSurvives<T extends Record<string, unknown>>(base: T, build: (input: Record<string, unknown>) => Record<string, unknown>, label: string) {
  const problems: string[] = [];
  for (const key of Object.keys(base)) {
    for (const value of garbage) {
      try {
        const out = build({ ...base, [key]: value });
        if (base[key] !== undefined && kind(base[key]) !== kind(out[key])) problems.push(`${label}.${key}=${JSON.stringify(value)} became ${kind(out[key])}`);
      } catch (error) {
        problems.push(`${label}.${key}=${JSON.stringify(value)} threw ${(error as Error).message}`);
      }
    }
  }
  return problems;
}

describe('hand-edited workspace YAML with wrong types', () => {
  const workspace = makeWorkspace('Main');
  const collection = makeCollection(workspace.id, 'Core');
  const request = normalizeSavedRequest({ id: 'r', name: 'Get', collectionId: collection.id } as never, [collection], workspace.id) as unknown as Record<string, unknown>;
  const buildRequest = (input: Record<string, unknown>) => normalizeSavedRequest(input as never, [collection], workspace.id) as unknown as Record<string, unknown>;

  it('never crashes and keeps every field its expected type', () => {
    const problems = [
      ...everyFieldSurvives(request, buildRequest, 'request'),
      ...everyFieldSurvives(request.auth as Record<string, unknown>, auth => buildRequest({ ...request, auth }).auth as Record<string, unknown>, 'auth'),
      ...everyFieldSurvives(request.settings as Record<string, unknown>, settings => buildRequest({ ...request, settings }).settings as Record<string, unknown>, 'settings'),
      ...everyFieldSurvives(normalizeCollection(collection, workspace.id) as unknown as Record<string, unknown>, input => normalizeCollection(input as never, workspace.id) as unknown as Record<string, unknown>, 'collection'),
      ...everyFieldSurvives(collection.defaults as unknown as Record<string, unknown>, defaults => normalizeCollection({ ...collection, defaults } as never, workspace.id).defaults as unknown as Record<string, unknown>, 'defaults'),
      ...everyFieldSurvives({ id: 'e', name: 'Local', workspaceId: workspace.id, values: [] }, input => normalizeEnvironment(input as never, workspace.id) as unknown as Record<string, unknown>, 'environment'),
      ...everyFieldSurvives(workspace as unknown as Record<string, unknown>, input => normalizeWorkspace(input as never) as unknown as Record<string, unknown>, 'workspace'),
    ];
    expect(problems).toEqual([]);
  });

  it('reads unquoted numbers the way they were meant', () => {
    const out = buildRequest({ ...request, name: 404, url: 8080, headers: [{ key: 5, value: 10 }, null, 'junk'], settings: { ...(request.settings as object), timeoutMs: '1500' } });
    expect(out.name).toBe('404');
    expect(out.url).toBe('8080');
    expect(out.headers).toEqual([expect.objectContaining({ key: '5', value: '10' })]);
    expect((out.settings as { timeoutMs: number }).timeoutMs).toBe(1500);
  });
});
