import { loadMockRoutes, mockServerLog, mockServerStatus, startMockServer, stopMockServer } from '../../backend';
import type { MockRequestLog, MockRequestRef, MockRoute, MockServerStatus } from '../../backend';
import { EMPTY_MOCK_SERVER_STATUS } from '../../wire';
import { DEFAULT_MOCK_PORT, mockRequestRef, mockRoutesSignature } from '../../mockRoutes';
import type { Collection, SavedRequest } from '../../types/models';
import { requestExampleCount, requestExamplesPending } from '../../examples';

const MOCK_MAX_LOG_ENTRIES = 200;
const MOCK_RELOAD_DEBOUNCE_MS = 400;

const storedRoutes = new WeakMap<SavedRequest, MockRoute[]>();
const lastStoredRoutes = new Map<string, MockRoute[]>();
const storedRoutesLoading = new WeakSet<SavedRequest>();
const requestGenerations = new WeakMap<SavedRequest, number>();
let nextGeneration = 0;

function generationOf(request: SavedRequest) {
  let generation = requestGenerations.get(request);
  if (generation === undefined) {
    generation = ++nextGeneration;
    requestGenerations.set(request, generation);
  }
  return generation;
}

function collectionRequests(host: MockServerHost, collectionId: string) {
  return collectionId ? host.requests.filter(request => request.collectionId === collectionId) : [];
}

function loadStoredRoutes(host: MockServerHost, requests: SavedRequest[]) {
  const wanted = requests.filter(request => !storedRoutesLoading.has(request));
  if (!wanted.length) return;
  for (const request of wanted) storedRoutesLoading.add(request);
  queueMicrotask(async () => {
    const refs = wanted.map(request => mockRequestRef(request)).filter((ref): ref is MockRequestRef => Boolean(ref));
    let routes: MockRoute[] = [];
    try {
      routes = await loadMockRoutes(refs);
    } finally {
      const byRequest = new Map<string, MockRoute[]>();
      for (const route of routes) {
        const list = byRequest.get(route.requestId);
        if (list) list.push(route);
        else byRequest.set(route.requestId, [route]);
      }
      for (const request of wanted) {
        storedRoutesLoading.delete(request);
        const list = byRequest.get(request.id) ?? [];
        storedRoutes.set(request, list);
        lastStoredRoutes.set(request.id, list);
      }
      host.mockRoutesVersion += 1;
    }
  });
}

function collectionRoutes(host: MockServerHost, collectionId: string) {
  void host.mockRoutesVersion;
  const routes: MockRoute[] = [];
  const missing: SavedRequest[] = [];
  let pending = false;
  for (const request of collectionRequests(host, collectionId)) {
    if (requestExamplesPending(request)) {
      const stored = storedRoutes.get(request);
      if (stored) {
        routes.push(...stored);
        continue;
      }
      missing.push(request);
      const previous = lastStoredRoutes.get(request.id);
      if (previous) routes.push(...previous);
      else pending = true;
      continue;
    }
    const ref = mockRequestRef(request);
    if (ref) routes.push(...ref.routes);
  }
  if (missing.length) loadStoredRoutes(host, missing);
  return { routes, pending };
}

function collectionPlan(host: MockServerHost, collectionId: string) {
  return collectionRequests(host, collectionId)
    .map(request => mockRequestRef(request))
    .filter((ref): ref is MockRequestRef => Boolean(ref));
}

function planSignature(host: MockServerHost, collectionId: string) {
  return JSON.stringify(collectionRequests(host, collectionId).map(request => {
    const ref = mockRequestRef(request);
    if (!ref) return null;
    if (ref.loaded) return [ref.requestId, ref.requestName, mockRoutesSignature(ref.routes)];
    return [ref.requestId, ref.requestName, ref.method, request.exampleCount ?? 0, generationOf(request)];
  }).filter(Boolean));
}

