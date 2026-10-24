import { describe, expect, it } from 'vitest';
import { docsReference, type DocsReferenceInput } from '../lib/docsReference';

const row = (key: string, value: string, extra: Record<string, unknown> = {}) => ({ id: 1, enabled: true, key, value, description: '', ...extra });

function input(changes: Partial<DocsReferenceInput> = {}): DocsReferenceInput {
  return {
    requestType: 'http', method: 'POST', url: ' https://api.test/users/:id ', params: [], pathParams: [], headers: [],
    bodyType: 'raw', rawBodyType: 'json', bodyContent: '', formRows: [], graphqlQuery: '', authType: 'none',
    ...changes,
  };
}

describe('docs reference', () => {
  it('lists the enabled params, headers and body with their descriptions', () => {
    const ref = docsReference(input({
      params: [row('page', '2', { description: 'Page number' }), row('off', 'x', { enabled: false }), row(' ', 'empty')],
      pathParams: [row('id', '42')],
      headers: [row('X-Token', 'abc', { secret: true })],
      bodyContent: '{"name":"Ann"}',
      authType: 'bearer',
    }));
    expect(ref).toEqual({
      method: 'POST',
      url: 'https://api.test/users/:id',
      auth: 'Bearer token',
      pathParams: [{ key: 'id', value: '42', description: '' }],
      params: [{ key: 'page', value: '2', description: 'Page number' }],
      headers: [{ key: 'X-Token', value: '••••', description: '' }],
      body: { label: 'JSON', text: '{"name":"Ann"}', rows: [] },
    });
  });

  it('shows form bodies as rows and GraphQL queries as text', () => {
    expect(docsReference(input({ bodyType: 'form', formRows: [row('file', '', { isFile: true, fileName: 'a.png' })] })).body)
      .toEqual({ label: 'Form data', text: '', rows: [{ key: 'file', value: 'a.png', description: '' }] });
    expect(docsReference(input({ requestType: 'graphql', graphqlQuery: ' { me { id } } ' })))
      .toMatchObject({ method: 'POST', body: { label: 'GraphQL', text: '{ me { id } }' } });
  });

  it('leaves out query params and bodies for other protocols', () => {
    const ref = docsReference(input({ requestType: 'mcp', params: [row('a', 'b')], bodyContent: '{}' }));
    expect(ref).toMatchObject({ method: 'MCP', params: [], body: null });
  });
});
