import type { AuthState, BodyType, KVRow, Method, RawBodyType, RequestExample, SavedRequest } from './types/models';
import { DEFAULT_REQUEST_SETTINGS, mkRow } from './constants';
import { asArray, asText, isRecord, newRequestId } from './utils';
import { emptyAuthState } from './utils';
import { parseYaml } from './yaml';
import { safeExportRow, safeExportUrl, safeExportValue, sanitizeExportExample } from './secretExport';
import { filesystemNameFromName } from './normalizers';
import { normalizeRequestExample } from './examples';
import { applyPathParams, pathParamsFromUrl } from './pathParams';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
const JSON_TYPES = ['application/json', 'application/*+json'];
const BODY_TYPE_PRIORITY = [
  ...JSON_TYPES,
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
  'application/xml',
  'text/xml',
  'text/html',
];

type BodyImport = {
  bodyType: BodyType;
  rawBodyType: RawBodyType;
  bodyContent: string;
  formRows: KVRow[];
};

export type OpenApiExportFormat = 'openapi3' | 'swagger2';

type ExportUrlParts = {
  serverUrl: string;
  path: string;
  queryRows: KVRow[];
};

type RequestBodyExport = {
  mediaType: string;
  schema: Record<string, unknown>;
  example?: unknown;
  formRows?: KVRow[];
  isMultipart?: boolean;
};

type SecurityExport = {
  name: string;
  openapi: Record<string, unknown>;
  swagger: Record<string, unknown>;
  requirement: Record<string, string[]>;
  extension?: Record<string, unknown>;
};

function row(key: string, value: string, description = '', enabled = true): KVRow {
  return { ...mkRow(), key, value, description, enabled };
}

function resolveLocalRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  return ref.slice(2).split('/').reduce((current: unknown, part) => {
    if (!isRecord(current)) return undefined;
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    return current[key];
  }, root);
}

function deref(root: unknown, value: unknown, seen = new Set<string>()): unknown {
  if (!isRecord(value) || typeof value.$ref !== 'string') return value;
  if (seen.has(value.$ref)) return value;
  seen.add(value.$ref);
  return deref(root, resolveLocalRef(root, value.$ref) ?? value, seen);
}

function pickValue(...values: unknown[]) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function firstExample(examples: unknown): unknown {
  if (!isRecord(examples)) return undefined;
  const first = Object.values(examples)[0];
  const resolved = isRecord(first) && 'value' in first ? first.value : first;
  return resolved;
}

function schemaExample(schemaValue: unknown, root: unknown, depth = 0): unknown {
  if (depth > 8) return {};
  const schema = deref(root, schemaValue);
  if (!isRecord(schema)) return {};

  const explicit = pickValue(schema.example, schema.default);
  if (explicit !== undefined) return explicit;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];

  if (Array.isArray(schema.allOf)) {
    return schema.allOf.reduce((acc: unknown, child) => {
      const value = schemaExample(child, root, depth + 1);
      return isRecord(acc) && isRecord(value) ? { ...acc, ...value } : value;
    }, {});
  }
  const composite = asArray(schema.oneOf)[0] ?? asArray(schema.anyOf)[0];
  if (composite) return schemaExample(composite, root, depth + 1);

  const type = asText(schema.type) || (isRecord(schema.properties) ? 'object' : Array.isArray(schema.items) || schema.items ? 'array' : 'string');
  if (type === 'object') {
    const out: Record<string, unknown> = {};
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, property] of Object.entries(properties)) {
      out[key] = schemaExample(property, root, depth + 1);
    }
    if (!Object.keys(out).length && schema.additionalProperties) {
      out.key = schemaExample(schema.additionalProperties, root, depth + 1);
    }
    return out;
  }
  if (type === 'array') return [schemaExample(schema.items, root, depth + 1)];
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return true;
  const format = asText(schema.format);
  if (format === 'date-time') return '2026-05-03T00:00:00Z';
  if (format === 'date') return '2026-05-03';
  if (format === 'email') return 'user@example.com';
  if (format === 'uuid') return '00000000-0000-4000-8000-000000000000';
  return 'string';
}

function stringifyJson(value: unknown) {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value, null, 2);
    }
  }
  return JSON.stringify(value, null, 2);
}

function xmlFromValue(name: string, value: unknown): string {
  if (Array.isArray(value)) return value.map(item => xmlFromValue(name, item)).join('\n');
  if (isRecord(value)) {
    const inner = Object.entries(value).map(([key, child]) => xmlFromValue(key, child)).join('');
    return `<${name}>${inner}</${name}>`;
  }
  return `<${name}>${asText(value)}</${name}>`;
}

function formRowsFromSchema(schema: unknown, root: unknown, example: unknown): KVRow[] {
  if (isRecord(example)) {
    return Object.entries(example).map(([key, value]) => row(key, asText(value)));
  }
  const resolved = deref(root, schema);
  const properties = isRecord(resolved) && isRecord(resolved.properties) ? resolved.properties : {};
  return Object.entries(properties).map(([key, value]) => row(key, asText(schemaExample(value, root))));
}

function mediaTypeMatches(key: string, type: string) {
  const base = key.split(';')[0].trim().toLowerCase();
  if (type === 'application/*+json') return /^application\/(?:[^/]+\+json|\*\+json)$/.test(base);
  return base === type;
}

function pickMediaType(content: Record<string, unknown>) {
  const keys = Object.keys(content);
  for (const type of BODY_TYPE_PRIORITY) {
    const key = keys.find(candidate => mediaTypeMatches(candidate, type));
    if (key) return key;
  }
  return keys[0] ?? '';
}

