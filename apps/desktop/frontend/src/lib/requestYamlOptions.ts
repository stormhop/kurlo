import schema from '../../../../../schemas/kurlo-workspace-yaml-v1.schema.json';

export type RequestYamlOption = {
  label: string;
  detail?: string;
  type: 'property' | 'enum' | 'constant';
  valueKind?: 'object' | 'array' | 'scalar';
};

type SchemaNode = {
  $ref?: string;
  type?: string;
  enum?: (string | number | boolean)[];
  description?: string;
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
  items?: SchemaNode;
};

const definitions = schema.definitions as Record<string, SchemaNode>;
export const managedRequestFields = new Set([
  'id', 'collectionId', 'filesystemName', 'requestTab', 'isDraft', 'isPinned',
  'isInvalid', 'workspaceDiagnostics', 'exampleCount', 'examples', 'collection', 'order',
]);
const authPrefixes: Record<string, string[]> = {
  inherit: [], none: [], bearer: ['bearerToken'], basic: ['basicUser', 'basicPass'],
  digest: ['basicUser', 'basicPass'], ntlm: ['basicUser', 'basicPass'], apikey: ['apiKey'],
  oauth2: ['oauth2'], aws: ['aws'], oauth1: ['oauth1'], jwt: ['jwt'],
};
const protocolFieldGroups: { fields: string[]; protocols: string[] }[] = [
  { fields: ['postResponseVars', 'assertions', 'openapi'], protocols: ['http', 'graphql'] },
  { fields: ['savedMessages'], protocols: ['ws', 'socketio'] },
  { fields: ['formRows'], protocols: ['http'] },
  { fields: ['bodyFilePath', 'bodyFileName'], protocols: ['http'] },
];
const protocolPrefixes: { prefix: string; protocols: string[] }[] = [
  { prefix: 'graphql', protocols: ['graphql'] },
  { prefix: 'grpc', protocols: ['grpc'] },
  { prefix: 'mcp', protocols: ['mcp'] },
  { prefix: 'ai', protocols: ['ai'] },
  { prefix: 'sio', protocols: ['socketio'] },
];
const httpOnlySettings = ['httpVersion', 'followRedirects', 'followOriginalMethod', 'followAuthorizationHeader', 'removeRefererHeader', 'maxRedirects', 'sseDisableReconnect', 'sseReconnectIntervalMs'];
const browserSettings = ['browserEmulation', 'browserOrigin', 'browserWithCredentials', 'browserEnforceCORS', 'browserEnforceCSP', 'browserCSP'];
const requestSecretFields = new Set([
  'bearerToken', 'basicPass', 'apiKeyValue', 'oauth2Secret', 'oauth2Token', 'oauth2RefreshToken',
  'oauth2Password', 'oauth2AssertionPrivateKey', 'awsAccessKey', 'awsSecretKey', 'awsSessionToken',
  'oauth1ConsumerSecret', 'oauth1Token', 'oauth1TokenSecret', 'oauth1PrivateKey', 'jwtSecret', 'jwtPrivateKey',
]);

function resolveReference(node: SchemaNode) {
  if (!node.$ref) return node;
  const name = node.$ref.split('/').at(-1) ?? '';
  return Object.hasOwn(definitions, name) ? definitions[name] : undefined;
}

function schemaNode(path: string[]): SchemaNode | undefined {
  if (path[0] !== 'request') return undefined;
  let node: SchemaNode | undefined = definitions.request;
  for (const key of path.slice(1)) {
    if (!node) return undefined;
    if (key === '*') node = node.items;
    else if (node.properties && Object.hasOwn(node.properties, key)) node = node.properties[key];
    else node = typeof node.additionalProperties === 'object' ? node.additionalProperties : undefined;
    if (node) node = resolveReference(node);
  }
  return node;
}

function hasPrefix(name: string, prefixes: string[]) {
  return prefixes.some(prefix => name.startsWith(prefix));
}

