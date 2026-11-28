import { SvelteMap } from 'svelte/reactivity';
import { listenRuntime } from '../runtimeEvents';
import type { MqttMessage, MqttTopic } from '../mqtt';
import type { HttpRequest } from '../wire';

export type MqttStatus = 'idle' | 'connecting' | 'reconnecting' | 'connected' | 'disconnected' | 'error';

export type MqttSession = {
  status: MqttStatus;
  url: string;
  clientId: string;
  version: string;
  connectedAt: number;
  error: string;
  messages: MqttMessage[];
  subscribed: string[];
};

const MAX_MESSAGES = 5000;
const MAX_LOG_CHARS = 32 * 1024 * 1024;
let counter = 0;

export const mqttSessions = new SvelteMap<string, MqttSession>();

function empty(): MqttSession {
  return { status: 'idle', url: '', clientId: '', version: '', connectedAt: 0, error: '', messages: [], subscribed: [] };
}

export function mqttSession(id: string): MqttSession {
  return mqttSessions.get(id) ?? empty();
}

function patch(id: string, next: Partial<MqttSession>) {
  mqttSessions.set(id, { ...mqttSession(id), ...next });
}

function system(text: string, isError = false): MqttMessage {
  return { id: `mqtt-local-${++counter}`, direction: 'system', size: 0, qos: 0, timestamp: Date.now(), isSystem: true, isError, message: text };
}

export function mqttAddMessages(id: string, incoming: MqttMessage[]) {
  const session = mqttSessions.get(id);
  if (!session || !incoming.length) return;
  let messages = session.messages.concat(incoming);
  if (messages.length > MAX_MESSAGES) messages = messages.slice(messages.length - MAX_MESSAGES);
  let chars = 0;
  let first = messages.length;
  while (first > 0 && chars + (messages[first - 1].payload?.length ?? 0) <= MAX_LOG_CHARS) chars += messages[--first].payload?.length ?? 0;
  if (first > 0) messages = messages.slice(first);
  let subscribed = session.subscribed;
  for (const message of incoming) {
    if (!message.isSystem || message.isError || !message.topic) continue;
    if (message.message?.startsWith('Subscribed to ') && !subscribed.includes(message.topic)) subscribed = [...subscribed, message.topic];
    if (message.message?.startsWith('Unsubscribed from ')) subscribed = subscribed.filter(topic => topic !== message.topic);
  }
  mqttSessions.set(id, { ...session, messages, subscribed });
}

let listening = false;
const openHandlers: Record<string, () => void> = {};

export function initMqttListeners() {
  if (listening || !window.runtime?.EventsOn) return;
  listening = true;
  listenRuntime<{ sessionId: string; url: string; clientId: string; version: string; sessionPresent: boolean; timestamp: number }>('mqtt:open', ev => {
    const session = mqttSessions.get(ev.sessionId);
    if (!session) return;
    patch(ev.sessionId, { status: 'connected', url: ev.url, clientId: ev.clientId, version: ev.version, connectedAt: ev.timestamp, error: '', subscribed: [] });
    mqttAddMessages(ev.sessionId, [system(`Connected to ${ev.url} as ${ev.clientId} (MQTT ${ev.version}${ev.sessionPresent ? ', session resumed' : ''})`)]);
    openHandlers[ev.sessionId]?.();
    delete openHandlers[ev.sessionId];
  });
  listenRuntime<{ sessionId: string; messages: MqttMessage[] }>('mqtt:messages', ev => mqttAddMessages(ev.sessionId, ev.messages ?? []));
  listenRuntime<{ sessionId: string; message: string }>('mqtt:close', ev => {
    if (!mqttSessions.has(ev.sessionId)) return;
    mqttAddMessages(ev.sessionId, [system(ev.message || 'Disconnected')]);
    patch(ev.sessionId, { status: 'disconnected', subscribed: [] });
  });
  listenRuntime<{ sessionId: string; message: string }>('mqtt:error', ev => {
    if (!mqttSessions.has(ev.sessionId)) return;
    mqttAddMessages(ev.sessionId, [system(ev.message, true)]);
    patch(ev.sessionId, { status: 'error', error: ev.message, subscribed: [] });
  });
  listenRuntime<{ sessionId: string; attempt: number }>('mqtt:reconnecting', ev => {
    if (!mqttSessions.has(ev.sessionId)) return;
    mqttAddMessages(ev.sessionId, [system(`Reconnecting (attempt ${ev.attempt})…`)]);
    patch(ev.sessionId, { status: 'reconnecting', subscribed: [] });
  });
}

function bridge() {
  return window.go?.api?.App;
}

export async function mqttConnect(id: string, req: HttpRequest, onOpen?: () => void) {
  initMqttListeners();
  mqttSessions.set(id, { ...empty(), status: 'connecting', url: req.url, messages: mqttSession(id).messages });
  if (onOpen) openHandlers[id] = onOpen;
  const app = bridge();
  if (!app?.MqttConnect) {
    const message = 'MQTT connections require the desktop app';
    mqttAddMessages(id, [system(message, true)]);
    patch(id, { status: 'error', error: message });
    return;
  }
  mqttAddMessages(id, [system(`Connecting to ${req.url}…`)]);
  await app.MqttConnect(id, req);
}

export async function mqttDisconnect(id: string) {
  delete openHandlers[id];
  await bridge()?.MqttDisconnect?.(id);
  if (mqttSessions.has(id) && mqttSession(id).status !== 'disconnected') {
    if (mqttSession(id).status !== 'connected') mqttAddMessages(id, [system('Disconnected')]);
    patch(id, { status: 'disconnected', subscribed: [] });
  }
}

function report(id: string, result: { ok: boolean; error?: string } | undefined, fallback: string) {
  if (result?.ok) return true;
  mqttAddMessages(id, [system(result?.error || fallback, true)]);
  return false;
}

export async function mqttPublish(id: string, msg: { topic: string; payload: string; format: string; qos: number; retain: boolean; properties: unknown }) {
  const result = await bridge()?.MqttPublish?.(id, msg as never);
  return report(id, result, 'Could not publish the message');
}

export async function mqttSubscribe(id: string, topic: MqttTopic) {
  const result = await bridge()?.MqttSubscribe?.(id, topic as never);
  return report(id, result, 'Could not subscribe');
}

export async function mqttUnsubscribe(id: string, topic: string) {
  const result = await bridge()?.MqttUnsubscribe?.(id, topic);
  return report(id, result, 'Could not unsubscribe');
}

export function mqttClearMessages(id: string) {
  if (mqttSessions.has(id)) patch(id, { messages: [] });
}

export function mqttForget(id: string) {
  const session = mqttSessions.get(id);
  if (session && ['connected', 'connecting', 'reconnecting'].includes(session.status)) void mqttDisconnect(id);
  mqttSessions.delete(id);
}

export function mqttActive(id: string) {
  const status = mqttSessions.get(id)?.status;
  return status === 'connected' || status === 'connecting' || status === 'reconnecting';
}
