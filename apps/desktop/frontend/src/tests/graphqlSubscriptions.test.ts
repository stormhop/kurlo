import { describe, expect, it } from 'vitest';
import {
  buildGraphQLRequestBody,
  graphQLOperationType,
  parseGraphQLConnectionPayload,
  parseGraphQLPayload,
  serializeGraphQLPayload,
} from '../lib/graphql';

describe('GraphQL subscriptions', () => {
  it('detects the type of the selected operation', () => {
    expect(graphQLOperationType({ query: 'subscription OnTick { tick }', operationName: '' })).toBe('subscription');
    expect(graphQLOperationType({ query: '{ me { id } }', operationName: '' })).toBe('query');
    expect(graphQLOperationType({ query: 'mutation Save { save }', operationName: '' })).toBe('mutation');
    const document = 'query Me { me { id } }\n\nsubscription OnTick { tick }';
    expect(graphQLOperationType({ query: document, operationName: 'OnTick' })).toBe('subscription');
    expect(graphQLOperationType({ query: document, operationName: 'Me' })).toBe('query');
    expect(graphQLOperationType({ query: document, operationName: '' })).toBe('');
    expect(graphQLOperationType({ query: document, operationName: 'Missing' })).toBe('');
  });

  it('still detects a subscription while the query does not parse yet', () => {
    expect(graphQLOperationType({ query: '# live\nsubscription OnTick { tick(id: {{id}}) }', operationName: '' })).toBe('subscription');
    expect(graphQLOperationType({ query: 'query Me { a }\nsubscription OnTick { tick(id: {{id}}) }', operationName: 'OnTick' })).toBe('subscription');
  });

  it('keeps the connection payload in the stored body but not in the HTTP body', () => {
    const stored = serializeGraphQLPayload({
      query: 'subscription OnTick { tick }',
      variables: '{}',
      operationName: '',
      connectionPayload: '{\n  "authorization": "Bearer {{token}}"\n}',
    });
    expect(JSON.parse(stored).connectionPayload).toEqual({ authorization: 'Bearer {{token}}' });
    const parsed = parseGraphQLPayload(stored);
    expect(parsed.connectionPayload).toBe('{\n  "authorization": "Bearer {{token}}"\n}');
    expect(JSON.parse(buildGraphQLRequestBody(parsed))).toEqual({ query: 'subscription OnTick { tick }', variables: {} });
  });

  it('omits an empty connection payload', () => {
    const stored = serializeGraphQLPayload({ query: '{ a }', variables: '{}', operationName: '', connectionPayload: '  ' });
    expect(JSON.parse(stored)).not.toHaveProperty('connectionPayload');
    expect(parseGraphQLPayload(stored).connectionPayload).toBe('');
  });

  it('validates the connection payload as a JSON object', () => {
    expect(parseGraphQLConnectionPayload('')).toBe('');
    expect(parseGraphQLConnectionPayload('{\n  // token\n  "a": 1\n}')).toBe('{"a":1}');
    expect(() => parseGraphQLConnectionPayload('[1]')).toThrow('GraphQL connection payload must be a JSON object');
    expect(() => parseGraphQLConnectionPayload('{a}')).toThrow('GraphQL connection payload must be a JSON object');
  });
});
