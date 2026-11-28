import type { AuthState, KVRow, SavedRequest } from './types/models';
import { DEFAULT_REQUEST_SETTINGS, mkRow } from './constants';
import { asArray, asText, emptyAuthState, isRecord, newRequestId } from './utils';
import { filesystemNameFromName } from './normalizers';
import { kafkaConfig, type KafkaConfig } from './kafka';
import { mqttConfig, type MqttFormat, type MqttQoS, type MqttSavedMessage, type MqttTopic, type MqttVersion } from './mqtt';
import { deref, schemaExample, stringifyJson } from './openapi';
import { parseYaml } from './yaml';

type Doc = Record<string, unknown>;

type Protocol = 'kafka' | 'mqtt';

type Server = { name: string; protocol: Protocol; address: string; description: string; tls: boolean; version: MqttVersion; security: unknown[]; binding: Doc };

type ChannelInfo = { key: string; title: string; address: string; topic: string; matchesSchema: boolean; description: string; parameters: Record<string, unknown>; servers: string[]; bindings: Set<string> };

type MessageInfo = { name: string; title: string; description: string; payload: string; format: KafkaConfig['format']; key: string; keyFormat: KafkaConfig['keyFormat']; headers: KVRow[] };

type Operation = { id: string; title: string; description: string; produce: boolean; channel: ChannelInfo; messages: MessageInfo[]; bindings: Doc };

export type AsyncApiImport = { requests: SavedRequest[]; variables: KVRow[] };

const SERVER_PROTOCOLS: Record<string, { protocol: Protocol; scheme: string; version?: MqttVersion }> = {
  kafka: { protocol: 'kafka', scheme: '' },
  'kafka-secure': { protocol: 'kafka', scheme: '' },
  mqtt: { protocol: 'mqtt', scheme: 'mqtt' },
  mqtt5: { protocol: 'mqtt', scheme: 'mqtt', version: '5' },
  'secure-mqtt': { protocol: 'mqtt', scheme: 'mqtts' },
  mqtts: { protocol: 'mqtt', scheme: 'mqtts' },
  ws: { protocol: 'mqtt', scheme: 'ws' },
  wss: { protocol: 'mqtt', scheme: 'wss' },
};
const JSON_SCHEMA_FORMAT = /^application\/(schema\+)?(json|yaml)|^application\/vnd\.aai\.asyncapi/i;

function row(key: string, value: string, description = '', enabled = true): KVRow {
  return { ...mkRow(), key, value, description, enabled };
}

export function parseAsyncApiDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return parseYaml(text);
  }
}

export function isAsyncApiDocument(value: unknown): value is Doc {
  return isRecord(value) && typeof value.asyncapi === 'string';
}

function majorVersion(doc: Doc) {
  return Number.parseInt(asText(doc.asyncapi), 10) || 0;
}

export function asyncApiCollectionName(doc: unknown, fileName: string) {
  const title = isRecord(doc) && isRecord(doc.info) ? asText(doc.info.title).trim() : '';
  return title || fileName.replace(/\.(json|ya?ml)$/i, '') || 'AsyncAPI';
}

function securityTypes(doc: Doc, requirements: unknown[]): string[] {
  const schemes = isRecord(doc.components) && isRecord(doc.components.securitySchemes) ? doc.components.securitySchemes : {};
  const types: string[] = [];
  for (const requirement of requirements) {
    const resolved = deref(doc, requirement);
    if (isRecord(resolved) && typeof resolved.type === 'string') {
      types.push(resolved.type);
      continue;
    }
    if (!isRecord(requirement)) continue;
    for (const name of Object.keys(requirement)) {
      const scheme = deref(doc, schemes[name]);
      if (isRecord(scheme) && typeof scheme.type === 'string') types.push(scheme.type);
    }
  }
  return types;
}

function bindingOf(value: unknown, protocol: string): Doc {
  const resolved = isRecord(value) ? value : {};
  return isRecord(resolved.bindings) && isRecord(resolved.bindings[protocol]) ? resolved.bindings[protocol] : {};
}

function mqttVersion(protocolVersion: string, fallback: MqttVersion): MqttVersion {
  const version = protocolVersion.trim();
  if (version.startsWith('5')) return '5';
  if (version === '3.1') return '3.1';
  if (version.startsWith('3') || version === '4') return '3.1.1';
  return fallback;
}

