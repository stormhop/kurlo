import { stripJsonComments } from './jsonEditing';
import { asText, isRecord } from './utils';

export type GraphQLPayload = {
  query: string;
  variables: string;
  operationName: string;
};

export type GraphQLExplorerArg = {
  name: string;
  type: string;
  required: boolean;
};

export type GraphQLExplorerField = {
  parentType: string;
  name: string;
  description: string;
  args: GraphQLExplorerArg[];
  type: string;
  namedType: string;
  kind: string;
};

type IntrospectionTypeRef = {
  kind?: string | null;
  name?: string | null;
  ofType?: IntrospectionTypeRef | null;
};

type TypeField = {
  name: string;
  description: string;
  args: GraphQLExplorerArg[];
  type: string;
  namedType: string;
  kind: string;
};

type TypeMap = Map<string, { kind: string; fields: TypeField[] }>;

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
  return JSON.stringify({
    query: payload.query,
    variables,
    ...(payload.operationName.trim() ? { operationName: payload.operationName.trim() } : {}),
  }, null, 2);
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

function stripDescriptionBlocks(source: string) {
  return source.replace(/"""[\s\S]*?"""/g, '').replace(/"[^"\n]*"/g, '');
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

function unwrapTypeRef(ref?: IntrospectionTypeRef | null): { namedType: string; kind: string; required: boolean } {
  let current = ref;
  let required = false;
  while (current?.ofType) {
    if (current.kind === 'NON_NULL') required = true;
    current = current.ofType;
  }
  return { namedType: current?.name ?? '', kind: current?.kind ?? '', required };
}

function typeNameFromSDL(type: string) {
  return type.replace(/[[\]!\s]/g, '');
}

function isLeafKind(kind: string, namedType: string) {
  return kind === 'SCALAR'
    || kind === 'ENUM'
    || ['String', 'ID', 'Int', 'Float', 'Boolean'].includes(namedType);
}

function parseIntrospectionSchema(source: string): { queryType: string; types: TypeMap } | null {
  try {
    const parsed = JSON.parse(stripJsonComments(source)) as unknown;
    const root = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : parsed;
    const schema = isRecord(root) && isRecord(root.__schema) ? root.__schema : root;
    if (!isRecord(schema) || !Array.isArray(schema.types)) return null;
    const queryType = isRecord(schema.queryType) ? asText(schema.queryType.name) : 'Query';
    const types: TypeMap = new Map();
    for (const rawType of schema.types) {
      if (!isRecord(rawType)) continue;
      const name = asText(rawType.name);
      if (!name) continue;
      const kind = asText(rawType.kind);
      const fields = Array.isArray(rawType.fields) ? rawType.fields.filter(isRecord).map(field => {
        const unwrapped = unwrapTypeRef(field.type as IntrospectionTypeRef | null);
        return {
          name: asText(field.name),
          description: asText(field.description),
          args: Array.isArray(field.args) ? field.args.filter(isRecord).map(arg => {
            const argType = typeRefToString(arg.type as IntrospectionTypeRef | null);
            return {
              name: asText(arg.name),
              type: argType,
              required: argType.endsWith('!'),
            };
          }).filter(arg => arg.name) : [],
          type: typeRefToString(field.type as IntrospectionTypeRef | null),
          namedType: unwrapped.namedType,
          kind: unwrapped.kind,
        };
      }).filter(field => field.name) : [];
      types.set(name, { kind, fields });
    }
    return { queryType: queryType || 'Query', types };
  } catch {
    return null;
  }
}

function parseSDLArgs(source: string): GraphQLExplorerArg[] {
  const clean = source.trim().replace(/^\(/, '').replace(/\)$/, '');
  if (!clean) return [];
  const args: GraphQLExplorerArg[] = [];
  let i = 0;

  const skipIgnored = () => {
    while (i < clean.length && /[\s,]/.test(clean[i])) i += 1;
  };
  const skipString = () => {
    const block = clean.startsWith('"""', i);
    i += block ? 3 : 1;
    while (i < clean.length) {
      if (block && clean.startsWith('"""', i)) { i += 3; return; }
      if (!block && clean[i] === '\\') { i += 2; continue; }
      if (!block && clean[i] === '"') { i += 1; return; }
      i += 1;
    }
  };
  const skipBalanced = () => {
    const open = clean[i];
    const close = open === '[' ? ']' : open === '{' ? '}' : ')';
    let depth = 0;
    while (i < clean.length) {
      if (clean[i] === '"') { skipString(); continue; }
      if (clean[i] === open) depth += 1;
      if (clean[i] === close) {
        depth -= 1;
        i += 1;
        if (depth <= 0) return;
        continue;
      }
      i += 1;
    }
  };
  const readTypeRef = (): string => {
    skipIgnored();
    if (clean[i] === '[') {
      const start = i;
      skipBalanced();
      while (/\s/.test(clean[i] ?? '')) i += 1;
      if (clean[i] === '!') i += 1;
      return clean.slice(start, i).replace(/\s+/g, '');
    }
    const typeStart = i;
    const match = clean.slice(i).match(/^[_A-Za-z][_0-9A-Za-z]*/);
    if (!match) return '';
    i += match[0].length;
    while (/\s/.test(clean[i] ?? '')) i += 1;
    if (clean[i] === '!') i += 1;
    return clean.slice(typeStart, i).replace(/\s+/g, '');
  };
  const skipDefaultOrDirective = () => {
    while (i < clean.length) {
      if (clean[i] === ',') { i += 1; return; }
      if (/\s/.test(clean[i])) {
        const nextArg = clean.slice(i).match(/^\s+[_A-Za-z][_0-9A-Za-z]*\s*:/);
        if (nextArg) return;
        i += 1;
        continue;
      }
      if (clean[i] === '"') { skipString(); continue; }
      if (clean[i] === '[' || clean[i] === '{' || clean[i] === '(') { skipBalanced(); continue; }
      i += 1;
    }
  };

  while (i < clean.length) {
    skipIgnored();
    const nameMatch = clean.slice(i).match(/^([_A-Za-z][_0-9A-Za-z]*)\s*:/);
    if (!nameMatch) { i += 1; continue; }
    const name = nameMatch[1];
    i += nameMatch[0].length;
    const type = readTypeRef();
    if (type) args.push({ name, type, required: type.endsWith('!') });
    skipDefaultOrDirective();
  }

  return args;
}

function matchingBraceIndex(source: string, start: number): number {
  let depth = 1;
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"') quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return index;
  }
  return source.length;
}