function openApiBody(operation: Record<string, unknown>, root: unknown): BodyImport {
  const empty = { bodyType: 'none' as BodyType, rawBodyType: 'json' as RawBodyType, bodyContent: '', formRows: [] as KVRow[] };
  const requestBody = deref(root, operation.requestBody);
  if (!isRecord(requestBody)) return empty;
  const content = isRecord(requestBody.content) ? requestBody.content : {};
  const mediaType = pickMediaType(content);
  const media = deref(root, content[mediaType]);
  if (!isRecord(media)) return empty;

  const example = pickValue(media.example, firstExample(media.examples), schemaExample(media.schema, root));
  const lowerMedia = mediaType.toLowerCase();
  if (lowerMedia.includes('application/x-www-form-urlencoded')) {
    return { ...empty, bodyType: 'urlencoded', formRows: formRowsFromSchema(media.schema, root, example) };
  }
  if (lowerMedia.includes('multipart/form-data')) {
    return { ...empty, bodyType: 'form', formRows: formRowsFromSchema(media.schema, root, example) };
  }
  if (lowerMedia.includes('xml')) {
    const value = example ?? schemaExample(media.schema, root);
    return { ...empty, bodyType: 'xml', rawBodyType: 'xml', bodyContent: typeof value === 'string' ? value : xmlFromValue('root', value) };
  }
  if (lowerMedia.includes('text/html')) {
    return { ...empty, bodyType: 'html', rawBodyType: 'html', bodyContent: asText(example) };
  }
  if (lowerMedia.includes('text/plain')) {
    return { ...empty, bodyType: 'text', rawBodyType: 'text', bodyContent: asText(example) };
  }
  return { ...empty, bodyType: 'json', rawBodyType: 'json', bodyContent: stringifyJson(example) };
}

function openApiExamplesFromResponses(
  operation: Record<string, unknown>,
  root: unknown,
  requestId: string,
  snapshot: { method: Method; url: string; params: KVRow[]; headers: KVRow[]; bodyType: BodyType; bodyContent: string },
): RequestExample[] {
  const responses = isRecord(operation.responses) ? operation.responses : {};
  const examples: RequestExample[] = [];

  for (const [code, responseValue] of Object.entries(responses)) {
    const response = deref(root, responseValue);
    if (!isRecord(response)) continue;
    const statusCode = /^[1-5]xx$/i.test(code) ? Number(code[0]) * 100 : Number(code);
    if (!Number.isFinite(statusCode) || statusCode <= 0) continue;

    const payload = openApiResponsePayload(response, root);
    const description = asText(response.description);
    examples.push(normalizeRequestExample({
      name: description ? `${code} ${description}` : code,
      source: 'openapi',
      snapshot,
      response: {
        statusCode,
        status: code,
        headers: openApiResponseHeaders(response, root, payload.mediaType),
        body: payload.body,
        bodyMediaType: payload.mediaType,
      },
    }, requestId));
  }
  return examples;
}

function openApiResponsePayload(response: Record<string, unknown>, root: unknown): { body: string; mediaType: string } {
  const content = isRecord(response.content) ? response.content : null;
  if (content) {
    const mediaType = pickMediaType(content);
    const media = deref(root, content[mediaType]);
    if (!isRecord(media)) return { body: '', mediaType: mediaType.toLowerCase() };
    const value = pickValue(media.example, firstExample(media.examples), schemaExample(media.schema, root));
    return { body: openApiExampleToText(value, mediaType), mediaType: mediaType.toLowerCase() };
  }

  const swaggerExamples = isRecord(response.examples) ? response.examples : null;
  if (swaggerExamples) {
    const mediaType = pickMediaType(swaggerExamples);
    return { body: openApiExampleToText(swaggerExamples[mediaType], mediaType), mediaType: mediaType.toLowerCase() };
  }
  if (response.schema !== undefined) {
    return { body: stringifyJson(schemaExample(response.schema, root)), mediaType: 'application/json' };
  }
  return { body: '', mediaType: '' };
}

function openApiExampleToText(value: unknown, mediaType: string): string {
  if (value === undefined || value === null) return '';
  const lower = mediaType.toLowerCase();
  if (typeof value === 'string') return value;
  if (lower.includes('xml')) return xmlFromValue('root', value);
  return stringifyJson(value);
}

function openApiResponseHeaders(response: Record<string, unknown>, root: unknown, mediaType: string): KVRow[] {
  const declared = isRecord(response.headers) ? response.headers : {};
  const rows = Object.entries(declared).map(([name, headerValue]) => {
    const header = deref(root, headerValue);
    const value = isRecord(header)
      ? pickValue(header.example, firstExample(header.examples), schemaExample(header.schema ?? header, root))
      : undefined;
    return row(name, asText(value), isRecord(header) ? asText(header.description) : '');
  });
  if (mediaType && !rows.some(item => item.key.toLowerCase() === 'content-type')) {
    rows.unshift(row('Content-Type', mediaType));
  }
  return rows;
}

function swaggerBody(parameters: unknown[], consumes: string[], root: unknown): BodyImport {
  const empty = { bodyType: 'none' as BodyType, rawBodyType: 'json' as RawBodyType, bodyContent: '', formRows: [] as KVRow[] };
  const bodyParam = parameters.find(param => isRecord(param) && param.in === 'body');
  const formParams = parameters.filter(param => isRecord(param) && param.in === 'formData') as Record<string, unknown>[];
  if (formParams.length) {
    const rows = formParams.map(param => row(asText(param.name), asText(pickValue(param.example, param.default, schemaExample(param.schema ?? param, root))), asText(param.description)));
    return { ...empty, bodyType: consumes.some(type => type.toLowerCase().includes('multipart/form-data')) ? 'form' : 'urlencoded', formRows: rows };
  }
  if (!isRecord(bodyParam)) return empty;
  const example = pickValue(bodyParam.example, schemaExample(bodyParam.schema, root));
  if (consumes.some(type => type.toLowerCase().includes('xml'))) {
    return { ...empty, bodyType: 'xml', rawBodyType: 'xml', bodyContent: typeof example === 'string' ? example : xmlFromValue('root', example) };
  }
  return { ...empty, bodyType: 'json', rawBodyType: 'json', bodyContent: stringifyJson(example) };
}

function resolveServerUrl(server: Record<string, unknown>) {
  const variables = isRecord(server.variables) ? server.variables : {};
  return asText(server.url).replace(/\{([^}]+)\}/g, (_, key) => {
    const variable = variables[key];
    const fallback = `{{${key}}}`;
    if (isRecord(variable)) return asText(variable.default || asArray(variable.enum)[0] || fallback);
    return fallback;
  });
}

function operationServerUrl(item: Record<string, unknown>): string {
  return asArray(item.servers).filter(isRecord).map(resolveServerUrl).find(Boolean) ?? '';
}