function servers(doc: Doc): { list: Server[]; other: string[] } {
  const list: Server[] = [];
  const other: string[] = [];
  const entries = isRecord(doc.servers) ? Object.entries(doc.servers) : [];
  for (const [name, value] of entries) {
    const server = deref(doc, value);
    if (!isRecord(server)) continue;
    const protocolName = asText(server.protocol).toLowerCase();
    const known = SERVER_PROTOCOLS[protocolName];
    if (!known) {
      if (protocolName) other.push(protocolName);
      continue;
    }
    let address = asText(server.host) ? asText(server.host) + asText(server.pathname) : asText(server.url);
    address = address.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
    const variables = isRecord(server.variables) ? server.variables : {};
    address = address.replace(/\{([^{}]+)\}/g, (match, key: string) => {
      const variable = deref(doc, variables[key]);
      const fallback = isRecord(variable) ? asText(variable.default) || asText(asArray(variable.enum)[0]) : '';
      return fallback || match;
    });
    const security = asArray(server.security);
    const types = securityTypes(doc, security);
    list.push({
      name, security,
      protocol: known.protocol,
      address: known.scheme ? `${known.scheme}://${address}` : address,
      description: asText(server.description) || asText(server.title),
      tls: protocolName === 'kafka-secure' || types.includes('X509') || /ssl/i.test(asText(server.protocolVersion)),
      version: mqttVersion(asText(server.protocolVersion), known.version ?? '3.1.1'),
      binding: bindingOf(server, 'mqtt'),
    });
  }
  return { list, other };
}

function bindingNames(...values: unknown[]): string[] {
  return values.flatMap(value => (isRecord(value) && isRecord(value.bindings) ? Object.keys(value.bindings) : []));
}

function channelInfo(doc: Doc, key: string, value: unknown): ChannelInfo | null {
  const channel = deref(doc, value);
  if (!isRecord(channel)) return null;
  const address = majorVersion(doc) >= 3 ? (channel.address === null ? '' : asText(channel.address) || key) : key;
  const binding = asText(bindingOf(channel, 'kafka').topic);
  const raw = binding || address;
  if (!raw) return null;
  return {
    key,
    address,
    title: asText(channel.title) || raw,
    topic: raw.replace(/\{([^{}]+)\}/g, '{{$1}}'),
    matchesSchema: !binding && !raw.includes('{'),
    description: asText(channel.description),
    parameters: isRecord(channel.parameters) ? channel.parameters : {},
    servers: asArray(channel.servers).map(entry => (typeof entry === 'string' ? entry : refKey(entry, '#/servers/'))).filter(Boolean),
    bindings: new Set(bindingNames(channel)),
  };
}

function exampleText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function payloadSchema(doc: Doc, message: Doc): unknown {
  const payload = deref(doc, message.payload);
  if (isRecord(payload) && 'schemaFormat' in payload && 'schema' in payload) {
    return JSON_SCHEMA_FORMAT.test(asText(payload.schemaFormat)) ? payload.schema : undefined;
  }
  const format = asText(message.schemaFormat);
  return !format || JSON_SCHEMA_FORMAT.test(format) ? payload : undefined;
}

function messageInfo(doc: Doc, value: unknown, fallbackName: string, defaultContentType: string, bindings: Set<string>): MessageInfo[] {
  const message = deref(doc, value);
  if (!isRecord(message)) return [];
  const alternatives = asArray(message.oneOf);
  if (alternatives.length) return alternatives.flatMap((item, index) => messageInfo(doc, item, `${fallbackName} ${index + 1}`, defaultContentType, bindings));
  for (const name of bindingNames(message)) bindings.add(name);
  const example = asArray(message.examples).map(item => deref(doc, item)).find(isRecord);
  const schema = payloadSchema(doc, message);
  const contentType = (asText(message.contentType) || defaultContentType || 'application/json').toLowerCase();
  const json = contentType.includes('json');
  let payloadValue: unknown = example && 'payload' in example ? example.payload : undefined;
  if (payloadValue === undefined && schema !== undefined) payloadValue = schemaExample(schema, doc);
  const payload = payloadValue === undefined ? '' : json ? stringifyJson(payloadValue) : exampleText(payloadValue);

  const kafkaBinding = bindingOf(message, 'kafka');
  const keyValue = kafkaBinding.key !== undefined ? schemaExample(kafkaBinding.key, doc) : undefined;
  const keyIsText = keyValue === undefined || typeof keyValue === 'string' || typeof keyValue === 'number';
  const key = keyValue === undefined ? '' : keyIsText ? String(keyValue) : JSON.stringify(keyValue);

  const headers: KVRow[] = [];
  const headerSchema = deref(doc, message.headers);
  const exampleHeaders = example && isRecord(example.headers) ? example.headers : {};
  if (isRecord(headerSchema) && isRecord(headerSchema.properties)) {
    for (const [name, property] of Object.entries(headerSchema.properties)) {
      const resolved = deref(doc, property);
      const sample = name in exampleHeaders ? exampleHeaders[name] : schemaExample(property, doc);
      headers.push(row(name, exampleText(sample), isRecord(resolved) ? asText(resolved.description) : ''));
    }
  }
  const name = asText(message.name) || asText(message.messageId) || fallbackName;
  return [{
    name,
    title: asText(message.title) || name,
    description: asText(message.description) || asText(message.summary),
    payload,
    format: json ? 'json' : 'text',
    key,
    keyFormat: keyIsText ? 'text' : 'json',
    headers,
  }];
}

