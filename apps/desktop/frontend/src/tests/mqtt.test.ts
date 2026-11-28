import { describe, expect, it } from 'vitest';
import { mqttConfig, mqttConfigIsDefault, mqttTopicMatches, mqttValidateFilter } from '../lib/mqtt';
import { mqttWire } from '../lib/mqttWire';
import { normalizeSavedRequest } from '../lib/normalizers';

describe('MQTT config', () => {
  it('fills defaults that match Postman', () => {
    const config = mqttConfig();
    expect(config.version).toBe('5');
    expect(config.cleanSession).toBe(true);
    expect(config.keepAliveSec).toBe(60);
    expect(config.connectTimeoutMs).toBe(30000);
    expect(config.format).toBe('text');
    expect(mqttConfigIsDefault(config)).toBe(true);
  });

  it('repairs values a hand-edited YAML file could contain', () => {
    const config = mqttConfig({ version: '4', qos: 7, format: 'xml', keepAliveSec: -3, topics: [{ name: 'a', qos: '1', enabled: 'yes' }, { qos: 1 }], will: { qos: 2, enabled: true } } as never);
    expect(config.version).toBe('5');
    expect(config.qos).toBe(0);
    expect(config.format).toBe('text');
    expect(config.keepAliveSec).toBe(60);
    expect(config.topics).toEqual([{ name: 'a', qos: 1, enabled: false }]);
    expect(config.will.qos).toBe(2);
    expect(config.will.enabled).toBe(true);
  });

  it('keeps the MQTT block only on MQTT requests', () => {
    const mqtt = { ...mqttConfig(), topic: 't' };
    expect(normalizeSavedRequest({ requestType: 'mqtt', url: 'mqtt://b', mqtt }, [], 'ws-1').mqtt?.topic).toBe('t');
    expect(normalizeSavedRequest({ requestType: 'http', url: 'http://b', mqtt }, [], 'ws-1').mqtt).toBeUndefined();
    expect(normalizeSavedRequest({ requestType: 'mqtt', url: 'mqtt://b' }, [], 'ws-1').name).toBe('MQTT b');
  });

  it('resolves variables and drops disabled user properties before connecting', () => {
    const resolve = (value: string) => value.replace('{{id}}', '42');
    const wire = mqttWire({
      ...mqttConfig(),
      clientId: 'dev-{{id}}',
      topics: [{ name: 'devices/{{id}}/#', qos: 1, enabled: true }],
      connectProperties: { ...mqttConfig().connectProperties, userProperties: [{ key: 'a', value: '{{id}}', enabled: true }, { key: 'b', value: 'x', enabled: false }] },
    }, resolve);
    expect(wire.clientId).toBe('dev-42');
    expect(wire.topics?.[0].name).toBe('devices/42/#');
    expect(wire.connectProperties?.userProperties?.map(row => [row.key, row.value])).toEqual([['a', '42']]);
  });
});

describe('MQTT topic filters', () => {
  it('matches single and multi level wildcards like a broker', () => {
    expect(mqttTopicMatches('sensors/+/temp', 'sensors/kitchen/temp')).toBe(true);
    expect(mqttTopicMatches('sensors/+/temp', 'sensors/kitchen/hum')).toBe(false);
    expect(mqttTopicMatches('sensors/#', 'sensors')).toBe(true);
    expect(mqttTopicMatches('sensors/#', 'sensors/a/b/c')).toBe(true);
    expect(mqttTopicMatches('#', '$SYS/uptime')).toBe(false);
    expect(mqttTopicMatches('+/uptime', '$SYS/uptime')).toBe(false);
    expect(mqttTopicMatches('a/b', 'a/b/c')).toBe(false);
  });

  it('explains invalid filters', () => {
    expect(mqttValidateFilter('a/#/b')).toMatch('#');
    expect(mqttValidateFilter('a+')).toMatch('+');
    expect(mqttValidateFilter(' ')).toBe('Enter a topic');
    expect(mqttValidateFilter('a/+/b/#')).toBe('');
  });
});