function serverUrls(spec: Record<string, unknown>): string[] {
  if (Array.isArray(spec.servers)) {
    const urls = spec.servers.filter(isRecord).map(resolveServerUrl).filter(Boolean);
    if (urls.length) return urls;
  }
  const schemes = asArray(spec.schemes).map(asText);
  const scheme = schemes[0] || 'https';
  const host = asText(spec.host);
  const basePath = asText(spec.basePath);
  const single = host ? `${scheme}://${host}${basePath}` : basePath;
  return single ? [single] : [];
}


function joinUrl(base: string, path: string) {
  const templatedPath = path
    .split('/')
    .map(segment => {
      const whole = segment.match(/^\{([^{}]+)\}$/);
      return whole ? `:${whole[1]}` : segment.replace(/\{([^}]+)\}/g, '{{$1}}');
    })
    .join('/');
  if (!base) return templatedPath;
  return `${base.replace(/\/+$/, '')}/${templatedPath.replace(/^\/+/, '')}`;
}

function parametersFor(pathItem: Record<string, unknown>, operation: Record<string, unknown>, root: unknown) {
  const resolved = [...asArray(pathItem.parameters), ...asArray(operation.parameters)]
    .map(param => deref(root, param))
    .filter(isRecord);
  const byIdentity = new Map<string, Record<string, unknown>>();
  for (const param of resolved) byIdentity.set(`${asText(param.in).toLowerCase()}\u0000${asText(param.name)}`, param);
  return [...byIdentity.values()];
}

function parameterRows(parameters: Record<string, unknown>[], location: string, root: unknown) {
  return parameters
    .filter(param => asText(param.in) === location && param.name)
    .map(param => row(
      asText(param.name),
      asText(pickValue(param.example, param.default, schemaExample(param.schema ?? param, root))),
      asText(param.description),
      param.required !== false,
    ));
}

export function parseOpenApiDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return parseYaml(text);
  }
}

export function isOpenApiDocument(value: unknown): boolean {
  return isRecord(value) && (Boolean(asText(value.openapi)) || Boolean(asText(value.swagger)));
}

function looksLikeHtml(body: string, contentType: string): boolean {
  if (/\btext\/html\b/i.test(contentType)) return true;
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(body);
}

export function parseOpenApiResponse(body: string, contentType = ''): unknown {
  if (!body.trim()) {
    throw new Error('That URL returned an empty document.');
  }
  if (looksLikeHtml(body, contentType)) {
    throw new Error(
      'That URL returns a web page, not a spec. Swagger UI serves the document itself at a separate path — usually /swagger.json, /openapi.json or /v3/api-docs.',
    );
  }
  let spec: unknown;
  try {
    spec = parseOpenApiDocument(body);
  } catch {
    throw new Error('Could not read that document as JSON or YAML.');
  }
  if (!isOpenApiDocument(spec)) {
    throw new Error('That document has no "openapi" or "swagger" version field, so it is not a spec Kurlo can import.');
  }
  return spec as Record<string, unknown>;
}

export function openApiNameFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const last = segments.at(-1) ?? '';
  const stem = last.replace(/\.(json|ya?ml)$/i, '');
  if (stem && !/^(v\d+|api-docs|openapi|swagger|spec)$/i.test(stem)) return stem;
  return parsed.hostname || stem;
}

export function openApiCollectionName(spec: unknown, fileName: string) {
  const info = isRecord(spec) && isRecord(spec.info) ? spec.info : {};
  return asText(info.title) || fileName.replace(/\.(json|ya?ml)$/i, '') || 'OpenAPI Import';
}

export const OPENAPI_BASE_URL_VARIABLE = 'baseUrl';

export type OpenApiCollectionDefaults = {
  variables: KVRow[];
  auth?: AuthState;
};

function securitySchemes(spec: Record<string, unknown>): Record<string, unknown> {
  const components = isRecord(spec.components) && isRecord(spec.components.securitySchemes)
    ? spec.components.securitySchemes
    : {};
  const swagger = isRecord(spec.securityDefinitions) ? spec.securityDefinitions : {};
  return { ...swagger, ...components };
}

function firstSecuritySchemeName(security: unknown): string | null {
  const requirements = asArray(security);
  if (!requirements.length) return null;
  const first = requirements[0];
  if (!isRecord(first)) return null;
  const [name] = Object.keys(first);
  return name ?? null;
}

function authFromSecurityScheme(scheme: unknown, variables: Map<string, KVRow>): AuthState | null {
  if (!isRecord(scheme)) return null;
  const declare = (key: string, description: string, secret = true) => {
    if (!variables.has(key)) {
      variables.set(key, { ...mkRow(), key, value: '', description, secret });
    }
    return `{{${key}}}`;
  };

  const type = asText(scheme.type).toLowerCase();
  const httpScheme = asText(scheme.scheme).toLowerCase();

  if (type === 'http' && httpScheme === 'basic') {
    return {
      ...emptyAuthState(),
      type: 'basic',
      basicUser: declare('username', 'HTTP Basic user', false),
      basicPass: declare('password', 'HTTP Basic password'),
    };
  }
  if (type === 'http' && httpScheme === 'digest') {
    return {
      ...emptyAuthState(),
      type: 'digest',
      basicUser: declare('username', 'Digest user', false),
      basicPass: declare('password', 'Digest password'),
    };
  }
  if (type === 'http' || type === 'bearer') {
    return { ...emptyAuthState(), type: 'bearer', bearerToken: declare('bearerToken', 'Bearer token') };
  }
  if (type === 'apikey') {
    const name = asText(scheme.name) || 'X-API-Key';
    const location = asText(scheme.in).toLowerCase();
    if (location === 'cookie') {
      return {
        ...emptyAuthState(),
        type: 'apikey',
        apiKeyName: 'Cookie',
        apiKeyIn: 'header',
        apiKeyValue: `${name}=${declare('apiKey', `Value for the ${name} API key cookie`)}`,
      };
    }
    return {
      ...emptyAuthState(),
      type: 'apikey',
      apiKeyName: name,
      apiKeyIn: location === 'query' ? 'query' : 'header',
      apiKeyValue: declare('apiKey', `Value for the ${name} API key`),
    };
  }
  if (type === 'oauth2') {
    const flows = isRecord(scheme.flows) ? scheme.flows : {};
    const flow = ['clientCredentials', 'authorizationCode', 'password', 'implicit']
      .map(name => (isRecord(flows[name]) ? { name, value: flows[name] as Record<string, unknown> } : null))
      .find(Boolean);
    const tokenURL = asText(flow?.value.tokenUrl) || asText(scheme.tokenUrl);
    const authURL = asText(flow?.value.authorizationUrl) || asText(scheme.authorizationUrl);
    const scopes = Object.keys(
      isRecord(flow?.value.scopes) ? flow!.value.scopes as Record<string, unknown>
        : isRecord(scheme.scopes) ? scheme.scopes as Record<string, unknown> : {},
    ).join(' ');
    const grant = flow?.name === 'authorizationCode' || asText(scheme.flow) === 'accessCode'
      ? 'authorization_code'
      : flow?.name === 'password' || asText(scheme.flow) === 'password' ? 'password' : 'client_credentials';
    return {
      ...emptyAuthState(),
      type: 'oauth2',
      oauth2GrantType: grant as AuthState['oauth2GrantType'],
      oauth2TokenURL: tokenURL,
      oauth2AuthURL: authURL,
      oauth2Scope: scopes,
      oauth2ClientID: declare('oauth2ClientId', 'OAuth 2.0 client id', false),
      oauth2Secret: declare('oauth2ClientSecret', 'OAuth 2.0 client secret'),
    };
  }
  return null;
}