function refKey(value: unknown, prefix: string): string {
  const ref = isRecord(value) ? asText(value.$ref) : '';
  return ref.startsWith(prefix) ? ref.slice(prefix.length).replace(/~1/g, '/').replace(/~0/g, '~') : '';
}

function operations(doc: Doc): Operation[] {
  const contentType = asText(doc.defaultContentType);
  const channels = isRecord(doc.channels) ? doc.channels : {};
  const out: Operation[] = [];
  const messagesOf = (sources: unknown[], prefix: string, channel: ChannelInfo) =>
    sources.flatMap((item, index) => messageInfo(doc, item, `${prefix} message ${index + 1}`, contentType, channel.bindings));
  if (majorVersion(doc) >= 3) {
    const declared = isRecord(doc.operations) ? Object.entries(doc.operations) : [];
    const used = new Set<string>();
    for (const [id, value] of declared) {
      const operation = deref(doc, value);
      if (!isRecord(operation)) continue;
      const channelKey = refKey(operation.channel, '#/channels/');
      const channel = channelKey ? channelInfo(doc, channelKey, channels[channelKey]) : null;
      if (!channel) continue;
      used.add(channelKey);
      for (const name of bindingNames(operation)) channel.bindings.add(name);
      const rawChannel = deref(doc, channels[channelKey]);
      const listed = asArray(operation.messages);
      const sources = listed.length ? listed : isRecord(rawChannel) && isRecord(rawChannel.messages) ? Object.values(rawChannel.messages) : [];
      out.push({
        id, channel,
        title: asText(operation.title) || asText(operation.summary) || id,
        description: asText(operation.description) || asText(operation.summary),
        produce: asText(operation.action) === 'receive',
        messages: messagesOf(sources, id, channel),
        bindings: bindingOf(operation, 'mqtt'),
      });
    }
    for (const [key, value] of Object.entries(channels)) {
      if (used.has(key)) continue;
      const channel = channelInfo(doc, key, value);
      const rawChannel = deref(doc, value);
      if (!channel || !isRecord(rawChannel)) continue;
      const messages = isRecord(rawChannel.messages) ? messagesOf(Object.values(rawChannel.messages), key, channel) : [];
      out.push({ id: key, channel, title: `Produce to ${channel.title}`, description: channel.description, produce: true, messages, bindings: {} });
      out.push({ id: key, channel, title: `Consume ${channel.title}`, description: channel.description, produce: false, messages, bindings: {} });
    }
    return out;
  }
  for (const [key, value] of Object.entries(channels)) {
    const channel = channelInfo(doc, key, value);
    const rawChannel = deref(doc, value);
    if (!channel || !isRecord(rawChannel)) continue;
    for (const action of ['publish', 'subscribe'] as const) {
      const operation = deref(doc, rawChannel[action]);
      if (!isRecord(operation)) continue;
      for (const name of bindingNames(operation)) channel.bindings.add(name);
      const id = asText(operation.operationId) || `${action} ${key}`;
      out.push({
        id, channel,
        title: asText(operation.summary) || id,
        description: asText(operation.description) || asText(operation.summary),
        produce: action === 'publish',
        messages: messageInfo(doc, operation.message, id, contentType, channel.bindings),
        bindings: bindingOf(operation, 'mqtt'),
      });
    }
  }
  return out;
}

