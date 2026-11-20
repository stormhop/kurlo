import { editBuilder } from '../lib/graphqlBuilder';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  graphQLBuilderSchema,
  DEFAULT_GRAPHQL_QUERY,
  buildGraphQLRequestBody,
  formatGraphQLQuery,
  graphQLSchemaValidationError,
} from '../lib/graphql';

function rootFields(source: string) {
  const schema = graphQLBuilderSchema(source)!;
  return schema.types.get(schema.roots.query!)!.fields;
}

function selectRoot(source: string, name: string) {
  const field = rootFields(source).find(f => f.name === name)!;
  return editBuilder({ query: DEFAULT_GRAPHQL_QUERY, variables: '{}', operationName: '' }, graphQLBuilderSchema(source)!, [field]);
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

describe('GraphQL helpers', () => {
  it('builds an explorer query from imported SDL schema', () => {
    const schema = `
type Query {
  hero(episode: String!): Character
}

type Character {
  id: ID!
  name: String!
  episode: String
}`;

    expect(rootFields(schema).map(field => field.name)).toEqual(['hero']);
    const operation = selectRoot(schema, 'hero');

    expect(operation?.query).toContain('query Example($episode: String!)');
    expect(operation?.query).toContain('hero(episode: $episode)');
    expect(operation.query).toContain('__typename');
    expect(JSON.parse(operation?.variables ?? '{}')).toEqual({ episode: '' });
  });

  it('parses SDL arguments without commas and treats custom scalars as leaves', () => {
    const schema = `
scalar DateTime
enum Episode { NEWHOPE EMPIRE }

type Query {
  hero(
    episode: Episode!
    at: DateTime = "2026-05-09T00:00:00Z"
  ): Character
  now: DateTime!
}

type Character {
  id: ID!
  name: String!
}`;

    const fields = rootFields(schema);
    expect(fields.find(field => field.name === 'hero')?.args).toEqual([
      { name: 'episode', type: 'Episode!', required: true },
      { name: 'at', type: 'DateTime', required: false },
    ]);
    expect(selectRoot(schema, 'hero')?.query).toContain('query Example($episode: Episode!)');
    expect(selectRoot(schema, 'now')?.query).toBe('query Example {\n  now\n}');
  });

  it('preserves deeply nested introspection type refs', () => {
    const schema = JSON.stringify({
      data: {
        __schema: {
          queryType: { name: 'Query' },
          types: [
            {
              kind: 'OBJECT',
              name: 'Query',
              fields: [
                {
                  name: 'users',
                  args: [{
                    name: 'ids',
                    type: {
                      kind: 'NON_NULL',
                      name: null,
                      ofType: {
                        kind: 'LIST',
                        name: null,
                        ofType: {
                          kind: 'NON_NULL',
                          name: null,
                          ofType: { kind: 'SCALAR', name: 'ID', ofType: null },
                        },
                      },
                    },
                  }],
                  type: {
                    kind: 'NON_NULL',
                    name: null,
                    ofType: {
                      kind: 'LIST',
                      name: null,
                      ofType: {
                        kind: 'NON_NULL',
                        name: null,
                        ofType: { kind: 'OBJECT', name: 'User', ofType: null },
                      },
                    },
                  },
                },
              ],
            },
            { kind: 'OBJECT', name: 'User', fields: [{ name: 'id', args: [], type: { kind: 'SCALAR', name: 'ID' } }] },
          ],
        },
      },
    });

    expect(rootFields(schema)[0]).toMatchObject({ name: 'users', type: '[User!]!' });
    expect(selectRoot(schema, 'users')?.query).toContain('query Example($ids: [ID!]!)');
  });

  it('reports GraphQL schema response errors instead of treating them as schemas', () => {
    expect(graphQLSchemaValidationError('{"errors":[{"message":"Introspection disabled"}]}')).toBe('Introspection disabled');
    expect(graphQLSchemaValidationError('{"data":{"viewer":{"id":"1"}}}')).toBe('Response does not contain a GraphQL schema');
  });

  it('formats compact GraphQL queries', () => {
    expect(formatGraphQLQuery('query Hero{hero{name episode}}')).toBe([
      'query Hero {',
      '  hero {',
      '    name',
      '    episode',
      '  }',
      '}',
    ].join('\n'));
  });

  it('posts a GraphQL request body to a local GraphQL server and reads the response', async () => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const payload = JSON.parse(await readBody(req));
      expect(req.method).toBe('POST');
      expect(String(req.headers['content-type'] ?? '')).toContain('application/json');
      expect(payload.query).toContain('hero');
      expect(payload.variables).toEqual({ episode: 'NEWHOPE' });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { hero: { name: 'Luke Skywalker', episode: payload.variables.episode } } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not expose a TCP address');

    try {
      const resp = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildGraphQLRequestBody({
          query: 'query Hero($episode: String!) { hero(episode: $episode) { name episode } }',
          variables: '{"episode":"NEWHOPE"}',
          operationName: '',
        }),
      });

      expect(resp.status).toBe(200);
      await expect(resp.json()).resolves.toEqual({
        data: { hero: { name: 'Luke Skywalker', episode: 'NEWHOPE' } },
      });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
