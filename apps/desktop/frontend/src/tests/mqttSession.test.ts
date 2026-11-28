import { afterEach, describe, expect, it, vi } from 'vitest';
import { mqttActive, mqttConnect, mqttSession, mqttSessions } from '../lib/stores/mqtt.svelte';
import { emptyHttpRequest } from '../lib/wire';

const handlers = new Map<string, (payload: unknown) => void>();

function emit(name: string, payload: unknown) {
  handlers.get(name)?.(payload);
}

describe('MQTT session status', () => {
  afterEach(() => {
    mqttSessions.clear();
    vi.unstubAllGlobals();
  });

  it('leaves Reconnecting when the broker can no longer be reached', async () => {
    vi.stubGlobal('window', {
      runtime: { EventsOn: (name: string, callback: (payload: unknown) => void) => { handlers.set(name, callback); return () => handlers.delete(name); } },
      go: { api: { App: { MqttConnect: vi.fn(async () => {}) } } },
    });
    await mqttConnect('device', { ...emptyHttpRequest(), url: 'mqtt://broker.test' });
    emit('mqtt:open', { sessionId: 'device', url: 'mqtt://broker.test:1883', clientId: 'kurlo-1', version: '5', sessionPresent: false, timestamp: 1 });
    emit('mqtt:reconnecting', { sessionId: 'device', attempt: 1 });
    emit('mqtt:error', { sessionId: 'device', message: 'could not connect to broker.test:1883' });
    emit('mqtt:reconnecting', { sessionId: 'device', attempt: 2 });
    expect(mqttSession('device').status).toBe('reconnecting');
    emit('mqtt:error', { sessionId: 'device', message: 'The broker refused the connection: Not authorized' });
    expect(mqttSession('device')).toMatchObject({ status: 'error', error: 'The broker refused the connection: Not authorized' });
    expect(mqttActive('device')).toBe(false);
  });
});