function kafkaAuth(types: string[], config: KafkaConfig): { auth: AuthState; variables: KVRow[] } {
  const auth = emptyAuthState() as AuthState;
  const scram = types.find(type => type === 'scramSha256' || type === 'scramSha512');
  if (scram || types.includes('plain') || types.includes('userPassword')) {
    auth.type = 'basic';
    auth.basicUser = '{{kafkaUsername}}';
    auth.basicPass = '{{kafkaPassword}}';
    config.mechanism = scram === 'scramSha512' ? 'SCRAM-SHA-512' : scram ? 'SCRAM-SHA-256' : 'PLAIN';
    return { auth, variables: [row('kafkaUsername', '', 'SASL user name'), row('kafkaPassword', '', 'SASL password')] };
  }
  if (types.includes('oauth2')) {
    auth.type = 'bearer';
    auth.bearerToken = '{{kafkaToken}}';
    return { auth, variables: [row('kafkaToken', '', 'OAUTHBEARER access token')] };
  }
  return { auth, variables: [] };
}

function notes(...parts: string[]) {
  return parts.map(part => part.trim()).filter(Boolean).join('\n\n');
}

function channelProtocols(operation: Operation, byName: Map<string, Server>, available: Set<Protocol>): Protocol[] {
  const listed = operation.channel.servers.map(name => byName.get(name)?.protocol).filter((protocol): protocol is Protocol => Boolean(protocol));
  if (listed.length) return [...new Set(listed)];
  if (available.size) return [...available];
  const { bindings } = operation.channel;
  return bindings.has('mqtt') && !bindings.has('kafka') ? ['mqtt'] : ['kafka'];
}

function savedRequest(base: Omit<SavedRequest, 'id' | 'filesystemName' | 'params' | 'bodyType' | 'rawBodyType' | 'bodyFilePath' | 'bodyFileName' | 'formRows' | 'preRequestScriptJs' | 'testScriptJs' | 'settings'>): SavedRequest {
  const id = newRequestId();
  return {
    ...base,
    id,
    filesystemName: filesystemNameFromName(base.name, id),
    params: [],
    bodyType: 'text',
    rawBodyType: 'text',
    bodyFilePath: '',
    bodyFileName: '',
    formRows: [],
    preRequestScriptJs: '',
    testScriptJs: '',
    settings: { ...DEFAULT_REQUEST_SETTINGS },
  };
}

function qosOf(binding: Doc): MqttQoS {
  const n = Number(binding.qos);
  return n === 1 || n === 2 ? n : 0;
}

function parameterVariables(doc: Doc, operations: Operation[], topicOf: (operation: Operation) => string): KVRow[] {
  const rows: KVRow[] = [];
  const seen = new Set<string>();
  for (const operation of operations) {
    const topic = topicOf(operation);
    for (const [name, parameter] of Object.entries(operation.channel.parameters)) {
      if (seen.has(name) || !topic.includes(`{{${name}}}`)) continue;
      seen.add(name);
      const resolved = deref(doc, parameter);
      const schema = isRecord(resolved) && isRecord(resolved.schema) ? resolved.schema : resolved;
      const fallback = isRecord(schema) ? asText(schema.default) || asText(asArray(schema.enum)[0]) || asText(asArray(schema.examples)[0]) : '';
      rows.push(row(name, fallback, isRecord(resolved) ? asText(resolved.description) : ''));
    }
  }
  return rows;
}