export type OpenApiImport = {
  requests: SavedRequest[];
  defaults: OpenApiCollectionDefaults;
};

export function openApiImportFromSpec(specValue: unknown, collectionId: string, collectionName: string): OpenApiImport {
  const spec = isRecord(specValue) ? specValue : {};
  const paths = isRecord(spec.paths) ? spec.paths : {};
  if (!Object.keys(paths).length) throw new Error('Expected an OpenAPI/Swagger document with paths');

  const servers = serverUrls(spec);
  const globalConsumes = asArray(spec.consumes).map(asText);
  const schemes = securitySchemes(spec);
  const requests: SavedRequest[] = [];
  const variables = new Map<string, KVRow>();

  if (servers.length) {
    const alternatives = servers.slice(1);
    variables.set(OPENAPI_BASE_URL_VARIABLE, {
      ...mkRow(),
      key: OPENAPI_BASE_URL_VARIABLE,
      value: servers[0],
      description: alternatives.length ? `Also declared: ${alternatives.join(', ')}` : 'Server declared by the spec',
    });
  }

  const collectionSchemeName = firstSecuritySchemeName(spec.security);
  const collectionAuth = collectionSchemeName
    ? authFromSecurityScheme(deref(spec, schemes[collectionSchemeName]), variables)
    : null;

  for (const [path, pathValue] of Object.entries(paths)) {
    const pathItem = deref(spec, pathValue);
    if (!isRecord(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = deref(spec, pathItem[method]);
      if (!isRecord(operation)) continue;
      const parameters = parametersFor(pathItem, operation, spec);
      const params = parameterRows(parameters, 'query', spec);
      const headers = parameterRows(parameters, 'header', spec);
      const pathRows = parameterRows(parameters, 'path', spec);
      const consumes = [...asArray(operation.consumes).map(asText), ...globalConsumes];
      const body = spec.swagger
        ? swaggerBody(parameters, consumes, spec)
        : openApiBody(operation, spec);
      const tags = asArray(operation.tags).map(asText).filter(Boolean);
      const name = asText(operation.summary) || asText(operation.operationId) || `${method.toUpperCase()} ${path}`;
      const methodUpper = method.toUpperCase() as Method;
      const id = newRequestId();
      const ownServer = operationServerUrl(operation) || operationServerUrl(pathItem);
      const url = joinUrl(ownServer || (servers.length ? `{{${OPENAPI_BASE_URL_VARIABLE}}}` : ''), path);
      const pathParams = pathParamsFromUrl(url, pathRows.map(r => ({ ...r, enabled: true })));
      const pathNames = new Set(pathParams.map(r => r.key));
      for (const pathParam of pathRows) {
        if (!pathNames.has(pathParam.key) && !variables.has(pathParam.key)) {
          variables.set(pathParam.key, { ...pathParam, enabled: true });
        }
      }
      const examples = openApiExamplesFromResponses(operation, spec, id, {
        method: methodUpper, url: applyPathParams(url, pathParams), params, headers, bodyType: body.bodyType, bodyContent: body.bodyContent,
      });
      requests.push({
        id,
        name,
        filesystemName: filesystemNameFromName(name, id),
        collectionId,
        collection: collectionName,
        folderPath: tags.length ? [tags[0]] : [],
        method: methodUpper,
        url,
        requestTab: body.bodyType !== 'none' ? 'body' : params.length ? 'params' : headers.length ? 'headers' : 'docs',
        params,
        ...(pathParams.length ? { pathParams } : {}),
        headers,
        auth: operationAuth(operation, spec, schemes, variables, Boolean(collectionAuth)),
        bodyType: body.bodyType,
        rawBodyType: body.rawBodyType,
        bodyContent: body.bodyContent,
        bodyFilePath: '',
        bodyFileName: '',
        formRows: body.formRows,
        preRequestScript: '',
        testScript: '',
        requestNotes: asText(operation.description),
        settings: { ...DEFAULT_REQUEST_SETTINGS },
        ...(examples.length ? { examples } : {}),
      });
    }
  }

  return {
    requests,
    defaults: {
      variables: [...variables.values()],
      ...(collectionAuth ? { auth: collectionAuth } : {}),
    },
  };
}

function operationAuth(
  operation: Record<string, unknown>,
  spec: Record<string, unknown>,
  schemes: Record<string, unknown>,
  variables: Map<string, KVRow>,
  hasCollectionAuth: boolean,
): AuthState {
  if (!('security' in operation)) {
    return hasCollectionAuth ? { ...emptyAuthState(), type: 'inherit' } : emptyAuthState();
  }
  const name = firstSecuritySchemeName(operation.security);
  if (!name) return emptyAuthState();
  const auth = authFromSecurityScheme(deref(spec, schemes[name]), variables);
  if (!auth) return hasCollectionAuth ? { ...emptyAuthState(), type: 'inherit' } : emptyAuthState();
  return auth;
}

export function openApiRequestsFromSpec(specValue: unknown, collectionId: string, collectionName: string): SavedRequest[] {
  return openApiImportFromSpec(specValue, collectionId, collectionName).requests;
}


function enabledRows(rows: KVRow[]): KVRow[] {
  return rows.filter(row => row.enabled && row.key.trim());
}

function bodyMethod(method: Method): Exclude<Method, 'SSE'> {
  return method === 'SSE' ? 'GET' : method;
}

function openApiParamName(value: string) {
  const clean = value.trim().replace(/^\{+|\}+$/g, '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  return clean || 'param';
}

function kurloTemplatesToOpenApi(value: string) {
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, name: string) => `{${openApiParamName(name)}}`);
}

