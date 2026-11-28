import { parse } from 'graphql/language/parser';
import { print } from 'graphql/language/printer';
import type { OperationDefinitionNode } from 'graphql/language/ast';
import { stripJsonComments } from './jsonEditing';
import { asText, isRecord } from './utils';

export type GraphQLPayload = {
  query: string;
  variables: string;
  operationName: string;
  connectionPayload?: string;
};

export type GraphQLOperationType = 'query' | 'mutation' | 'subscription';

export type GraphQLExplorerArg = {
  name: string;
  type: string;
  required: boolean;
};

type IntrospectionTypeRef = {
  kind?: string | null;
  name?: string | null;
  ofType?: IntrospectionTypeRef | null;
};

export type BuilderField = {
  name: string;
  description: string;
  args: GraphQLExplorerArg[];
  type: string;
  namedType: string;
};

export type BuilderType = {
  kind: string;
  fields: BuilderField[];
  possibleTypes: string[];
  enumValues: string[];
  inputs: GraphQLExplorerArg[];
};

export type BuilderSchema = {
  roots: Partial<Record<'query' | 'mutation' | 'subscription', string>>;
  types: Map<string, BuilderType>;
};

export const DEFAULT_GRAPHQL_QUERY = `query Example {
  __typename
}`;

export const DEFAULT_GRAPHQL_VARIABLES = '{\n}';

export const GRAPHQL_INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      description
      fields(includeDeprecated: true) {
        name
        description
        args {
          name
          description
          defaultValue
          type { ...TypeRef }
        }
        type { ...TypeRef }
        isDeprecated
        deprecationReason
      }
      inputFields {
        name
        description
        defaultValue
        type { ...TypeRef }
      }
      interfaces { ...TypeRef }
      enumValues(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
      }
      possibleTypes { ...TypeRef }
    }
    directives {
      name
      description
      locations
      args {
        name
        description
        defaultValue
        type { ...TypeRef }
      }
    }
  }
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
        }
      }
    }
  }
}`;

function prettyConnectionPayload(value: unknown) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    const clean = value.trim();
    if (!clean) return '';
    try {
      return JSON.stringify(JSON.parse(stripJsonComments(clean)), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function prettyJsonValue(value: unknown) {
  if (typeof value === 'string') {
    const clean = value.trim();
    if (!clean) return DEFAULT_GRAPHQL_VARIABLES;
    try {
      return JSON.stringify(JSON.parse(stripJsonComments(clean)), null, 2);
    } catch {
      return value;
    }
  }
  if (value === undefined || value === null) return DEFAULT_GRAPHQL_VARIABLES;
  return JSON.stringify(value, null, 2);
}

export function parseGraphQLPayload(source: string): GraphQLPayload {
  const clean = source.trim();
  if (!clean) {
    return { query: DEFAULT_GRAPHQL_QUERY, variables: DEFAULT_GRAPHQL_VARIABLES, operationName: '' };
  }

  try {
    const parsed = JSON.parse(stripJsonComments(clean)) as unknown;
    if (isRecord(parsed)) {
      return {
        query: asText(parsed.query) || DEFAULT_GRAPHQL_QUERY,
        variables: prettyJsonValue(parsed.variables),
        operationName: asText(parsed.operationName),
        connectionPayload: prettyConnectionPayload(parsed.connectionPayload),
      };
    }
  } catch {

  }

  return { query: source, variables: DEFAULT_GRAPHQL_VARIABLES, operationName: '' };
}

export function parseGraphQLVariables(source: string): Record<string, unknown> {
  const clean = source.trim();
  if (!clean) return {};
  const parsed = JSON.parse(stripJsonComments(clean)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('GraphQL variables must be a JSON object');
  }
  return parsed;
}

export function serializeGraphQLPayload(payload: GraphQLPayload): string {
  let variables: unknown;
  try {
    variables = parseGraphQLVariables(payload.variables);
  } catch {
    variables = payload.variables;
  }
  const connection = (payload.connectionPayload ?? '').trim();
  let connectionPayload: unknown;
  if (connection) {
    try {
      connectionPayload = JSON.parse(stripJsonComments(connection));
    } catch {
      connectionPayload = payload.connectionPayload;
    }
  }
  return JSON.stringify({
    query: payload.query,
    variables,
    ...(payload.operationName.trim() ? { operationName: payload.operationName.trim() } : {}),
    ...(connection ? { connectionPayload } : {}),
  }, null, 2);
}

export function parseGraphQLConnectionPayload(source: string): string {
  const clean = source.trim();
  if (!clean) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(clean));
  } catch {
    throw new Error('GraphQL connection payload must be a JSON object');
  }
  if (!isRecord(parsed)) throw new Error('GraphQL connection payload must be a JSON object');
  return JSON.stringify(parsed);
}

export function graphQLOperationType(payload: Pick<GraphQLPayload, 'query' | 'operationName'>): GraphQLOperationType | '' {
  let operations: OperationDefinitionNode[];
  try {
    operations = parse(payload.query).definitions.filter((d): d is OperationDefinitionNode => d.kind === 'OperationDefinition');
  } catch {
    const name = payload.operationName.trim();
    const pattern = name
      ? new RegExp(`(?:^|[^\\w])(query|mutation|subscription)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
      : /^\s*(?:#[^\n]*\n\s*)*(query|mutation|subscription)\b/;
    return (payload.query.match(pattern)?.[1] as GraphQLOperationType | undefined) ?? '';
  }
  const name = payload.operationName.trim();
  const selected = name
    ? operations.find(op => op.name?.value === name)
    : operations.length === 1 ? operations[0] : undefined;
  return selected?.operation ?? '';
}