type MockServerHost = {
  mockRoutesVersion: number;
  collections: Collection[];
  requests: SavedRequest[];
  activeWorkspaceId: string;
  mockServer: MockServerStatus;
  mockServerCollectionId: string;
  mockServerPort: number;
  mockServerSimulateLatency: boolean;
  mockServerBusy: boolean;
  mockServerLog: MockRequestLog[];
  mockServerError: string;
  mockServerRunningSignature: string;
  mockServerReloadTimer: ReturnType<typeof setTimeout> | null;
  topView: string;
  activeRequestId: string;
  mockServerTabOpen: boolean;
  closeFloatingMenus: () => void;
  switchRequest: (id: string) => Promise<void>;
  selectExample: (id: string) => void;
  requestTab: string;
  guardWorkspaceWritable: (action?: string) => boolean;
  openAlertDialog: (title: string, message: string) => Promise<void>;
  mockServerRoutes: () => MockRoute[];
  mockServerLiveSignature: () => string;
  mockServerTargetCollectionId: () => string;
  mockServerRoutesChanged: () => boolean;
  startMockServerForCollection: (options?: { keepLog?: boolean; collectionId?: string }) => Promise<void>;
  reloadMockServerRoutes: () => Promise<void>;
  scheduleMockServerReload: () => void;
  refreshMockServerStatus: () => Promise<void>;
  stopMockServerNow: () => Promise<void>;
};

