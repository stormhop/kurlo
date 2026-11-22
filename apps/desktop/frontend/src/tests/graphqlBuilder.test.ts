import { describe, expect, it } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import { editBuilder, newOperation, type Branch } from '../lib/graphqlBuilder';
import { graphQLBuilderSchema, DEFAULT_GRAPHQL_QUERY, type GraphQLPayload } from '../lib/graphql';

const source = `
  schema { query: Catalog mutation: Changes }
  interface Node { id: ID! }
  type Book implements Node { id: ID! title: String author: Author chapters(limit: Int! = 5): [String!] }
  type Author { name: String books(id: ID!): [Book!] }
  enum Edition { PAPER DIGITAL }
  input Filter { edition: Edition!, scores: [Int!]!, featured: Boolean = false }
  union Result = Author | Book
  type Catalog { book(id: ID!): Book search(filter: Filter!): [Result!] status: String }
  type Changes { publish(id: ID!): Book }
`;
const schema = graphQLBuilderSchema(source)!;
const executable = buildSchema(source);
const field = (type: string, name: string) => schema.types.get(type)!.fields.find(f => f.name === name)!;
const book = field('Catalog', 'book');
const author = field('Book', 'author');
const empty = (): GraphQLPayload => ({ query: DEFAULT_GRAPHQL_QUERY, variables: '{}', operationName: '' });
const edit = (payload: GraphQLPayload, path: Branch[]) => editBuilder(payload, schema, path);
const valid = (payload: GraphQLPayload) => expect(validate(executable, parse(payload.query)).map(e => e.message)).toEqual([]);