function allowedProperty(path: string[], name: string, siblings: ReadonlyMap<string, string>, requestType?: string, method?: string) {
  const protocol = requestType ?? 'http';
  if (path.length === 1 && path[0] === 'request') {
    const bodyType = siblings.get('bodyType');
    if (name === 'formRows' && bodyType && bodyType !== 'form' && bodyType !== 'urlencoded') return false;
    if ((name === 'bodyFilePath' || name === 'bodyFileName') && bodyType && bodyType !== 'binary') return false;
    if (protocol === 'socketio' && ['bodyType', 'bodyContent', 'rawBodyType'].includes(name)) return false;
    if (name === 'method' && !['http', 'graphql'].includes(protocol)) return false;
    return !managedRequestFields.has(name) &&
      !protocolPrefixes.some(group => name.startsWith(group.prefix) && !group.protocols.includes(protocol)) &&
      !protocolFieldGroups.some(group => group.fields.includes(name) && !group.protocols.includes(protocol));
  }
  if (path.length === 2 && path[0] === 'request' && path[1] === 'settings') {
    if (protocol === 'http') return !hasPrefix(name, ['ws', 'sio', 'grpc']) && (method?.toUpperCase() === 'SSE' || !name.startsWith('sse'));
    if (protocol === 'graphql' || protocol === 'mcp' || protocol === 'ai') return !hasPrefix(name, ['ws', 'sio', 'grpc']) && !name.startsWith('sse');
    if (protocol === 'ws') return !hasPrefix(name, ['sio', 'grpc']) && !httpOnlySettings.includes(name);
    if (protocol === 'socketio') return !hasPrefix(name, ['grpc']) && !httpOnlySettings.includes(name);
    if (protocol === 'grpc') return !hasPrefix(name, ['ws', 'sio']) && !httpOnlySettings.includes(name) && !browserSettings.includes(name) && !['encodeUrlAutomatically', 'disableCookieJar'].includes(name);
    return true;
  }
  if (path.length === 2 && path[0] === 'request' && path[1] === 'auth') {
    const type = siblings.get('type');
    if (!type || !Object.hasOwn(authPrefixes, type)) return name === 'type';
    return name === 'type' || hasPrefix(name, authPrefixes[type]);
  }
  return true;
}

function propertyDetail(name: string, property: SchemaNode) {
  if (requestSecretFields.has(name)) return 'Sensitive value. Enter it in Auth to store it in the vault. YAML uses its reference.';
  if (name === 'clientKeyPassword') return 'Enter the private key password in the request settings. YAML uses its vault reference.';
  if (name === 'basicUser') return 'Username or email accepted by the server.';
  if (property.description) return property.description;
  if (property.type === 'boolean') return 'Boolean. Use true or false.';
  if (name === 'auth') return 'Authentication settings for this request.';
  if (name === 'settings') return 'Request-specific settings. Available fields depend on the protocol.';
  return undefined;
}

function valueKind(property: SchemaNode): RequestYamlOption['valueKind'] {
  property = resolveReference(property) ?? property;
  if (property.type === 'object') return 'object';
  if (property.type === 'array') return 'array';
  return 'scalar';
}

export function requestYamlOptions(
  path: string[],
  kind: 'key' | 'value',
  siblings: ReadonlyMap<string, string>,
  requestType?: string,
  method?: string,
): RequestYamlOption[] {
  if (path[0] !== 'request' || managedRequestFields.has(path[1])) return [];
  const overrides = kind === 'key' && path.length === 2 && path[1] === 'settingsOverrides';
  const propertyPath = overrides ? ['request', 'settings'] : path;
  const property = schemaNode(propertyPath);
  if (!property) return [];
  if (kind === 'key') {
    return Object.entries(property.properties ?? {})
      .filter(([name]) => !siblings.has(name) && allowedProperty(propertyPath, name, siblings, requestType, method))
      .map(([name, item]) => ({
        label: name,
        detail: overrides ? 'Override this setting for the request.' : propertyDetail(name, item),
        type: 'property',
        valueKind: overrides ? 'scalar' : valueKind(item),
      }));
  }
  if (property.enum) {
    let values = property.enum;
    if (path[0] === 'request' && path[1] === 'method') {
      const protocol = requestType ?? 'http';
      values = protocol === 'graphql' || protocol === 'grpc' || protocol === 'mcp' || protocol === 'ai'
        ? ['POST']
        : protocol === 'ws' || protocol === 'socketio'
          ? ['GET']
          : values;
    }
    return values.map(value => ({ label: value === '' ? '""' : String(value), detail: value === '' ? 'Empty string.' : undefined, type: 'enum' as const }));
  }
  if (property.type === 'boolean') return [
    { label: 'true', detail: 'Enabled.', type: 'constant' },
    { label: 'false', detail: 'Disabled.', type: 'constant' },
  ];
  return [];
}
