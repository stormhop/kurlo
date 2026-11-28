import { emptyHttpResponse } from '../../wire';
import type { HttpRequest, HttpResponse } from '../../wire';
import type { MqttConfig, MqttSavedMessage, MqttTopic } from '../../mqtt';
import { mqttPublishPropertiesWire } from '../../mqttWire';
import { mqttActive, mqttConnect, mqttDisconnect, mqttPublish, mqttSession, mqttSubscribe, mqttUnsubscribe } from '../mqtt.svelte';
import type { SavedRequest } from '../../types/models';
import { requestTitleFrom } from '../../utils';

type MqttHost = {
  activeRequestId: string;
  url: string;
  mqtt: MqttConfig;
  bodyContent: string;
  requestError: string;
  requestsById: Map<string, SavedRequest>;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
  normalizeSavedRequestCtx: (input: Partial<SavedRequest>) => SavedRequest;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  syncBackendEnvironment: () => Promise<void>;
  buildRequest: () => HttpRequest;
  recordRequestHistory: (httpResponse: HttpResponse, requestSnapshot?: SavedRequest) => Promise<void>;
  environmentValuesForRequest: (req: Pick<SavedRequest, 'collectionId'>, envValues?: Record<string, string>) => Record<string, string>;
  resolveTemplate: (value: string, values?: Record<string, string>) => string;
};

export const mqttRequestFeature = {
  get mqttConnected(): boolean {
    const host = this as unknown as MqttHost;
    return mqttSession(host.activeRequestId).status === 'connected';
  },

  async mqttToggleConnection(this: MqttHost) {
    const id = this.activeRequestId;
    if (!id) return;
    if (mqttActive(id)) {
      await mqttDisconnect(id);
      return;
    }
    if (!this.url.trim()) {
      this.requestError = 'Enter a broker URL, for example mqtt://localhost:1883';
      return;
    }
    this.requestError = '';
    const request = this.buildRequest();
    const startedAt = Date.now();
    const base = this.snapshotActiveRequest();
    const snapshot = this.normalizeSavedRequestCtx({
      ...base,
      name: !base.nameAuto && base.name && base.name !== 'New Request' ? base.name : requestTitleFrom('MQTT', base.url),
    });
    await this.persistActiveRequestNow();
    try { await this.syncBackendEnvironment(); } catch {  }
    await mqttConnect(id, request, () => {
      void this.recordRequestHistory({ ...emptyHttpResponse(), statusCode: 0, status: 'Connected', duration: Date.now() - startedAt }, snapshot);
    });
  },

  mqttResolve(this: MqttHost, value: string) {
    return this.resolveTemplate(value, this.environmentValuesForRequest(this.snapshotActiveRequest()));
  },

  async mqttPublishCurrent(this: MqttHost & { mqttResolve: (value: string) => string }) {
    const id = this.activeRequestId;
    if (!id) return false;
    const c = this.mqtt;
    const resolve = (value: string) => this.mqttResolve(value);
    return mqttPublish(id, {
      topic: resolve(c.topic),
      payload: resolve(this.bodyContent),
      format: c.format,
      qos: c.qos,
      retain: c.retain,
      properties: c.version === '5' ? mqttPublishPropertiesWire(c.properties, resolve) : {},
    });
  },

  async mqttSetSubscribed(this: MqttHost & { mqttResolve: (value: string) => string }, index: number, enabled: boolean) {
    const config = this.mqtt;
    const topic = config.topics[index];
    if (!topic) return;
    config.topics[index] = { ...topic, enabled };
    const id = this.activeRequestId;
    if (mqttSession(id).status !== 'connected' || !topic.name.trim()) return;
    const name = this.mqttResolve(topic.name).trim();
    if (enabled) {
      const ok = await mqttSubscribe(id, { ...topic, name, enabled } satisfies MqttTopic);
      if (ok || this.activeRequestId !== id || this.mqtt !== config) return;
      const current = config.topics.findIndex(item => item.name === topic.name);
      if (current >= 0 && config.topics[current].enabled) config.topics[current] = { ...config.topics[current], enabled: false };
    } else {
      await mqttUnsubscribe(id, name);
    }
  },

  async mqttRemoveTopic(this: MqttHost & { mqttResolve: (value: string) => string }, index: number) {
    const config = this.mqtt;
    const topic = config.topics[index];
    if (!topic) return;
    config.topics = config.topics.filter((_, i) => i !== index);
    const id = this.activeRequestId;
    if (!topic.enabled || mqttSession(id).status !== 'connected' || !topic.name.trim()) return;
    await mqttUnsubscribe(id, this.mqttResolve(topic.name).trim());
  },

  mqttSaveMessage(this: MqttHost, name: string) {
    const c = this.mqtt;
    const message: MqttSavedMessage = { id: `mqtt-msg-${Date.now().toString(36)}`, name: name.trim() || `Message ${c.savedMessages.length + 1}`, topic: c.topic, payload: this.bodyContent, format: c.format, qos: c.qos, retain: c.retain };
    c.savedMessages = [...c.savedMessages, message];
  },

  mqttLoadMessage(this: MqttHost, id: string) {
    const message = this.mqtt.savedMessages.find(item => item.id === id);
    if (!message) return;
    Object.assign(this.mqtt, { topic: message.topic, format: message.format, qos: message.qos, retain: message.retain });
    this.bodyContent = message.payload;
  },

  mqttDeleteMessage(this: MqttHost, id: string) {
    this.mqtt.savedMessages = this.mqtt.savedMessages.filter(item => item.id !== id);
  },
};