export function buildGraphQLRequestBody(payload: GraphQLPayload): string {
  const query = payload.query.trim();
  if (!query) {
    throw new Error('GraphQL query is empty');
  }
  const body: Record<string, unknown> = {
    query,
    variables: parseGraphQLVariables(payload.variables),
  };
  const operationName = payload.operationName.trim();
  if (operationName) body.operationName = operationName;
  return JSON.stringify(body);
}

function compactWhitespace(source: string) {
  return source.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function typeRefToString(ref?: IntrospectionTypeRef | null): string {
  if (!ref) return '';
  if (ref.kind === 'NON_NULL') return `${typeRefToString(ref.ofType)}!`;
  if (ref.kind === 'LIST') return `[${typeRefToString(ref.ofType)}]`;
  return ref.name ?? '';
}

function namedType(type: string) {
  return type.replace(/[[\]!\s]/g, '');
}

function inputArg(name: string, type: string, hasDefault: boolean): GraphQLExplorerArg {
  return { name, type, required: type.endsWith('!') && !hasDefault };
}

function introspectionArgs(items: unknown) {
  if (!Array.isArray(items)) return [];
  return items.filter(isRecord).map(arg => inputArg(asText(arg.name), typeRefToString(arg.type as IntrospectionTypeRef), arg.defaultValue != null));
}

function introspectionSchema(source: string): BuilderSchema | null {
  const parsed: unknown = JSON.parse(stripJsonComments(source));
  const root = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : parsed;
  const schema = isRecord(root) && isRecord(root.__schema) ? root.__schema : root;
  if (!isRecord(schema) || !Array.isArray(schema.types)) return null;
  const roots: BuilderSchema['roots'] = {};
  for (const kind of ['query', 'mutation', 'subscription'] as const) {
    const ref = schema[kind + 'Type'];
    if (isRecord(ref)) roots[kind] = asText(ref.name);
  }
  roots.query ||= 'Query';
  const types = new Map<string, BuilderType>();
  const names = (items: unknown) => Array.isArray(items) ? items.filter(isRecord).map(item => asText(item.name)) : [];
  for (const t of schema.types.filter(isRecord)) {
    const fields = Array.isArray(t.fields) ? t.fields.filter(isRecord).map(f => {
      const type = typeRefToString(f.type as IntrospectionTypeRef);
      return { name: asText(f.name), type, namedType: namedType(type), description: asText(f.description), args: introspectionArgs(f.args) };
    }) : [];
    types.set(asText(t.name), { kind: asText(t.kind), fields, possibleTypes: names(t.possibleTypes), enumValues: names(t.enumValues), inputs: introspectionArgs(t.inputFields) });
  }
  return { roots, types };
}

function sdlSchema(source: string): BuilderSchema | null {
  const types = new Map<string, BuilderType>();
  const roots: BuilderSchema['roots'] = {};
  const implementations: [string, string][] = [];
  let explicitRoots = false;
  for (const d of parse(source).definitions) {
    if (d.kind === 'SchemaDefinition' || d.kind === 'SchemaExtension') {
      if (d.kind === 'SchemaDefinition') explicitRoots = true;
      for (const root of d.operationTypes ?? []) roots[root.operation] = root.type.name.value;
      continue;
    }
    if (!('name' in d) || !d.name || !/Type(Definition|Extension)$/.test(d.kind)) continue;
    const name = d.name.value;
    const kind = d.kind.replace(/Type(Definition|Extension)$/, '').replace('InputObject', 'Input_Object').toUpperCase();
    const type: BuilderType = types.get(name) ?? { kind, fields: [], inputs: [], enumValues: [], possibleTypes: [] };
    types.set(name, type);
    if (d.kind === 'ObjectTypeDefinition' || d.kind === 'ObjectTypeExtension' || d.kind === 'InterfaceTypeDefinition' || d.kind === 'InterfaceTypeExtension') {
      for (const f of d.fields ?? []) {
        const ref = print(f.type);
        type.fields.push({ name: f.name.value, type: ref, namedType: namedType(ref), description: f.description?.value ?? '', args: (f.arguments ?? []).map(a => inputArg(a.name.value, print(a.type), !!a.defaultValue)) });
      }
      if (kind === 'OBJECT') for (const iface of d.interfaces ?? []) implementations.push([iface.name.value, name]);
    } else if (d.kind === 'InputObjectTypeDefinition' || d.kind === 'InputObjectTypeExtension') {
      for (const input of d.fields ?? []) type.inputs.push(inputArg(input.name.value, print(input.type), !!input.defaultValue));
    } else if (d.kind === 'UnionTypeDefinition' || d.kind === 'UnionTypeExtension') {
      type.possibleTypes.push(...(d.types ?? []).map(t => t.name.value));
    } else if (d.kind === 'EnumTypeDefinition' || d.kind === 'EnumTypeExtension') {
      type.enumValues.push(...(d.values ?? []).map(v => v.name.value));
    }
  }
  for (const [iface, type] of implementations) types.get(iface)?.possibleTypes.push(type);
  if (!explicitRoots) for (const [op, name] of [['query', 'Query'], ['mutation', 'Mutation'], ['subscription', 'Subscription']] as const) {
    if (types.has(name)) roots[op] ??= name;
  }
  return types.size && roots.query ? { roots, types } : null;
}

export function graphQLBuilderSchema(source: string): BuilderSchema | null {
  try {
    const clean = source.trimStart();
    return /^[{/]/.test(clean) ? introspectionSchema(clean) : sdlSchema(clean);
  } catch {
    return null;
  }
}

export function normalizeGraphQLSchemaText(source: string) {
  const clean = source.trim();
  if (!clean) return '';
  try {
    return JSON.stringify(JSON.parse(stripJsonComments(clean)), null, 2);
  } catch {
    return compactWhitespace(source);
  }
}

function graphQLErrorSummary(errors: unknown): string {
  if (!Array.isArray(errors) || !errors.length) return '';
  const messages = errors
    .map(error => isRecord(error) ? asText(error.message) : asText(error))
    .filter(Boolean)
    .slice(0, 3);
  return messages.length ? messages.join('; ') : 'GraphQL returned errors';
}

export function graphQLSchemaValidationError(source: string): string {
  const clean = source.trim();
  if (!clean) return 'GraphQL schema response is empty';
  try {
    const parsed = JSON.parse(stripJsonComments(clean)) as unknown;
    if (isRecord(parsed)) {
      const errorSummary = graphQLErrorSummary(parsed.errors);
      if (errorSummary) return errorSummary;
    }
  } catch {}
  const model = graphQLBuilderSchema(clean);
  if (!model) return 'Response does not contain a GraphQL schema';
  const query = model.types.get(model.roots.query ?? 'Query');
  if (!query) return `GraphQL schema query type "${model.roots.query ?? 'Query'}" was not found`;
  if (!query.fields.some(field => !field.name.startsWith('__'))) {
    return 'GraphQL schema does not expose query fields';
  }
  return '';
}

function needsSpaceBefore(line: string) {
  return Boolean(line && !/[\s([{!:@,]$/.test(line));
}

export function formatGraphQLQuery(source: string) {
  const clean = source.trim();
  if (!clean) return source;
  const lines: string[] = [];
  let line = '';
  let indent = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escaped = false;
  const push = () => {
    const trimmed = line.trim();
    if (trimmed) lines.push(`${'  '.repeat(Math.max(indent, 0))}${trimmed}`);
    line = '';
  };
  const append = (text: string) => {
    if (line.trim() === '}' && /^[A-Za-z_$]/.test(text)) push();
    line += text;
  };

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inString) {
      line += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      append(ch);
      inString = true;
      continue;
    }
    if (ch === '#') {
      line += clean.slice(i).split('\n')[0];
      push();
      i += clean.slice(i).split('\n')[0].length - 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (parenDepth === 0 && bracketDepth === 0 && indent > 0 && /^[_A-Za-z][_0-9A-Za-z]*$/.test(line.trim())) {
        push();
        continue;
      }
      if (line && !/\s$/.test(line)) line += ' ';
      continue;
    }
    if (ch === '{') {
      if (needsSpaceBefore(line)) line += ' ';
      line += '{';
      push();
      indent += 1;
      continue;
    }
    if (ch === '}') {
      push();
      indent -= 1;
      line = '}';
      continue;
    }
    if (ch === ',') {
      line = line.trimEnd() + ', ';
      continue;
    }
    if (ch === ':') {
      line = line.trimEnd() + ': ';
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '@' || ch === '$' || ch === '!') {
      if (ch === '(') parenDepth += 1;
      if (ch === '[') bracketDepth += 1;
      line = line.trimEnd() + ch;
      continue;
    }
    if (ch === ')' || ch === ']') {
      if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
      if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      line = line.trimEnd() + ch;
      continue;
    }
    append(ch);
  }
  push();
  return lines.join('\n');
}
