export type MqttProperty = { key: string; value: string; enabled: boolean };

export type MqttVersion = '3.1' | '3.1.1' | '5';
export type MqttFormat = 'text' | 'json' | 'base64' | 'hex';
export type MqttQoS = 0 | 1 | 2;

export type MqttTopic = { name: string; qos: MqttQoS; enabled: boolean; description?: string; noLocal?: boolean; retainAsPublished?: boolean };

export type MqttPublishProperties = {
  contentType: string;
  responseTopic: string;
  correlationData: string;
  messageExpiryInterval: string;
  topicAlias: string;
  payloadFormatIndicator: boolean;
  userProperties: MqttProperty[];
};

export type MqttConnectProperties = {
  sessionExpiryInterval: string;
  receiveMaximum: string;
  maximumPacketSize: string;
  topicAliasMaximum: string;
  requestResponseInformation: boolean;
  requestProblemInformation: boolean;
  userProperties: MqttProperty[];
};

export type MqttWill = {
  enabled: boolean;
  topic: string;
  payload: string;
  format: MqttFormat;
  qos: MqttQoS;
  retain: boolean;
  delayInterval: string;
  properties: MqttPublishProperties;
};

export type MqttSavedMessage = { id: string; name: string; topic: string; payload: string; format: MqttFormat; qos: MqttQoS; retain: boolean };

export type MqttConfig = {
  version: MqttVersion;
  clientId: string;
  cleanSession: boolean;
  keepAliveSec: number;
  connectTimeoutMs: number;
  autoReconnect: boolean;
  topic: string;
  qos: MqttQoS;
  retain: boolean;
  format: MqttFormat;
  topics: MqttTopic[];
  properties: MqttPublishProperties;
  connectProperties: MqttConnectProperties;
  will: MqttWill;
  savedMessages: MqttSavedMessage[];
};

export const MQTT_VERSIONS: MqttVersion[] = ['5', '3.1.1', '3.1'];
export const MQTT_FORMATS: { value: MqttFormat; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'json', label: 'JSON' },
  { value: 'base64', label: 'Base64' },
  { value: 'hex', label: 'Hexadecimal' },
];
export const MQTT_QOS_OPTIONS = [
  { value: '0', label: 'QoS 0 · at most once' },
  { value: '1', label: 'QoS 1 · at least once' },
  { value: '2', label: 'QoS 2 · exactly once' },
];

type Input = Partial<Record<keyof MqttConfig, unknown>> | undefined | null;

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function qos(value: unknown): MqttQoS {
  const n = Number(value);
  return n === 1 || n === 2 ? n : 0;
}

function format(value: unknown): MqttFormat {
  return value === 'json' || value === 'base64' || value === 'hex' ? value : 'text';
}

function whole(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function rows(value: unknown): MqttProperty[] {
  return (Array.isArray(value) ? value : []).map(rec).filter(row => text(row.key) || text(row.value))
    .map(row => ({ key: text(row.key), value: text(row.value), enabled: row.enabled !== false }));
}

export function mqttPublishProperties(input?: unknown): MqttPublishProperties {
  const p = rec(input);
  return {
    contentType: text(p.contentType),
    responseTopic: text(p.responseTopic),
    correlationData: text(p.correlationData),
    messageExpiryInterval: text(p.messageExpiryInterval),
    topicAlias: text(p.topicAlias),
    payloadFormatIndicator: p.payloadFormatIndicator === true,
    userProperties: rows(p.userProperties),
  };
}

export function mqttConfig(input?: Input): MqttConfig {
  const c = rec(input);
  const cp = rec(c.connectProperties);
  const will = rec(c.will);
  const version = c.version === '3.1' || c.version === '3.1.1' ? c.version : '5';
  return {
    version,
    clientId: text(c.clientId),
    cleanSession: c.cleanSession !== false,
    keepAliveSec: whole(c.keepAliveSec, 60),
    connectTimeoutMs: whole(c.connectTimeoutMs, 30000),
    autoReconnect: c.autoReconnect === true,
    topic: text(c.topic),
    qos: qos(c.qos),
    retain: c.retain === true,
    format: format(c.format),
    topics: (Array.isArray(c.topics) ? c.topics : []).map(rec).filter(t => typeof t.name === 'string')
      .map(t => ({
        name: text(t.name), qos: qos(t.qos), enabled: t.enabled === true,
        ...(text(t.description) ? { description: text(t.description) } : {}),
        ...(t.noLocal === true ? { noLocal: true } : {}),
        ...(t.retainAsPublished === true ? { retainAsPublished: true } : {}),
      })),
    properties: mqttPublishProperties(c.properties),
    connectProperties: {
      sessionExpiryInterval: text(cp.sessionExpiryInterval),
      receiveMaximum: text(cp.receiveMaximum),
      maximumPacketSize: text(cp.maximumPacketSize),
      topicAliasMaximum: text(cp.topicAliasMaximum),
      requestResponseInformation: cp.requestResponseInformation === true,
      requestProblemInformation: cp.requestProblemInformation === true,
      userProperties: rows(cp.userProperties),
    },
    will: {
      enabled: will.enabled === true,
      topic: text(will.topic),
      payload: text(will.payload),
      format: format(will.format),
      qos: qos(will.qos),
      retain: will.retain === true,
      delayInterval: text(will.delayInterval),
      properties: mqttPublishProperties(will.properties),
    },
    savedMessages: (Array.isArray(c.savedMessages) ? c.savedMessages : []).map(rec).map((m, i) => ({
      id: text(m.id) || `mqtt-msg-${i + 1}`,
      name: text(m.name) || `Message ${i + 1}`,
      topic: text(m.topic),
      payload: text(m.payload),
      format: format(m.format),
      qos: qos(m.qos),
      retain: m.retain === true,
    })),
  };
}

export function mqttConfigIsDefault(config: MqttConfig): boolean {
  return JSON.stringify(config) === JSON.stringify(mqttConfig());
}

export function mqttTopicColor(topic: string): number {
  let hash = 0;
  for (let i = 0; i < topic.length; i++) hash = (hash * 31 + topic.charCodeAt(i)) | 0;
  return Math.abs(hash) % 8;
}

export function mqttTopicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return i > 0 || !topic.startsWith('$');
    if (i >= t.length) return false;
    if (f[i] === '+') {
      if (i === 0 && t[0].startsWith('$')) return false;
      continue;
    }
    if (f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export function mqttValidateFilter(filter: string): string {
  const value = filter.trim();
  if (!value) return 'Enter a topic';
  const levels = value.split('/');
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (level.includes('#') && (level !== '#' || i !== levels.length - 1)) return '# must be the last level on its own';
    if (level.includes('+') && level !== '+') return '+ must fill a whole level';
  }
  return '';
}

export type MqttMessage = {
  id: string;
  direction: 'incoming' | 'outgoing' | 'system';
  topic?: string;
  payload?: string;
  encoding?: string;
  truncated?: boolean;
  size: number;
  qos: number;
  retain?: boolean;
  duplicate?: boolean;
  contentType?: string;
  responseTopic?: string;
  correlationData?: string;
  userProperties?: MqttProperty[];
  timestamp: number;
  isSystem: boolean;
  isError: boolean;
  message?: string;
};
