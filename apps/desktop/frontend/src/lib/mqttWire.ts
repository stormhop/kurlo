import { mqttConfig, type MqttConfig, type MqttProperty, type MqttPublishProperties } from './mqtt';
import type { HttpRequest, KeyValue } from './wire';

type Resolve = (value: string) => string;

function resolveRows(rows: MqttProperty[], resolve: Resolve): KeyValue[] {
  return rows.filter(row => row.enabled && row.key.trim()).map(row => ({ key: resolve(row.key), value: resolve(row.value), enabled: true, isFile: false, fileName: '', contentType: '' }));
}

export function mqttPublishPropertiesWire(p: MqttPublishProperties, resolve: Resolve) {
  return {
    contentType: resolve(p.contentType),
    responseTopic: resolve(p.responseTopic),
    correlationData: resolve(p.correlationData),
    messageExpiryInterval: resolve(p.messageExpiryInterval),
    topicAlias: resolve(p.topicAlias),
    payloadFormatIndicator: p.payloadFormatIndicator,
    userProperties: resolveRows(p.userProperties, resolve),
  };
}

export function mqttWire(input: Partial<MqttConfig> | undefined, resolve: Resolve): NonNullable<HttpRequest['mqtt']> {
  const c = mqttConfig(input);
  const cp = c.connectProperties;
  return {
    version: c.version,
    clientId: resolve(c.clientId),
    cleanSession: c.cleanSession,
    keepAliveSec: c.keepAliveSec,
    connectTimeoutMs: c.connectTimeoutMs,
    autoReconnect: c.autoReconnect,
    topic: resolve(c.topic),
    qos: c.qos,
    retain: c.retain,
    format: c.format,
    topics: c.topics.map(topic => ({ ...topic, name: resolve(topic.name) })),
    properties: mqttPublishPropertiesWire(c.properties, resolve),
    connectProperties: {
      sessionExpiryInterval: resolve(cp.sessionExpiryInterval),
      receiveMaximum: resolve(cp.receiveMaximum),
      maximumPacketSize: resolve(cp.maximumPacketSize),
      topicAliasMaximum: resolve(cp.topicAliasMaximum),
      requestResponseInformation: cp.requestResponseInformation,
      requestProblemInformation: cp.requestProblemInformation,
      userProperties: resolveRows(cp.userProperties, resolve),
    },
    will: { ...c.will, topic: resolve(c.will.topic), payload: resolve(c.will.payload), delayInterval: resolve(c.will.delayInterval), properties: mqttPublishPropertiesWire(c.will.properties, resolve) },
  };
}
