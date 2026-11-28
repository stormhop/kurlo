import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyHttpRequest } from '../lib/wire';
import { mqttConfig } from '../lib/mqtt';

const mqtt = vi.hoisted(() => ({
  status: 'connected',
  connect: vi.fn(async (_id: string, _request: unknown, _onOpen?: () => void) => {}),
  subscribe: vi.fn(async (_id: string, _topic: unknown) => true),
  unsubscribe: vi.fn(async (_id: string, _name: string) => true),
}));
const backend = vi.hoisted(() => ({
  webSocketConnect: vi.fn(async (_id: string, _request: unknown) => {}),
  socketIOConnect: vi.fn(async (_id: string, _request: unknown) => {}),
  webSocketDisconnect: vi.fn(async (_id: string) => {}),
  socketIODisconnect: vi.fn(async (_id: string) => {}),
}));

vi.mock('../lib/stores/mqtt.svelte', () => ({
  mqttActive: () => false,
  mqttConnect: mqtt.connect,
  mqttDisconnect: vi.fn(),
  mqttPublish: vi.fn(),
  mqttSession: () => ({ status: mqtt.status }),
  mqttSubscribe: mqtt.subscribe,
  mqttUnsubscribe: mqtt.unsubscribe,
}));
vi.mock('../lib/backend', async importOriginal => ({
  ...(await importOriginal<object>()),
  webSocketConnect: backend.webSocketConnect,
  socketIOConnect: backend.socketIOConnect,
  webSocketDisconnect: backend.webSocketDisconnect,
  socketIODisconnect: backend.socketIODisconnect,
}));

const { mqttRequestFeature } = await import('../lib/stores/features/mqttRequest');
const { websocketFeature } = await import('../lib/stores/features/websocket');
const { socketioFeature } = await import('../lib/stores/features/socketio');

type Tab = { id: string; url: string; topics: string[] };

function host(tabs: Tab[]) {
  const configs = new Map(tabs.map(tab => [tab.id, mqttConfig({ topics: tab.topics.map(name => ({ name, qos: 0, enabled: true })) } as never)]));
  const state: Record<string, any> = {
    ...mqttRequestFeature,
    ...websocketFeature,
    ...socketioFeature,
    activeRequestId: tabs[0].id,
    url: tabs[0].url,
    mqtt: configs.get(tabs[0].id),
    requestType: 'graphql',
    requestError: '',
    bodyContent: '',
    sioNamespace: '/',
    webSocketSessions: new Map(),
    socketIOSessions: new Map(),
    _wsPendingMessages: new Map(),
    _wsStartedAt: new Map(),
    _wsHistoryRecorded: new Set(),
    _wsTouchedAt: new Map(),
    _sioPendingMessages: new Map(),
    _sioStartedAt: new Map(),
    _sioHistoryRecorded: new Set(),
    _sioTouchedAt: new Map(),
    switchTo(id: string) {
      const tab = tabs.find(item => item.id === id)!;
      state.activeRequestId = tab.id;
      state.url = tab.url;
      state.mqtt = configs.get(tab.id);
    },
    snapshotActiveRequest: () => ({ id: state.activeRequestId, url: state.url, name: state.activeRequestId, nameAuto: false, collectionId: 'c' }),
    normalizeSavedRequestCtx: (input: object) => input,
    persistActiveRequestNow: async () => {},
    syncBackendEnvironment: async () => { state.switchTo(tabs[1].id); },
    buildRequest: () => ({ ...emptyHttpRequest(), url: state.url }),
    recordRequestHistory: async () => {},
    environmentValuesForRequest: () => ({}),
    resolveTemplate: (value: string) => value,
    headerValidationErrorForRequest: () => '',
    graphQLSubscriptionError: () => '',
    setActiveResponse: () => {},
    cleanupRealtimeSessions: () => {},
  };
  return { state, configs };
}

const alpha = { id: 'alpha', url: 'mqtt://alpha.test', topics: ['events'] };
const bravo = { id: 'bravo', url: 'mqtt://bravo.test', topics: ['events'] };

describe('realtime requests when the tab changes mid-action', () => {
  beforeEach(() => {
    mqtt.status = 'connected';
    vi.clearAllMocks();
  });

  it('connects MQTT with the request that was open when Connect was pressed', async () => {
    const { state } = host([alpha, bravo]);
    mqtt.status = 'idle';
    await state.mqttToggleConnection();
    expect(mqtt.connect).toHaveBeenCalledWith('alpha', expect.objectContaining({ url: 'mqtt://alpha.test' }), expect.any(Function));
  });

  it('subscribes GraphQL and connects Socket.IO with the request that started it', async () => {
    const graphql = host([{ ...alpha, url: 'wss://alpha.test/graphql' }, { ...bravo, url: 'wss://bravo.test/graphql' }]).state;
    await graphql.webSocketConnect();
    expect(backend.webSocketConnect).toHaveBeenCalledWith('alpha', expect.objectContaining({ url: 'wss://alpha.test/graphql', graphqlSubscription: true }));

    const socket = host([{ ...alpha, url: 'http://alpha.test' }, { ...bravo, url: 'http://bravo.test' }]).state;
    await socket.socketIOConnect();
    expect(backend.socketIOConnect).toHaveBeenCalledWith('alpha', expect.objectContaining({ url: 'http://alpha.test' }));
  });

  it('does not open a GraphQL subscription or Socket.IO connection cancelled while it was being prepared', async () => {
    const graphql = host([{ ...alpha, url: 'wss://alpha.test/graphql' }, bravo]).state;
    graphql.syncBackendEnvironment = async () => { await graphql.webSocketDisconnect(); };
    await graphql.webSocketConnect();
    expect(backend.webSocketConnect).not.toHaveBeenCalled();
    expect(graphql.webSocketSessions.get('alpha')?.status).toBe('idle');

    const socket = host([{ ...alpha, url: 'http://alpha.test' }, bravo]).state;
    socket.syncBackendEnvironment = async () => { await socket.socketIODisconnect(); };
    await socket.socketIOConnect();
    expect(backend.socketIOConnect).not.toHaveBeenCalled();
  });

  it('removes an MQTT topic from its own request when the tab changes before the broker answers', async () => {
    const { state, configs } = host([alpha, bravo]);
    mqtt.unsubscribe.mockImplementationOnce(async () => { state.switchTo('bravo'); return true; });
    await state.mqttRemoveTopic(0);
    expect(mqtt.unsubscribe).toHaveBeenCalledWith('alpha', 'events');
    expect(configs.get('alpha')!.topics).toEqual([]);
    expect(configs.get('bravo')!.topics.map(topic => topic.name)).toEqual(['events']);
  });

  it('leaves the other request alone when a subscription is refused after the tab changed', async () => {
    const { state, configs } = host([{ ...alpha, topics: [] }, bravo]);
    state.mqtt.topics = [{ name: 'events', qos: 0, enabled: false }];
    mqtt.subscribe.mockImplementationOnce(async () => { state.switchTo('bravo'); return false; });
    await state.mqttSetSubscribed(0, true);
    expect(configs.get('bravo')!.topics[0].enabled).toBe(true);
  });

  it('unticks a refused subscription on the request that asked for it', async () => {
    const { state } = host([{ ...alpha, topics: [] }, bravo]);
    state.mqtt.topics = [{ name: 'events', qos: 0, enabled: false }];
    mqtt.subscribe.mockImplementationOnce(async () => false);
    await state.mqttSetSubscribed(0, true);
    expect(state.mqtt.topics[0].enabled).toBe(false);
  });
});