function kafkaRequests(doc: Doc, found: Operation[], kafkaServers: Server[], collectionId: string, collectionName: string, schemaPath: string): AsyncApiImport {
  const variables: KVRow[] = kafkaServers.length
    ? kafkaServers.map((server, index) => row('brokers', server.address, notes(server.name, server.description), index === 0))
    : [row('brokers', 'localhost:9092', 'Bootstrap brokers')];
  const primary = kafkaServers[0];
  const byName = new Map(kafkaServers.map(server => [server.name, server]));
  const pinnedServer = (operation: Operation) => (kafkaServers.length > 1 ? operation.channel.servers.map(name => byName.get(name)).find(Boolean) : undefined);
  const brokerVariable = (server: Server) => `brokers_${server.name.replace(/[^A-Za-z0-9_]+/g, '_')}`;
  const connections = new Map<Server | undefined, { url: string; auth: AuthState; config: KafkaConfig }>();
  const connectionFor = (server: Server | undefined) => {
    const existing = connections.get(server);
    if (existing) return existing;
    const source = server ?? primary;
    const config = kafkaConfig();
    const { auth, variables: authVariables } = kafkaAuth(source ? securityTypes(doc, source.security) : [], config);
    for (const variable of authVariables) {
      if (!variables.some(item => item.key === variable.key)) variables.push(variable);
    }
    if (server) variables.push(row(brokerVariable(server), server.address, notes(server.name, server.description)));
    const connection = { url: server ? `{{${brokerVariable(server)}}}` : '{{brokers}}', auth, config: { ...config, tls: source?.tls ?? false } };
    connections.set(server, connection);
    return connection;
  };
  for (const operation of found) connectionFor(pinnedServer(operation));
  variables.push(...parameterVariables(doc, found, operation => operation.channel.topic));

  const channelCount = new Set(found.map(operation => operation.channel.key)).size;
  const requests: SavedRequest[] = [];
  const names = new Set<string>();
  const uniqueName = (base: string, folder: string) => {
    let name = base;
    for (let n = 2; names.has(`${folder}/${name}`); n++) name = `${base} ${n}`;
    names.add(`${folder}/${name}`);
    return name;
  };
  const push = (operation: Operation, name: string, kafka: Partial<KafkaConfig>, message: MessageInfo | null) => {
    const folderPath = channelCount > 1 ? [operation.channel.title] : [];
    const connection = connectionFor(pinnedServer(operation));
    requests.push(savedRequest({
      name: uniqueName(name, folderPath.join('/')),
      collectionId,
      collection: collectionName,
      folderPath,
      requestType: 'kafka',
      method: 'POST',
      url: connection.url,
      requestTab: 'body',
      headers: message?.headers ?? [],
      auth: { ...connection.auth },
      bodyContent: message?.payload ?? '',
      requestNotes: notes(operation.description, message?.description ?? '', operation.channel.description && `Topic: ${operation.channel.description}`),
      kafka: { ...connection.config, ...kafka },
    }));
  };
  for (const operation of found) {
    const linked = schemaPath && operation.channel.matchesSchema ? schemaPath : '';
    if (operation.produce) {
      const messages = operation.messages.length ? operation.messages : [null];
      for (const message of messages) {
        const label = messages.length > 1 && message ? `${operation.title} · ${message.title}` : operation.title;
        push(operation, label, {
          mode: 'produce', topic: operation.channel.topic, schemaPath: linked,
          format: message?.format ?? 'json', key: message?.key ?? '', keyFormat: message?.keyFormat ?? 'text',
        }, message);
      }
    } else {
      push(operation, operation.title, {
        mode: 'consume', topics: [{ name: operation.channel.topic, ...(linked ? { schemaPath: linked } : {}) }],
        startFrom: 'latest', stopAfter: 'records', stopValue: '10',
      }, null);
    }
  }
  return { requests, variables };
}

const publishTopic = (operation: Operation) => operation.channel.address.replace(/\{([^{}]+)\}/g, '{{$1}}');
const subscribeFilter = (operation: Operation) => operation.channel.address.split('/').map(level => (/\{[^{}]+\}/.test(level) ? '+' : level)).join('/');