export const mockServerFeature = {
  openMockServerTab(this: MockServerHost) {
    this.closeFloatingMenus();
    this.mockServerTabOpen = true;
    this.topView = 'mock';
    void this.refreshMockServerStatus();
  },

  closeMockServerTab(this: MockServerHost) {
    this.mockServerTabOpen = false;
    if (this.topView === 'mock') {
      this.topView = this.activeRequestId ? 'request' : 'overview';
    }
  },

  mockServerTargetCollectionId(this: MockServerHost) {
    if (this.mockServerCollectionId) return this.mockServerCollectionId;
    const withExamples = this.collections.find(collection =>
      this.requests.some(request => request.collectionId === collection.id && requestExampleCount(request) > 0));
    return withExamples?.id ?? this.collections[0]?.id ?? '';
  },

  mockServerRoutes(this: MockServerHost) {
    return collectionRoutes(this, this.mockServerTargetCollectionId()).routes;
  },

  mockServerRoutesPending(this: MockServerHost) {
    return collectionRoutes(this, this.mockServerTargetCollectionId()).pending;
  },

  mockServerLiveSignature(this: MockServerHost) {
    if (!this.mockServer.running || !this.mockServer.collectionId) return '';
    return planSignature(this, this.mockServer.collectionId);
  },

  mockServerRouteCount(this: MockServerHost) {
    return this.mockServerRoutes().length;
  },

  mockServerCollectionOptions(this: MockServerHost) {
    return this.collections.map(collection => ({
      id: collection.id,
      name: collection.name,
      exampleCount: this.requests
        .filter(request => request.collectionId === collection.id)
        .reduce((total, request) => total + requestExampleCount(request), 0),
    }));
  },

  async refreshMockServerStatus(this: MockServerHost) {
    try {
      this.mockServer = await mockServerStatus();
      if (this.mockServer.running) {
        this.mockServerLog = (await mockServerLog()).slice(-MOCK_MAX_LOG_ENTRIES);
        if (this.mockServer.collectionId) this.mockServerCollectionId = this.mockServer.collectionId;
        if (this.mockServer.port) this.mockServerPort = this.mockServer.port;
      }
    } catch {
      this.mockServer = EMPTY_MOCK_SERVER_STATUS;
    }
  },

  async startMockServerForCollection(this: MockServerHost, options: { keepLog?: boolean; collectionId?: string } = {}) {
    if (this.mockServerBusy) return;
    if (!this.guardWorkspaceWritable('The mock server')) return;
    const collectionId = options.collectionId || this.mockServerTargetCollectionId();
    if (!collectionId) {
      this.mockServerError = 'Create a collection and capture an example first.';
      return;
    }
    const reloading = Boolean(options.collectionId);
    const requests = collectionPlan(this, collectionId);
    const signature = planSignature(this, collectionId);
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    this.mockServerBusy = true;
    this.mockServerError = '';
    try {
      const status = await startMockServer({
        port: (reloading ? this.mockServer.port : this.mockServerPort) || DEFAULT_MOCK_PORT,
        collectionId,
        collectionName: collection?.name ?? '',
        routes: [],
        requests,
        simulateLatency: this.mockServerSimulateLatency,
      });
      if (reloading && !status.running) {
        this.mockServerError = status.error ?? '';
        await this.refreshMockServerStatus();
        return;
      }
      this.mockServer = status;
      this.mockServerError = status.error ?? '';
      if (status.running) {
        if (!options.keepLog) this.mockServerLog = [];
        if (!options.collectionId) this.mockServerCollectionId = collectionId;
        this.mockServerPort = status.port;
        this.mockServerRunningSignature = signature;
      }
    } catch (error) {
      this.mockServerError = error instanceof Error ? error.message : String(error);
      if (reloading) await this.refreshMockServerStatus();
      else this.mockServer = EMPTY_MOCK_SERVER_STATUS;
    } finally {
      this.mockServerBusy = false;
    }
  },

  async stopMockServerNow(this: MockServerHost) {
    if (this.mockServerBusy) return;
    if (this.mockServerReloadTimer) {
      clearTimeout(this.mockServerReloadTimer);
      this.mockServerReloadTimer = null;
    }
    this.mockServerBusy = true;
    try {
      this.mockServer = await stopMockServer();
      this.mockServerError = '';
      this.mockServerRunningSignature = '';
    } catch (error) {
      this.mockServerError = error instanceof Error ? error.message : String(error);
    } finally {
      this.mockServerBusy = false;
    }
  },

  async toggleMockServer(this: MockServerHost) {
    if (this.mockServer.running) {
      await this.stopMockServerNow();
      return;
    }
    await this.startMockServerForCollection();
  },

  mockServerRoutesChanged(this: MockServerHost) {
    if (!this.mockServer.running || !this.mockServer.collectionId) return false;
    return this.mockServerLiveSignature() !== this.mockServerRunningSignature;
  },

  async reloadMockServerRoutes(this: MockServerHost) {
    if (!this.mockServer.running) return;
    if (this.mockServerBusy) {
      this.scheduleMockServerReload();
      return;
    }
    if (!this.mockServerRoutesChanged()) return;
    await this.startMockServerForCollection({ keepLog: true, collectionId: this.mockServer.collectionId });
  },

  scheduleMockServerReload(this: MockServerHost) {
    if (this.mockServerReloadTimer) {
      clearTimeout(this.mockServerReloadTimer);
      this.mockServerReloadTimer = null;
    }
    if (!this.mockServer.running) return;
    this.mockServerReloadTimer = setTimeout(() => {
      this.mockServerReloadTimer = null;
      void this.reloadMockServerRoutes();
    }, MOCK_RELOAD_DEBOUNCE_MS);
  },

  recordMockRequest(this: MockServerHost, entry: MockRequestLog) {
    const next = [...this.mockServerLog, entry];
    this.mockServerLog = next.length > MOCK_MAX_LOG_ENTRIES
      ? next.slice(next.length - MOCK_MAX_LOG_ENTRIES)
      : next;
  },

  async openMockRouteExample(this: MockServerHost, exampleId: string, requestId = '') {
    if (!exampleId) return;
    const owner = this.requests.find(request => request.id === requestId)
      ?? this.requests.find(request => request.examples?.some(example => example.id === exampleId));
    if (!owner) return;
    await this.switchRequest(owner.id);
    this.requestTab = 'examples';
    this.selectExample(exampleId);
  },

  clearMockServerLog(this: MockServerHost) {
    this.mockServerLog = [];
  },

  selectMockServerCollection(this: MockServerHost, collectionId: string) {
    this.mockServerCollectionId = collectionId;
  },

  setMockServerPort(this: MockServerHost, port: number) {
    this.mockServerPort = Number.isFinite(port) && port > 0 ? Math.floor(port) : DEFAULT_MOCK_PORT;
  },
};