function colonParamsToOpenApiPath(value: string) {
  return value.replace(/(^|\/):([A-Za-z_][A-Za-z0-9_-]*)/g, (_, prefix: string, name: string) => `${prefix}{${openApiParamName(name)}}`);
}

function normalizeOpenApiPath(value: string) {
  const clean = value.trim() || '/';
  const [pathOnly] = clean.split('?');
  const decoded = pathOnly.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  const path = colonParamsToOpenApiPath(kurloTemplatesToOpenApi(decoded));
  return path.startsWith('/') ? path : `/${path}`;
}

function searchRows(search: string): KVRow[] {
  const clean = search.startsWith('?') ? search.slice(1) : search;
  if (!clean) return [];
  try {
    return Array.from(new URLSearchParams(clean).entries())
      .filter(([key]) => key)
      .map(([key, value]) => row(key, value));
  } catch {
    return [];
  }
}

function splitPathAndQuery(value: string) {
  const queryIndex = value.indexOf('?');
  if (queryIndex < 0) return { path: value || '/', search: '' };
  return { path: value.slice(0, queryIndex) || '/', search: value.slice(queryIndex + 1) };
}

function normalizeExportUrl(rawUrl: string): ExportUrlParts {
  const source = (rawUrl.trim() || '/').split('#')[0];
  const leadingVariable = source.match(/^\{\{\s*([^}]+?)\s*\}\}(.*)$/);
  if (leadingVariable) {
    const serverUrl = `{${openApiParamName(leadingVariable[1])}}`;
    const { path, search } = splitPathAndQuery(leadingVariable[2] || '/');
    return { serverUrl, path: normalizeOpenApiPath(path), queryRows: searchRows(search) };
  }

  const absolute = source.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)(.*)$/i);
  if (absolute) {
    const serverUrl = kurloTemplatesToOpenApi(absolute[1]);
    const { path, search } = splitPathAndQuery(absolute[2] || '/');
    return { serverUrl, path: normalizeOpenApiPath(path), queryRows: searchRows(search) };
  }

  const protocolRelative = source.match(/^\/\/([^/?#]+)(.*)$/);
  if (protocolRelative) {
    const serverUrl = kurloTemplatesToOpenApi(`https://${protocolRelative[1]}`);
    const { path, search } = splitPathAndQuery(protocolRelative[2] || '/');
    return { serverUrl, path: normalizeOpenApiPath(path), queryRows: searchRows(search) };
  }

  const hostLike = source.match(/^((?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:.]+\]|[^/\s?.]+\.[^/\s?]+)(?::\d+)?)(.*)$/i);
  if (hostLike) {
    const serverUrl = kurloTemplatesToOpenApi(`http://${hostLike[1]}`);
    const { path, search } = splitPathAndQuery(hostLike[2] || '/');
    return { serverUrl, path: normalizeOpenApiPath(path), queryRows: searchRows(search) };
  }

  const { path, search } = splitPathAndQuery(source);
  return { serverUrl: '/', path: normalizeOpenApiPath(path), queryRows: searchRows(search) };
}

function isRealtimeExportRequest(req: SavedRequest): boolean {
  return req.requestType === 'ws' || req.requestType === 'socketio' || /^wss?:\/\//i.test(req.url);
}

function isGraphQLExportRequest(req: SavedRequest): boolean {
  return req.requestType === 'graphql' || req.bodyType === 'graphql';
}

function isNonHttpExportRequest(req: SavedRequest): boolean {
  return req.requestType === 'grpc' || req.requestType === 'mcp' || req.requestType === 'ai';
}

function isOpenApiExportableRequest(req: SavedRequest): boolean {
  return !isRealtimeExportRequest(req) && !isGraphQLExportRequest(req) && !isNonHttpExportRequest(req);
}

function httpExportRequests(requests: SavedRequest[]): SavedRequest[] {
  return requests.filter(isOpenApiExportableRequest);
}

function activeQueryRows(req: SavedRequest, urlRows: KVRow[]): KVRow[] {
  const out: KVRow[] = [];
  const seen = new Set<string>();
  for (const row of [...enabledRows(req.params), ...urlRows]) {
    const key = row.key.trim();
    const normalized = key.toLowerCase();
    if (!key || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(row);
  }
  return out;
}

function pathParameterNames(path: string): string[] {
  return Array.from(path.matchAll(/\{([^}]+)\}/g)).map(match => openApiParamName(match[1]));
}

function scalarSchemaFromValue(value: string): Record<string, unknown> {
  const clean = value.trim();
  if (/^(true|false)$/i.test(clean)) return { type: 'boolean' };
  if (/^-?\d+$/.test(clean)) return { type: 'integer' };
  if (/^-?\d+\.\d+$/.test(clean)) return { type: 'number' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return { type: 'string', format: 'date' };
  if (/^\d{4}-\d{2}-\d{2}T/.test(clean)) return { type: 'string', format: 'date-time' };
  return { type: 'string' };
}

function inferSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 6) return { type: 'object' };
  if (value === null) return { type: 'string', nullable: true };
  if (Array.isArray(value)) {
    return { type: 'array', items: value.length ? inferSchema(value[0], depth + 1) : { type: 'string' } };
  }
  if (isRecord(value)) {
    const properties: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) properties[key] = inferSchema(child, depth + 1);
    return { type: 'object', properties };
  }
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  return scalarSchemaFromValue(asText(value));
}