describe('introspection query builder', () => {
  it('builds a missing branch with collision-free variables and removes orphaned definitions', () => {
    const nested = field('Author', 'books');
    const path = [book, author, nested, field('Book', 'title')];
    const p = edit(empty(), path);
    expect(p.query).toContain('books(id: $id2)');
    expect(JSON.parse(p.variables)).toEqual({ id: '', id2: '' });
    valid(p);
    const removed = edit(p, [book, author]);
    expect(JSON.parse(removed.variables)).toEqual({ id: '' });
    expect(removed.query).not.toContain('$id2');
    valid(removed);
    valid(edit(removed, [book]));
  });

  it('edits repeated fields across sibling selections and preserves aliases and unrelated operations', () => {
    const payload = {
      query: 'query Pick($id: ID!) { book(id: $id) { title } book(id: $id) { title id } alias: status } query Other { status }',
      operationName: 'Pick', variables: '{"id":"42"}',
    };
    const changed = editBuilder(payload, schema, [book], { arg: book.args[0] });
    valid(changed);
    expect(changed.query.match(/book\(id: \$id2\)/g)).toHaveLength(2);
    const untitled = edit(changed, [book, field('Book', 'title')]);
    valid(untitled);
    expect(untitled.query).not.toContain('title');
    expect(untitled.query).toContain('__typename');
    expect(untitled.query).toMatch(/\{\s*id\s*\}/);
    const removed = edit(untitled, [book]);
    valid(removed);
    expect(removed.query).not.toContain('book');
    expect(removed.query).toContain('alias: status');
    expect(removed.query).toContain('query Other { status }');
    expect(JSON.parse(removed.variables)).toEqual({});
  });

  it('uses concrete fragments on unions and seeds required input fields and enum values', () => {
    const search = field('Catalog', 'search');
    const p = edit(empty(), [search, { onType: 'Book' }, field('Book', 'title')]);
    expect(p.query).toContain('... on Book');
    expect(JSON.parse(p.variables)).toEqual({ filter: { edition: 'PAPER', scores: [] } });
    valid(p);
    const optional = edit(empty(), [book, field('Book', 'chapters')]);
    expect(optional.query).not.toContain('$limit');
    valid(optional);
  });

  it('preserves handwritten aliases, shared variables, other operations, directives, fragments and comments', () => {
    const rest = 'query Other($id: ID!) { book(id: $id) { ...Details } }\nfragment Details on Book { title }';
    const original = { query: 'query Pick($id: ID!) {\n  # keep this\n  alias: status @skip(if: false)\n  book(id: $id) { id }\n}\n' + rest,
      operationName: 'Pick', variables: '{ "id": "42", "large": 9007199254740993 }' };
    const removed = edit(original, [book]);
    expect(removed.query).toContain('# keep this\n  alias: status @skip(if: false)');
    expect(removed.query).toContain(rest);
    expect(removed.variables).toBe(original.variables);
    valid(removed);
    const p = edit(removed, [book, field('Book', 'title')]);
    expect(p.query).toContain('book(id: $id2)');
    expect(p.variables).toContain('9007199254740993');
    valid(p);
  });

  it('keeps variables used in reachable fragments and removes only the binding being replaced', () => {
    const p = { query: 'query Sample($id: ID!){ book(id:$id){ title } ...F } fragment F on Catalog { second: book(id:$id){ id } }', variables: '{"id":"7"}', operationName: 'Sample' };
    const changed = editBuilder(p, schema, [book], { arg: book.args[0], value: '"2"' });
    expect(changed.variables).toBe(p.variables);
    valid(changed);
    const fresh = editBuilder(changed, schema, [book], { arg: book.args[0], value: '$bookId' });
    expect(JSON.parse(fresh.variables)).toEqual({ id: '7', bookId: '' });
    valid(fresh);
  });

  it('switches optional arguments between variables and literals and checks enum and input values', () => {
    const chapters = field('Book', 'chapters');
    const path = [book, chapters];
    const p = edit(empty(), path);
    const variable = editBuilder(p, schema, path, { arg: chapters.args[0] });
    expect(JSON.parse(variable.variables)).toEqual({ id: '', limit: 0 });
    const literal = editBuilder(variable, schema, path, { arg: chapters.args[0], value: '3' });
    expect(literal.query).toContain('chapters(limit: 3)');
    expect(JSON.parse(literal.variables)).toEqual({ id: '' });
    valid(literal);
    expect(() => editBuilder(p, schema, path, { arg: chapters.args[0], value: 'null' })).toThrow();
    expect(() => editBuilder(p, schema, path, { arg: chapters.args[0], value: '"three"' })).toThrow();
    const removed = editBuilder(literal, schema, path, { arg: chapters.args[0], value: '' });
    expect(removed.query).not.toContain('limit');
    valid(removed);
    const search = field('Catalog', 'search');
    const s = edit(empty(), [search]);
    expect(() => editBuilder(s, schema, [search], { arg: search.args[0], value: '{edition: AUDIO, scores: []}' })).toThrow('PAPER');
    valid(editBuilder(s, schema, [search], { arg: search.args[0], value: '{edition: PAPER, scores: [5]}' }));
    expect(() => editBuilder(s, schema, [search], { arg: search.args[0], value: '{edition: PAPER, edition: DIGITAL, scores: []}' })).toThrow('edition');
    for (const value of ['2147483648', '-2147483649']) {
      expect(() => editBuilder(p, schema, path, { arg: chapters.args[0], value })).toThrow('Int');
    }
    for (const value of ['2147483647', '-2147483648']) {
      valid(editBuilder(p, schema, path, { arg: chapters.args[0], value }));
    }
  });

  it('adds named operations alongside shorthand queries and respects an invalid draft', () => {
    const p = newOperation({ query: '{ status }', variables: '{}', operationName: '' }, 'mutation');
    const populated = edit(p, [field('Changes', 'publish'), field('Book', 'id')]);
    expect(populated.query).toContain('query Original { status }');
    expect(populated.operationName).toBe('Mutation');
    valid(populated);
    expect(() => edit({ ...p, query: 'query Broken {' }, [book])).toThrow();
    expect(() => edit({ ...empty(), variables: '{ draft' }, [book])).toThrow();
  });
});