function parseSDLSchema(source: string): { queryType: string; types: TypeMap } | null {
  const clean = stripDescriptionBlocks(source)
    .replace(/#[^\n]*/g, '')
    .replace(/\r\n?/g, '\n');
  if (!/\btype\s+Query\b/.test(clean) && !/\bschema\s*\{/.test(clean)) return null;
  const schemaMatch = clean.match(/\bschema\s*\{([\s\S]*?)\}/);
  const queryType = schemaMatch?.[1].match(/\bquery\s*:\s*([_A-Za-z][_0-9A-Za-z]*)/)?.[1] ?? 'Query';
  const types: TypeMap = new Map();
  const scalarTypes = new Set(['String', 'ID', 'Int', 'Float', 'Boolean']);
  for (const scalar of clean.matchAll(/\bscalar\s+([_A-Za-z][_0-9A-Za-z]*)/g)) scalarTypes.add(scalar[1]);
  const enumTypes = new Set<string>();
  for (const enumMatch of clean.matchAll(/\benum\s+([_A-Za-z][_0-9A-Za-z]*)\s*\{/g)) enumTypes.add(enumMatch[1]);
  const typeRe = /\b(type|interface)\s+([_A-Za-z][_0-9A-Za-z]*)[^{]*\{/g;
  let match: RegExpExecArray | null;
  while ((match = typeRe.exec(clean))) {
    const kind = match[1] === 'interface' ? 'INTERFACE' : 'OBJECT';
    const name = match[2];
    const bodyStart = typeRe.lastIndex;
    const bodyEnd = matchingBraceIndex(clean, bodyStart);
    const body = clean.slice(bodyStart, bodyEnd);
    typeRe.lastIndex = bodyEnd + 1;
    const fields: TypeField[] = [];
    const fieldRe = /(?:^|\n)\s*([_A-Za-z][_0-9A-Za-z]*)\s*(\([^)]*\))?\s*:\s*([^@\n]+)/g;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldRe.exec(body))) {
      const type = fieldMatch[3].trim();
      fields.push({
        name: fieldMatch[1],
        description: '',
        args: parseSDLArgs(fieldMatch[2] ?? ''),
        type,
        namedType: typeNameFromSDL(type),
        kind: enumTypes.has(typeNameFromSDL(type)) ? 'ENUM' : scalarTypes.has(typeNameFromSDL(type)) ? 'SCALAR' : 'OBJECT',
      });
    }
    types.set(name, { kind, fields });
  }
  return types.size ? { queryType, types } : null;
}

function schemaModel(source: string) {
  const clean = source.trim();
  if (!clean) return null;
  return parseIntrospectionSchema(clean) ?? parseSDLSchema(clean);
}

export function graphQLExplorerFields(source: string): GraphQLExplorerField[] {
  const model = schemaModel(source);
  if (!model) return [];
  const query = model.types.get(model.queryType);
  if (!query) return [];
  return query.fields
    .filter(field => !field.name.startsWith('__'))
    .map(field => ({ parentType: model.queryType, ...field }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function scalarSelectionForType(types: TypeMap, typeName: string, depth = 0): string[] {
  if (depth > 1) return ['__typename'];
  const type = types.get(typeName);
  if (!type) return [];
  const scalars = type.fields
    .filter(field => !field.name.startsWith('__') && !field.args.some(arg => arg.required) && isLeafKind(field.kind, field.namedType))
    .slice(0, 8)
    .map(field => field.name);
  if (scalars.length) return scalars;
  const nested = type.fields.find(field => !field.name.startsWith('__') && !field.args.some(arg => arg.required));
  if (!nested) return ['__typename'];
  if (isLeafKind(nested.kind, nested.namedType)) return [nested.name];
  return [`${nested.name} {\n${scalarSelectionForType(types, nested.namedType, depth + 1).map(line => `    ${line}`).join('\n')}\n  }`];
}

function operationNameForField(fieldName: string) {
  const clean = fieldName.replace(/[^_0-9A-Za-z]/g, ' ').trim();
  const name = clean.split(/\s+/).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  return /^[A-Za-z_]/.test(name) ? name : `Query${name}`;
}

function defaultValueForType(type: string): unknown {
  const named = typeNameFromSDL(type);
  if (/^\[/.test(type)) return [];
  if (named === 'Int' || named === 'Float') return 0;
  if (named === 'Boolean') return false;
  if (named === 'ID' || named === 'String') return '';
  return {};
}

export function buildGraphQLExplorerOperation(source: string, fieldName: string): GraphQLPayload | null {
  const model = schemaModel(source);
  if (!model) return null;
  const field = model.types.get(model.queryType)?.fields.find(item => item.name === fieldName);
  if (!field) return null;
  const args = field.args.filter(arg => arg.required);
  const variableDefs = args.length ? `(${args.map(arg => `$${arg.name}: ${arg.type}`).join(', ')})` : '';
  const argList = args.length ? `(${args.map(arg => `${arg.name}: $${arg.name}`).join(', ')})` : '';
  const selection = isLeafKind(field.kind, field.namedType)
    ? ''
    : ` {\n${scalarSelectionForType(model.types, field.namedType).map(line => `    ${line}`).join('\n')}\n  }`;
  const variables = Object.fromEntries(args.map(arg => [arg.name, defaultValueForType(arg.type)]));
  return {
    query: `query ${operationNameForField(field.name)}${variableDefs} {\n  ${field.name}${argList}${selection}\n}`,
    variables: JSON.stringify(variables, null, 2),
    operationName: '',
  };
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
  const model = schemaModel(clean);
  if (!model) return 'Response does not contain a GraphQL schema';
  const query = model.types.get(model.queryType);
  if (!query) return `GraphQL schema query type "${model.queryType}" was not found`;
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