function parseJsonBody(source: string, includeSecrets = false): { schema: Record<string, unknown>; example?: unknown } {
  const text = source.trim();
  if (!text) return { schema: { type: 'object' } };
  try {
    const parsed = JSON.parse(text) as unknown;
    return { schema: inferSchema(parsed), example: sanitizeExportExample(parsed, includeSecrets) };
  } catch {
    if (text.startsWith('[')) return { schema: { type: 'array', items: { type: 'object' } } };
    if (text.startsWith('{')) return { schema: { type: 'object' } };
    return { schema: { type: 'string' }, example: text };
  }
}

function headerValue(req: SavedRequest, name: string) {
  const row = enabledRows(req.headers).find(row => row.key.trim().toLowerCase() === name.toLowerCase());
  return row?.value.trim() ?? '';
}

function bodyMediaType(req: SavedRequest) {
  const contentType = headerValue(req, 'Content-Type').split(';')[0].trim();
  if (contentType) return contentType;
  switch (req.bodyType) {
    case 'json': return 'application/json';
    case 'graphql': return 'application/json';
    case 'text': return 'text/plain';
    case 'xml': return 'application/xml';
    case 'html': return 'text/html';
    case 'urlencoded': return 'application/x-www-form-urlencoded';
    case 'form': return 'multipart/form-data';
    case 'binary': return 'application/octet-stream';
    default: return '';
  }
}

function requestBodyExport(req: SavedRequest, stripFn: (s: string, t: string) => string, includeSecrets = false): RequestBodyExport | null {
  const mediaType = bodyMediaType(req);
  if (!mediaType) return null;

  if (req.bodyType === 'json' || req.bodyType === 'graphql') {
    const parsed = parseJsonBody(stripFn(req.bodyContent, req.bodyType), includeSecrets);
    return { mediaType, ...parsed };
  }

  if (req.bodyType === 'urlencoded' || req.bodyType === 'form') {
    const properties: Record<string, unknown> = {};
    for (const row of enabledRows(req.formRows)) {
      properties[row.key] = row.isFile ? { type: 'string', format: 'binary' } : scalarSchemaFromValue(row.value);
    }
    const formRows = enabledRows(req.formRows).map(row => safeExportRow(row, includeSecrets));
    return {
      mediaType,
      schema: { type: 'object', properties },
      formRows,
      isMultipart: req.bodyType === 'form',
    };
  }

  if (req.bodyType === 'binary') {
    return { mediaType, schema: { type: 'string', format: 'binary' } };
  }

  if (['text', 'xml', 'html'].includes(req.bodyType)) {
    const value = stripFn(req.bodyContent, req.bodyType);
    const safeValue = sanitizeExportExample(value, includeSecrets);
    return { mediaType, schema: { type: 'string' }, ...(safeValue ? { example: safeValue } : {}) };
  }

  return null;
}

function openApiParameter(row: KVRow, location: 'query' | 'header', required = false, includeSecrets = false) {
  const safeValue = safeExportValue(row.key, row.value, includeSecrets, row.secret === true);
  const parameter: Record<string, unknown> = {
    name: row.key,
    in: location,
    required,
    schema: scalarSchemaFromValue(row.value),
  };
  if (row.description) parameter.description = row.description;
  if (row.value && safeValue) parameter.example = safeValue;
  return parameter;
}

function pathRowFor(req: SavedRequest, name: string): KVRow | undefined {
  return (req.pathParams ?? []).find(row => row.key && openApiParamName(row.key) === name);
}

function openApiPathParameter(req: SavedRequest, name: string, includeSecrets = false) {
  const parameter: Record<string, unknown> = { name, in: 'path', required: true, schema: { type: 'string' } };
  const source = pathRowFor(req, name);
  const safeValue = source ? safeExportValue(source.key, source.value, includeSecrets, source.secret === true) : '';
  if (source?.description) parameter.description = source.description;
  if (source?.value && safeValue) parameter.example = safeValue;
  return parameter;
}

function swaggerParameter(row: KVRow, location: 'query' | 'header', required = false, includeSecrets = false) {
  const safeValue = safeExportValue(row.key, row.value, includeSecrets, row.secret === true);
  const schema = scalarSchemaFromValue(row.value);
  const parameter: Record<string, unknown> = {
    name: row.key,
    in: location,
    required,
    type: asText(schema.type) || 'string',
  };
  if (schema.format) parameter.format = schema.format;
  if (row.description) parameter.description = row.description;
  if (row.value && safeValue) parameter.default = safeValue;
  return parameter;
}

function swaggerPathParameter(req: SavedRequest, name: string, includeSecrets = false) {
  const parameter: Record<string, unknown> = { name, in: 'path', required: true, type: 'string' };
  const source = pathRowFor(req, name);
  const safeValue = source ? safeExportValue(source.key, source.value, includeSecrets, source.secret === true) : '';
  if (source?.description) parameter.description = source.description;
  if (source?.value && safeValue) parameter.default = safeValue;
  return parameter;
}

