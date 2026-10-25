import { mockServerLog, mockServerStatus, startMockServer, stopMockServer } from '../../backend';
import type { MockRequestLog, MockServerStatus } from '../../backend';
import { EMPTY_MOCK_SERVER_STATUS } from '../../wire';
import { DEFAULT_MOCK_PORT, mockRoutesForCollection, mockRoutesSignature } from '../../mockRoutes';
import type { Collection, SavedRequest } from '../../types/models';

const MOCK_MAX_LOG_ENTRIES = 200;
const MOCK_RELOAD_DEBOUNCE_MS = 400;

type MockServerHost = {
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
  mockServerRoutes: () => ReturnType<typeof mockRoutesForCollection>;
  mockServerRunningRoutes: () => ReturnType<typeof mockRoutesForCollection>;
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
      this.requests.some(request => request.collectionId === collection.id && request.examples?.length));
    return withExamples?.id ?? this.collections[0]?.id ?? '';
  },

  mockServerRoutes(this: MockServerHost) {
    return mockRoutesForCollection(this.requests, this.mockServerTargetCollectionId());
  },

  mockServerRunningRoutes(this: MockServerHost) {
    return mockRoutesForCollection(this.requests, this.mockServer.collectionId);
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
        .reduce((total, request) => total + (request.examples?.length ?? 0), 0),
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
    const routes = mockRoutesForCollection(this.requests, collectionId);
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    this.mockServerBusy = true;
    this.mockServerError = '';
    try {
      const status = await startMockServer({
        port: (reloading ? this.mockServer.port : this.mockServerPort) || DEFAULT_MOCK_PORT,
        collectionId,
        collectionName: collection?.name ?? '',
        routes,
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
        this.mockServerRunningSignature = mockRoutesSignature(routes);
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
    return mockRoutesSignature(this.mockServerRunningRoutes()) !== this.mockServerRunningSignature;
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

  async openMockRouteExample(this: MockServerHost, exampleId: string) {
    if (!exampleId) return;
    const owner = this.requests.find(request => request.examples?.some(example => example.id === exampleId));
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