function mqttRequest(doc: Doc, found: Operation[], mqttServers: Server[], collectionId: string, name: string): AsyncApiImport {
  const primary = mqttServers[0];
  const variables: KVRow[] = mqttServers.length
    ? mqttServers.map((server, index) => row('mqttBroker', server.address, notes(server.name, server.description), index === 0))
    : [row('mqttBroker', 'mqtt://localhost:1883', 'MQTT broker')];
  const auth = emptyAuthState() as AuthState;
  if (primary && securityTypes(doc, primary.security).some(type => type === 'userPassword' || type === 'plain')) {
    auth.type = 'basic';
    auth.basicUser = '{{mqttUsername}}';
    auth.basicPass = '{{mqttPassword}}';
    variables.push(row('mqttUsername', '', 'MQTT user name'), row('mqttPassword', '', 'MQTT password'));
  }
  const publishing = found.filter(operation => operation.produce);
  variables.push(...parameterVariables(doc, publishing, publishTopic));

  const topics: MqttTopic[] = [];
  for (const operation of found.filter(item => !item.produce)) {
    const filter = subscribeFilter(operation);
    if (!filter || topics.some(topic => topic.name === filter)) continue;
    topics.push({ name: filter, qos: qosOf(operation.bindings), enabled: true, ...(operation.title ? { description: operation.title } : {}) });
  }
  const savedMessages: MqttSavedMessage[] = publishing.flatMap(operation => {
    const messages = operation.messages.length ? operation.messages : [null];
    return messages.map((message, index) => ({
      id: `asyncapi-${operation.id}-${index + 1}`.replace(/[^a-zA-Z0-9_-]+/g, '-'),
      name: messages.length > 1 && message ? `${operation.title} · ${message.title}` : operation.title,
      topic: publishTopic(operation),
      payload: message?.payload ?? '',
      format: (message?.format === 'json' ? 'json' : 'text') as MqttFormat,
      qos: qosOf(operation.bindings),
      retain: operation.bindings.retain === true,
    }));
  });
  const first = savedMessages[0];
  const binding = primary?.binding ?? {};
  const will = isRecord(binding.lastWill) ? binding.lastWill : null;
  const keepAlive = Number(binding.keepAlive);
  const mqtt = mqttConfig({
    version: primary?.version ?? '3.1.1',
    clientId: asText(binding.clientId),
    cleanSession: binding.cleanSession !== false,
    keepAliveSec: Number.isFinite(keepAlive) && keepAlive >= 0 ? keepAlive : 60,
    topic: first?.topic ?? '',
    qos: first?.qos ?? 0,
    retain: first?.retain ?? false,
    format: first?.format ?? 'text',
    topics,
    savedMessages,
    ...(will && asText(will.topic) ? { will: { enabled: true, topic: asText(will.topic), payload: exampleText(will.message), format: 'text', qos: qosOf(will), retain: will.retain === true } } : {}),
  });
  const info = isRecord(doc.info) ? doc.info : {};
  const request = savedRequest({
    name,
    collectionId,
    collection: name,
    folderPath: [],
    requestType: 'mqtt',
    method: 'GET',
    url: '{{mqttBroker}}',
    requestTab: 'body',
    headers: [],
    auth,
    bodyContent: first?.payload ?? '',
    requestNotes: notes(asText(info.description), ...found.map(operation => `${operation.produce ? 'Publish' : 'Subscribe'} ${operation.produce ? publishTopic(operation) : subscribeFilter(operation)}${operation.description ? `: ${operation.description}` : ''}`)),
    mqtt,
  });
  return { requests: [request], variables };
}

export function asyncApiImport(value: unknown, collectionId: string, collectionName: string, schemaPath = ''): AsyncApiImport {
  if (!isAsyncApiDocument(value)) throw new Error('Expected an AsyncAPI document');
  const doc = value;
  const major = majorVersion(doc);
  if (major < 2 || major > 3) throw new Error(`AsyncAPI ${asText(doc.asyncapi)} is not supported; use version 2.x or 3.x`);
  const { list, other } = servers(doc);
  if (!list.length && other.length) {
    throw new Error(`This AsyncAPI document has no Kafka or MQTT servers (it lists ${[...new Set(other)].join(', ')}); Kurlo builds Kafka and MQTT requests`);
  }
  const found = operations(doc);
  if (!found.length) throw new Error('No channels with operations found in the AsyncAPI document');

  const byName = new Map(list.map(server => [server.name, server]));
  const available = new Set(list.map(server => server.protocol));
  const kafkaOps = found.filter(operation => channelProtocols(operation, byName, available).includes('kafka'));
  const mqttOps = found.filter(operation => channelProtocols(operation, byName, available).includes('mqtt'));
  const kafka = kafkaOps.length ? kafkaRequests(doc, kafkaOps, list.filter(server => server.protocol === 'kafka'), collectionId, collectionName, schemaPath) : { requests: [], variables: [] };
  const mqtt = mqttOps.length ? mqttRequest(doc, mqttOps, list.filter(server => server.protocol === 'mqtt'), collectionId, kafkaOps.length ? 'MQTT session' : collectionName) : { requests: [], variables: [] };
  for (const request of mqtt.requests) request.collection = collectionName;
  const variables = [...kafka.variables];
  for (const variable of mqtt.variables) {
    if (!variables.some(existing => existing.key === variable.key && existing.value === variable.value)) variables.push(variable);
  }
  return { requests: [...kafka.requests, ...mqtt.requests], variables };
}