function operationId(req: SavedRequest, path: string, used: Set<string>) {
  const base = `${bodyMethod(req.method).toLowerCase()}_${req.name || path}`
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'operation';
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}_${suffix++}`;
  used.add(candidate);
  return candidate;
}

function tagForRequest(req: SavedRequest) {
  const path = (req.folderPath ?? []).filter(Boolean);
  return path.length ? path.join(' / ') : '';
}

function securityForRequest(req: SavedRequest): SecurityExport | null {
  const auth = req.auth;
  if (auth.type === 'bearer') {
    return {
      name: 'bearerAuth',
      openapi: { type: 'http', scheme: 'bearer' },
      swagger: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'Bearer token' },
      requirement: { bearerAuth: [] },
    };
  }
  if (auth.type === 'basic') {
    return {
      name: 'basicAuth',
      openapi: { type: 'http', scheme: 'basic' },
      swagger: { type: 'basic' },
      requirement: { basicAuth: [] },
    };
  }
  if (auth.type === 'digest') {
    return {
      name: 'digestAuth',
      openapi: { type: 'http', scheme: 'digest' },
      swagger: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'HTTP Digest authorization header' },
      requirement: { digestAuth: [] },
    };
  }
  if (auth.type === 'apikey') {
    const name = auth.apiKeyName || 'X-API-Key';
    return {
      name: auth.apiKeyIn === 'query' ? 'apiKeyQuery' : 'apiKeyHeader',
      openapi: { type: 'apiKey', in: auth.apiKeyIn, name },
      swagger: { type: 'apiKey', in: auth.apiKeyIn, name },
      requirement: { [auth.apiKeyIn === 'query' ? 'apiKeyQuery' : 'apiKeyHeader']: [] },
    };
  }
  if (auth.type === 'oauth2') {
    if (auth.oauth2TokenURL) {
      return {
        name: 'oauth2',
        openapi: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: auth.oauth2TokenURL, scopes: {} } } },
        swagger: { type: 'oauth2', flow: 'application', tokenUrl: auth.oauth2TokenURL, scopes: {} },
        requirement: { oauth2: [] },
      };
    }
    return {
      name: 'bearerAuth',
      openapi: { type: 'http', scheme: 'bearer' },
      swagger: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'OAuth2 bearer token' },
      requirement: { bearerAuth: [] },
    };
  }
  if (auth.type === 'aws') {
    return {
      name: 'awsSignatureV4',
      openapi: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'AWS Signature Version 4 authorization header' },
      swagger: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'AWS Signature Version 4 authorization header' },
      requirement: { awsSignatureV4: [] },
      extension: { 'x-kurlo-auth': { type: 'aws', region: auth.awsRegion, service: auth.awsService } },
    };
  }
  return null;
}

function addOpenApiSecurityScheme(security: SecurityExport | null, openapiSchemes: Record<string, unknown>) {
  if (!security) return;
  openapiSchemes[security.name] = security.openapi;
}

function addSwaggerSecurityScheme(security: SecurityExport | null, swaggerSchemes: Record<string, unknown>) {
  if (!security) return;
  swaggerSchemes[security.name] = security.swagger;
}

function responseForRequest(req: SavedRequest) {
  if (req.method === 'SSE') {
    return {
      description: 'Server-sent events stream',
      content: {
        'text/event-stream': { schema: { type: 'string' } },
      },
    };
  }
  return { description: 'Successful response' };
}

function swaggerResponseForRequest(req: SavedRequest) {
  if (req.method === 'SSE') return { description: 'Server-sent events stream', schema: { type: 'string' } };
  return { description: 'Successful response' };
}

function serverVariables(url: string) {
  const variables: Record<string, { default: string }> = {};
  for (const name of pathParameterNames(url)) {
    const lower = name.toLowerCase();
    let fallback = 'value';
    if (lower.includes('base')) fallback = 'https://api.example.com';
    else if (lower.includes('host') || lower.includes('domain')) fallback = 'api.example.com';
    else if (lower.includes('version')) fallback = 'v1';
    variables[name] = { default: fallback };
  }
  return variables;
}

function openApiServer(url: string) {
  const variables = serverVariables(url);
  return {
    url,
    ...(Object.keys(variables).length ? { variables } : {}),
  };
}

function swaggerHostFromServer(url: string) {
  try {
    const parsed = new URL(url === '/' ? 'https://api.example.com' : url);
    return {
      schemes: [parsed.protocol.replace(':', '') || 'https'],
      host: parsed.host,
      basePath: parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '/',
    };
  } catch {
    return {
      schemes: ['https'],
      host: 'api.example.com',
      basePath: '/',
      'x-kurlo-server': url,
    };
  }
}

function mergePathItem(paths: Record<string, unknown>, path: string, method: string, operation: Record<string, unknown>, requestName: string) {
  const pathItem = isRecord(paths[path]) ? paths[path] as Record<string, unknown> : {};
  if (pathItem[method]) {
    throw new Error(`Cannot export duplicate ${method.toUpperCase()} ${path}. Rename or remove one of the duplicate requests before exporting (${requestName}).`);
  }
  pathItem[method] = operation;
  paths[path] = pathItem;
}

function openApiOperation(
  req: SavedRequest,
  path: string,
  queryRows: KVRow[],
  stripFn: (s: string, t: string) => string,
  usedOperationIds: Set<string>,
  security: SecurityExport | null,
  includeSecrets = false,
) {
  const body = requestBodyExport(req, stripFn, includeSecrets);
  const tags = tagForRequest(req);
  const parameters: Record<string, unknown>[] = [
    ...pathParameterNames(path).map(name => openApiPathParameter(req, name, includeSecrets)),
    ...queryRows.map(row => openApiParameter(row, 'query', false, includeSecrets)),
    ...enabledRows(req.headers)
      .filter(row => row.key.trim().toLowerCase() !== 'content-type')
      .map(row => openApiParameter(row, 'header', false, includeSecrets)),
  ];
  const operation: Record<string, unknown> = {
    summary: req.name || `${bodyMethod(req.method)} ${path}`,
    operationId: operationId(req, path, usedOperationIds),
    ...(tags ? { tags: [tags] } : {}),
    ...(req.requestNotes ? { description: req.requestNotes } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(body ? {
      requestBody: {
        required: true,
        content: {
          [body.mediaType]: {
            schema: body.schema,
            ...(body.example !== undefined ? { example: body.example } : {}),
          },
        },
      },
    } : {}),
    responses: {
      200: responseForRequest(req),
    },
    ...(security ? { security: [security.requirement] } : {}),
    ...(req.method === 'SSE' ? { 'x-kurlo-method': 'SSE' } : {}),
    ...(security?.extension ?? {}),
  };
  return operation;
}

function swaggerOperation(
  req: SavedRequest,
  path: string,
  queryRows: KVRow[],
  stripFn: (s: string, t: string) => string,
  usedOperationIds: Set<string>,
  security: SecurityExport | null,
  includeSecrets = false,
) {
  const body = requestBodyExport(req, stripFn, includeSecrets);
  const tags = tagForRequest(req);
  const parameters: Record<string, unknown>[] = [
    ...pathParameterNames(path).map(name => swaggerPathParameter(req, name, includeSecrets)),
    ...queryRows.map(row => swaggerParameter(row, 'query', false, includeSecrets)),
    ...enabledRows(req.headers)
      .filter(row => row.key.trim().toLowerCase() !== 'content-type')
      .map(row => swaggerParameter(row, 'header', false, includeSecrets)),
  ];

  if (body) {
    if (body.formRows?.length) {
      for (const row of body.formRows) {
        parameters.push({
          name: row.key,
          in: 'formData',
          required: false,
          type: body.isMultipart && row.isFile ? 'file' : asText(scalarSchemaFromValue(row.value).type) || 'string',
          ...(row.description ? { description: row.description } : {}),
          ...(!row.isFile && row.value ? { default: row.value } : {}),
        });
      }
    } else {
      parameters.push({
        name: 'body',
        in: 'body',
        required: true,
        schema: body.schema,
        ...(body.example !== undefined ? { 'x-example': body.example } : {}),
      });
    }
  }

  const operation: Record<string, unknown> = {
    summary: req.name || `${bodyMethod(req.method)} ${path}`,
    operationId: operationId(req, path, usedOperationIds),
    ...(tags ? { tags: [tags] } : {}),
    ...(req.requestNotes ? { description: req.requestNotes } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(body ? { consumes: [body.mediaType] } : {}),
    ...(req.method === 'SSE' ? { produces: ['text/event-stream'] } : {}),
    responses: {
      200: swaggerResponseForRequest(req),
    },
    ...(security ? { security: [security.requirement] } : {}),
    ...(req.method === 'SSE' ? { 'x-kurlo-method': 'SSE' } : {}),
    ...(security?.extension ?? {}),
  };
  return operation;
}

export function buildOpenApiDocument(
  collectionName: string,
  collectionDescription: string,
  requests: SavedRequest[],
  stripFn: (s: string, t: string) => string,
  includeSecrets = false,
): Record<string, unknown> {
  if (!requests.length) throw new Error('Collection has no saved requests to export.');
  const exportRequests = httpExportRequests(requests);
  if (!exportRequests.length) throw new Error('OpenAPI export only supports HTTP and SSE requests. GraphQL, gRPC, MCP, AI and realtime requests are skipped.');

  const paths: Record<string, unknown> = {};
  const servers = new Map<string, ReturnType<typeof openApiServer>>();
  const openapiSchemes: Record<string, unknown> = {};
  const usedOperationIds = new Set<string>();
  const tagNames = new Set<string>();

  for (const req of exportRequests) {
    const parts = normalizeExportUrl(safeExportUrl(req.url, includeSecrets));
    servers.set(parts.serverUrl, openApiServer(parts.serverUrl));
    const queryRows = activeQueryRows(req, parts.queryRows);
    const security = securityForRequest(req);
    addOpenApiSecurityScheme(security, openapiSchemes);
    const tag = tagForRequest(req);
    if (tag) tagNames.add(tag);
    mergePathItem(
      paths,
      parts.path,
      bodyMethod(req.method).toLowerCase(),
      openApiOperation(req, parts.path, queryRows, stripFn, usedOperationIds, security, includeSecrets),
      req.name || req.url,
    );
  }

  return {
    openapi: '3.0.3',
    info: {
      title: collectionName || 'Kurlo Collection',
      version: '1.0.0',
      ...(collectionDescription ? { description: collectionDescription } : {}),
    },
    servers: Array.from(servers.values()),
    ...(tagNames.size ? { tags: Array.from(tagNames).map(name => ({ name })) } : {}),
    paths,
    ...(Object.keys(openapiSchemes).length ? { components: { securitySchemes: openapiSchemes } } : {}),
  };
}

export function buildSwaggerDocument(
  collectionName: string,
  collectionDescription: string,
  requests: SavedRequest[],
  stripFn: (s: string, t: string) => string,
  includeSecrets = false,
): Record<string, unknown> {
  if (!requests.length) throw new Error('Collection has no saved requests to export.');
  const exportRequests = httpExportRequests(requests);
  if (!exportRequests.length) throw new Error('Swagger export only supports HTTP and SSE requests. GraphQL, gRPC, MCP, AI and realtime requests are skipped.');

  const paths: Record<string, unknown> = {};
  const serverUrls: string[] = [];
  const swaggerSchemes: Record<string, unknown> = {};
  const usedOperationIds = new Set<string>();
  const tagNames = new Set<string>();

  for (const req of exportRequests) {
    const parts = normalizeExportUrl(safeExportUrl(req.url, includeSecrets));
    if (!serverUrls.includes(parts.serverUrl)) serverUrls.push(parts.serverUrl);
    const queryRows = activeQueryRows(req, parts.queryRows);
    const security = securityForRequest(req);
    addSwaggerSecurityScheme(security, swaggerSchemes);
    const tag = tagForRequest(req);
    if (tag) tagNames.add(tag);
    mergePathItem(
      paths,
      parts.path,
      bodyMethod(req.method).toLowerCase(),
      swaggerOperation(req, parts.path, queryRows, stripFn, usedOperationIds, security, includeSecrets),
      req.name || req.url,
    );
  }

  const server = swaggerHostFromServer(serverUrls[0] || '/');
  return {
    swagger: '2.0',
    info: {
      title: collectionName || 'Kurlo Collection',
      version: '1.0.0',
      ...(collectionDescription ? { description: collectionDescription } : {}),
    },
    schemes: server.schemes,
    host: server.host,
    basePath: server.basePath,
    ...(server['x-kurlo-server'] ? { 'x-kurlo-server': server['x-kurlo-server'] } : {}),
    ...(serverUrls.length > 1 ? { 'x-kurlo-servers': serverUrls } : {}),
    ...(tagNames.size ? { tags: Array.from(tagNames).map(name => ({ name })) } : {}),
    paths,
    ...(Object.keys(swaggerSchemes).length ? { securityDefinitions: swaggerSchemes } : {}),
  };
}

export function buildOpenApiExport(
  format: OpenApiExportFormat,
  collectionName: string,
  collectionDescription: string,
  requests: SavedRequest[],
  stripFn: (s: string, t: string) => string,
  includeSecrets = false,
): Record<string, unknown> {
  return format === 'swagger2'
    ? buildSwaggerDocument(collectionName, collectionDescription, requests, stripFn, includeSecrets)
    : buildOpenApiDocument(collectionName, collectionDescription, requests, stripFn, includeSecrets);
}
