import { docsScreenshotDir } from './config';
import { type Page } from '@playwright/test';

import type { AppBridge, HttpRequest, GrpcRequest, AiRequest, CookieSyncStatus, CookieJarEntry, MockServerStatus, MockRequestLog, WebSocketSendMessage, SocketIOEmitMessage } from '../../src/lib/wire';
import type { RequestStore, SavedRequest, RequestHistoryEntry, Collection, Environment } from '../../src/lib/types/models';

type PartialResponse<T> = T extends object ? { [K in keyof T]?: PartialResponse<T[K]> | (NonNullable<T[K]> extends object ? null : never) } : T;
type AppMethods = Required<AppBridge>;
export type E2EAppBridge = {
  [K in keyof AppMethods]: (...args: Parameters<AppMethods[K]>) => Promise<PartialResponse<Awaited<ReturnType<AppMethods[K]>>>>;
};
export type E2EWindow = Omit<Window, 'go'> & { go: { api: { App: E2EAppBridge } } };
type E2EStore = Partial<RequestStore> & { requests: SavedRequest[]; history: RequestHistoryEntry[]; collections: Collection[]; environments: Environment[] };
export type KurloE2EState = {
  store: E2EStore;
  savedStores: E2EStore[];
  savedViews: Array<{ activeId: string; activeWorkspaceId: string; openIds: string[] }>;
  sentRequests: HttpRequest[];
  sseConnects: Array<{ sessionId: string; request: HttpRequest }>;
  grpcDiscoveries: GrpcRequest[];
  sentMcpRequests: HttpRequest[];
  sentAiRequests: AiRequest[];
  sentGrpcRequests: GrpcRequest[];
  webSocketConnects: Array<{ sessionId: string; request: HttpRequest }>;
  webSocketMessages: Array<{ sessionId: string; message: WebSocketSendMessage }>;
  socketIOConnects: Array<{ sessionId: string; request: HttpRequest }>;
  socketIOEmits: Array<{ sessionId: string; message: SocketIOEmitMessage }>;
  savedFiles: Array<{ name: string; content: string; path: string }>;
  environment: Record<string, string>;
  calls: string[];
  cookies: Record<string, CookieJarEntry[]>;
  historyResponses: Record<string, string>;
  gitStatusOverride: Record<string, unknown> | null;
  gitBranchesOverride: Record<string, unknown> | null;
  failSaves: boolean;
  k6Found: boolean;
  cookieSync: CookieSyncStatus;
  cookieSyncWorkspace: string;
  mockServer: MockServerStatus;
  mockServerLog: MockRequestLog[];
  pendingCancels?: Record<string, () => void>;
  clipboard?: string;
  perfStoreUrl?: string;
  responseGate?: { ready: boolean; release: () => void };
  emit: (eventName: string, payload: unknown) => void;
  followupGate?: { ready: boolean; release: () => void };
};

declare global {
  interface Window {
    __kurloE2E: KurloE2EState;
  }
}

export async function installKurloBridge(page: Page, largeResponseBody = '', runtime = 'browser/e2e', docsMode = Boolean(docsScreenshotDir), storeOverride: Record<string, unknown> | null = null, options: { firstLaunch?: boolean; preserveStorage?: boolean } = {}) {
  await page.addInitScript(({ largeResponseBody, runtime, docsMode, storeOverride, options }) => {
    if (!options.preserveStorage) localStorage.clear();
    if (!options.firstLaunch) localStorage.setItem('kurlo:welcome-seen', '1');
    localStorage.setItem('kurlo:agent-seen', '1');
    localStorage.setItem('kurlo.disclosure.settings-ai-agents', '1');
    localStorage.setItem('kurlo.disclosure.settings-ai-kurlo', '1');

    const emptyGitStatus = {
      isRepo: false,
      workspaceRoot: '',
      root: '',
      missingRoot: false,
      branch: '',
      head: '',
      upstream: '',
      upstreamGone: false,
      ahead: 0,
      behind: 0,
      pushCommitCount: 0,
      pushRemote: '',
      operation: '',
      clean: true,
      files: [],
      remotes: [],
      stashes: [],
      error: '',
      gitMissing: false,
    };
    const docsGitStatus = {
      ...emptyGitStatus,
      isRepo: true,
      workspaceRoot: '/Users/ada/Projects/kurlo-workspace',
      root: '/Users/ada/Projects/kurlo-workspace',
      branch: 'feature/docs-refresh',
      head: '7b3f2a1',
      upstream: 'origin/feature/docs-refresh',
      ahead: 2,
      behind: 1,
      pushCommitCount: 2,
      pushRemote: 'origin',
      clean: false,
      remotes: ['origin'],
      files: [
        { path: 'workspaces/Main/collections/Core-API/requests/Login.yml', index: 'M', worktree: 'M', status: 'modified' },
        { path: 'workspaces/Main/environments/Local.yml', index: 'A', worktree: 'A', status: 'added' },
      ],
      stashes: [{ ref: 'stash@{0}', index: 0, message: 'WIP on feature/docs-refresh: auth experiments' }],
    };
    const currentGitStatus = () => clone(state.gitStatusOverride ?? (docsMode ? docsGitStatus : emptyGitStatus));
    const initialStore: E2EStore = {
      version: 2,
      activeId: '',
      activeWorkspaceId: 'workspace-e2e',
      activeEnvironmentId: '',
      openIds: [],
      folderCollapsed: {},
      workspaces: [{
        id: 'workspace-e2e',
        name: 'E2E Workspace',
        filesystemName: 'E2E-Workspace',
        description: '',
      }],
      collections: [],
      environments: [],
      requests: [],
      history: [],
      workspaceCookies: {},
    };
    const state: KurloE2EState = {
      store: storeOverride ? { ...initialStore, ...storeOverride } : initialStore,
      savedStores: [],
      savedViews: [],
      sentRequests: [],
      sseConnects: [],
      grpcDiscoveries: [],
      sentMcpRequests: [],
      sentAiRequests: [],
      sentGrpcRequests: [],
      webSocketConnects: [],
      webSocketMessages: [],
      socketIOConnects: [],
      socketIOEmits: [],
      savedFiles: [],
      environment: {},
      calls: [],
      cookies: {},
      historyResponses: {},
      emit,
      gitStatusOverride: null,
      gitBranchesOverride: null,
      failSaves: false,
      k6Found: true,
      cookieSync: {
        enabled: false,
        running: false,
        port: 3199,
        url: '',
        pairingCode: '',
        domains: [],
        paired: false,
        connected: false,
        browser: '',
        unreadable: [],
        lastContactAt: 0,
        lastSyncAt: 0,
        lastSyncCount: 0,
        syncedTotal: 0,
        pending: { id: '', browser: '', extensionId: '', code: '', requestedAt: 0, expiresAt: 0 },
        log: [],
        error: '',
      },
      cookieSyncWorkspace: '',
      mockServer: { running: false, port: 0, url: '', collectionId: '', collectionName: '', routeCount: 0, error: '' },
      mockServerLog: [],
    };
    const eventHandlers: Record<string, Array<(payload: unknown) => void>> = {};
    const grpcInventoryMethod = {
      fullName: 'shop.Inventory/GetItem',
      service: 'shop.Inventory',
      name: 'GetItem',
      requestType: 'shop.GetItemRequest',
      responseType: 'shop.GetItemResponse',
      exampleMessage: JSON.stringify({ sku: 'sku-example' }, null, 2),
      clientStreaming: false,
      serverStreaming: false,
    };

    function parseStore(payload: string): E2EStore {
      try {
        return JSON.parse(payload);
      } catch {
        return initialStore;
      }
    }

    function keepStoredExamples(next: E2EStore, previous: E2EStore) {
      const stored = new Map((previous?.requests ?? []).map(request => [request.id, request.examples]));
      for (const request of next.requests ?? []) {
        delete request.exampleCount;
        if (!('examples' in request) && stored.get(request.id)) request.examples = stored.get(request.id);
      }
      return next;
    }

    function clone<T>(value: T): T {
      return JSON.parse(JSON.stringify(value));
    }

    function byteLength(value: unknown) {
      return String(value ?? '').length;
    }

    function emit(eventName: string, payload: unknown) {
      for (const callback of eventHandlers[eventName] ?? []) callback(clone(payload));
    }

    function on<T>(eventName: string, callback: (payload: T) => void) {
      state.calls.push(`event:${eventName}`);
      eventHandlers[eventName] = [...(eventHandlers[eventName] ?? []), callback as (payload: unknown) => void];
      return () => {
        eventHandlers[eventName] = (eventHandlers[eventName] ?? []).filter(item => item !== callback);
      };
    }

    function parseJsonMaybe(text: string, fallback: unknown = null) {
      try {
        return text ? JSON.parse(text) : fallback;
      } catch {
        return fallback;
      }
    }

    async function slowResponse(req: HttpRequest, sequence: number) {
      const url = new URL(req.url);
      for (const param of req.params || []) {
        if (param.enabled !== false && param.key) url.searchParams.append(param.key, param.value);
      }
      const delays = (url.searchParams.get('ms') || '300').split(',').map(Number);
      const delay = delays[(sequence - 1) % delays.length];
      const pendingCancels = state.pendingCancels = state.pendingCancels || {};
      const cancelled = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), delay);
        const cancelLag = Number(url.searchParams.get('cancelLag') || 0);
        pendingCancels[req.requestId] = () => { clearTimeout(timer); setTimeout(() => resolve(true), cancelLag); };
      });
      const empty = { logs: [], tests: [] };
      if (cancelled) {
        return { statusCode: 0, status: '', body: '', headers: [], duration: 0, size: 0, timings: {}, preRequestResult: empty, testResult: empty, connection: {}, error: 'Request canceled' };
      }
      const environmentUpdates: Record<string, string> = {};
      for (const pair of url.searchParams.getAll('setenv')) {
        const [key, value] = pair.split(':');
        environmentUpdates[key] = value;
        state.environment = { ...state.environment, [key]: value };
      }
      const body = JSON.stringify({ sequence, host: url.host });
      return {
        statusCode: 200, status: '200 OK', body,
        headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
        duration: delay, size: body.length, timings: {}, preRequestResult: empty, testResult: empty, connection: {},
        ...(Object.keys(environmentUpdates).length ? { environmentUpdates } : {}),
      };
    }

    function materializeTemplates(req: HttpRequest): HttpRequest {
      if (!req.resolveTemplates) return req;
      const values = req.templateValues || {};
      const resolve = (value: string) => {
        let current = String(value ?? '');
        for (let depth = 0; depth < 20 && current.includes('{{'); depth += 1) {
          const next = current.replace(/\{\{([^{}]*)\}\}/g, (match, raw) => {
            const key = raw.trim();
            return key && Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
          });
          if (next === current) break;
          current = next;
        }
        return current;
      };
      const rows = <T extends { key: string; value: string }>(list: T[]) => (list || []).map(row => ({ ...row, key: resolve(row.key), value: resolve(row.value) }));
      const auth = { ...req.auth };
      for (const field of ['token', 'username', 'password', 'keyName', 'keyValue'] as const) auth[field] = resolve(auth[field]);
      let body = resolve(req.body);
      if (req.graphql) {
        const variables = resolve(req.graphql.variables).trim();
        const payload: { query: string; variables: unknown; operationName?: string } = { query: resolve(req.graphql.query).trim(), variables: variables ? JSON.parse(variables) : {} };
        const operationName = resolve(req.graphql.operationName).trim();
        if (operationName) payload.operationName = operationName;
        body = JSON.stringify(payload);
      }
      return {
        ...req,
        url: resolve(req.url),
        params: rows(req.params),
        headers: rows(req.headers),
        formData: rows(req.formData),
        auth,
        body,
        resolveTemplates: false,
        templateValues: undefined,
        graphql: undefined,
      };
    }

    function jsonResponse(req: HttpRequest) {
      const isGraphQL = req.bodyType === 'graphql' || req.url.includes('/graphql');
      if (req.url.includes('/huge-response')) {
        const line = '{"id":1234567,"name":"Заказ 🚀","note":"lorem ipsum dolor sit amet"},\n';
        const body = line.repeat(Math.ceil(104857600 / line.length)).slice(0, 104857600);
        return {
          statusCode: 200, status: '200 OK', body,
          headers: [{ key: 'Content-Type', value: 'text/plain', enabled: true }],
          duration: 900, size: body.length, timings: {}, preRequestResult: { logs: [], tests: [] }, testResult: { logs: [], tests: [] }, connection: {},
        };
      }
      if (req.url.includes('/binary-response')) {
        return {
          statusCode: 200, status: '200 OK', body: '', bodyOmitted: true, bodyIsBinary: true, bodySniffedType: 'application/zip',
          headers: [{ key: 'Content-Type', value: 'application/octet-stream', enabled: true }],
          duration: 12, size: 104857600, timings: {}, preRequestResult: { logs: [], tests: [] }, testResult: { logs: [], tests: [] }, connection: {},
        };
      }
      if (req.url.includes('/large-response')) {
        const bodyText = largeResponseBody || JSON.stringify({
          Status: 0,
          Categories: Array.from({ length: 115 }, (_, categoryIndex) => ({
            Id: categoryIndex,
            Name: `Category ${categoryIndex}`,
            Fields: { Min: 10, Max: 1000, Currency: 'RUB' },
            Products: Object.fromEntries(Array.from({ length: 9 }, (_, productIndex) => [
              `p${productIndex}`,
              {
                Id: categoryIndex * 100 + productIndex,
                Name: `Product ${categoryIndex}-${productIndex}`,
                Provider: `provider-${productIndex % 6}`,
                Enabled: productIndex % 5 !== 0,
                Amount: productIndex * 10,
              },
            ])),
          })),
        });
        return {
          statusCode: 200,
          status: '200 OK',
          headers: [{ key: 'content-type', value: 'application/json' }],
          body: bodyText,
          duration: 42,
          size: bodyText.length,
          preRequestResult: { tests: [], logs: [] },
          testResult: { tests: [], logs: [] },
        };
      }
      const parsedBody = (() => {
        try {
          return req.body ? JSON.parse(req.body) : null;
        } catch {
          return req.body || null;
        }
      })();
      if (req.url.includes('/login')) {
        state.environment = { ...state.environment, sessionId: 'session-from-login' };
      }
      const body = isGraphQL
        ? {
          data: { me: { id: 'user-123', name: 'Kurlo Tester' } },
          echoedOperation: parsedBody?.operationName ?? null,
        }
        : {
          login: true,
          requestId: 'login-e2e',
          method: req.method,
          url: req.url,
          body: parsedBody,
        };
      const bodyText = JSON.stringify(body, null, 2);
      const testName = req.testScript?.includes('status is 200') ? 'status is 200' : 'backend smoke assertion';
      const preRequestTests = req.preRequestScript?.includes('preRequestMarker')
        ? [{ name: 'pre-request token', passed: false, error: 'expected "failing" to equal "passing"' }]
        : [];
      return {
        statusCode: 200,
        status: '200 OK',
        ...(req.url.includes('/login') ? { environmentUpdates: { sessionId: 'session-from-login' } } : {}),
        headers: [
          { key: 'content-type', value: 'application/json' },
          { key: 'x-kurlo-e2e', value: 'playwright' },
        ],
        body: bodyText,
        duration: isGraphQL ? 31 : 27,
        size: bodyText.length,
        preRequestResult: {
          tests: preRequestTests,
          logs: req.preRequestScript ? ['pre-request script accepted'] : [],
        },
        testResult: {
          tests: [{ name: testName, passed: true }],
          logs: req.testScript ? ['test script accepted'] : [],
        },
      };
    }

    const app: Pick<E2EAppBridge, 'SendRequest' | 'SaveFileDialog'> & Partial<E2EAppBridge> = {
      PerformanceStatus: async () => ({ sampledAt: Date.now(), intervalMs: 1000, mainPid: 42, mainUptimeSeconds: 4951, totalCpuPercent: 0.4, totalMemoryBytes: 299892736, sensorLimited: false, processes: [
        { pid: 42, parentPid: 1, name: 'Kurlo (main)', kind: 'main', role: 'Application', cpuPercent: 0.3, memoryBytes: 58720256, uptimeSeconds: 4951 },
        { pid: 43, parentPid: 42, name: 'Webview', kind: 'webview', role: 'Webview', cpuPercent: 0.1, memoryBytes: 241172480, uptimeSeconds: 4950 },
      ] }),
      StartPerformanceStream: async () => { state.calls.push('StartPerformanceStream'); },
      StopPerformanceStream: async () => { state.calls.push('StopPerformanceStream'); },
      AppInfo: async () => ({ name: 'Kurlo', version: 'dev', runtime, goVersion: 'e2e' }),
      LoadWorkspaceDiagnostics: async () => [],
      LoadRequestStore: async () => {
        if (state.perfStoreUrl) return await (await fetch(state.perfStoreUrl)).text();
        return JSON.stringify(state.store);
      },
      LoadWorkspace: async () => {
        state.calls.push('LoadWorkspace');
        const diagnostics = await (window as E2EWindow).go.api.App.LoadWorkspaceDiagnostics();
        return { payload: await (window as E2EWindow).go.api.App.LoadRequestStore(), diagnostics };
      },
      AckQuit: async () => {
        state.calls.push('AckQuit');
      },
      ConfirmQuit: async () => {
        state.calls.push('ConfirmQuit');
      },
      CancelQuit: async () => {
        state.calls.push('CancelQuit');
      },
      SaveRequestStoreWithError: async (payload) => {
        state.calls.push('SaveRequestStore');
        if (state.failSaves) return { ok: false, error: 'Workspace folder no longer exists.' };
        state.store = keepStoredExamples(parseStore(payload), state.store);
        state.savedStores.push(clone(state.store));
        return { ok: true, error: '' };
      },
      SaveRequestStore: async (payload) => {
        state.calls.push('SaveRequestStore');
        state.store = parseStore(payload);
        state.savedStores.push(clone(state.store));
        return true;
      },
      SaveRequestStoreView: async (payload) => {
        state.calls.push('SaveRequestStoreView');
        if (state.failSaves) return { ok: false, error: 'Workspace folder no longer exists.' };
        const view = JSON.parse(payload) as { activeId: string; activeWorkspaceId: string; openIds: string[] };
        state.store = { ...state.store, activeId: view.activeId, activeWorkspaceId: view.activeWorkspaceId, openIds: view.openIds };
        state.savedViews.push(view);
        return { ok: true, error: '' };
      },
      SaveHistoryResponse: async (id, payload) => {
        state.historyResponses[id] = payload;
        return { stored: true, truncated: false };
      },
      LoadHistoryResponse: async (id) => {
        const payload = state.historyResponses[id];
        return payload ? { stored: true, truncated: false, payload } : { stored: false, truncated: false };
      },
      PruneHistoryResponses: async (keepIds) => {
        const keep = new Set(keepIds);
        for (const id of Object.keys(state.historyResponses)) {
          if (!keep.has(id)) delete state.historyResponses[id];
        }
        return '';
      },
      ClearHistoryResponses: async () => {
        state.historyResponses = {};
        return '';
      },
      GetEnvironment: async () => ({ ...state.environment }),
      SetEnvironment: async (values) => {
        state.environment = { ...values };
      },
      PreviewJWTBearer: async (cfg) => {
        const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
        if (!cfg.jwtSecret && !cfg.jwtPrivateKey) return { token: '', error: `jwt: ${cfg.jwtAlgorithm || 'HS256'} requires a secret` };
        let claims: Record<string, unknown>;
        try { claims = cfg.jwtPayload ? JSON.parse(cfg.jwtPayload) : {}; } catch (error) { return { token: '', error: `jwt: payload is not valid JSON: ${String(error)}` }; }
        const now = Math.floor(Date.now() / 1000);
        const lifetime = Number(cfg.jwtExpiresIn || 0);
        if (lifetime > 0) claims = { iat: now, exp: now + lifetime, ...claims };
        return { token: `${encode({ alg: cfg.jwtAlgorithm || 'HS256', typ: 'JWT' })}.${encode(claims)}.c2lnbmF0dXJl` };
      },
      SendRequest: async (sent) => {
        const req = materializeTemplates(sent);
        state.sentRequests.push(clone(req));
        if (req.url.includes('/slow')) return slowResponse(req, state.sentRequests.length);
        if (req.url.endsWith(':11434/v1/models')) {
          return { ...jsonResponse(req), body: '{"object":"list","data":[{"id":"llama3.2"},{"id":"qwen2.5:7b"}]}' };
        }
        if (req.url.includes('no-models.kurlo.test')) {
          return { ...jsonResponse(req), statusCode: 404, status: '404 Not Found', body: '{"error":{"message":"Not Found"}}' };
        }
        return jsonResponse(req);
      },
      SaveResponseBody: async (requestId, defaultName) => {
        state.calls.push(`SaveResponseBody:${requestId}:${defaultName}`);
        return { savedPath: '/tmp/response.zip' };
      },
      SendRequestToFile: async (req, defaultName) => {
        const response = await app.SendRequest(req);
        const savedPath = await app.SaveFileDialog(defaultName || 'response.json', response.body!);
        return { response, savedPath };
      },
      SSEConnect: async (sessionId, req) => {
        state.sseConnects.push({ sessionId, request: clone(req) });
        const timestamp = Date.now();
        emit('sse:open', {
          sessionId,
          url: req.url,
          statusCode: 200,
          status: '200 OK',
          headers: [
            { key: 'content-type', value: 'text/event-stream' },
            { key: 'x-kurlo-e2e', value: 'sse' },
          ],
          duration: 18,
          timestamp,
        });
        emit('sse:events', {
          sessionId,
          events: [
            {
              id: 'evt-1',
              event: 'notification',
              data: JSON.stringify({ title: 'Build finished', channel: 'deployments' }),
              timestamp: timestamp + 1,
            },
            {
              id: 'evt-2',
              event: 'message',
              data: JSON.stringify({ text: 'Kurlo stream is live' }),
              timestamp: timestamp + 2,
            },
          ],
        });
      },
      SSEDisconnect: async (sessionId) => {
        emit('sse:close', { sessionId, message: 'SSE disconnected by E2E', timestamp: Date.now() });
      },
      SendAiRequest: async (req) => {
        state.sentAiRequests.push(clone(req));
        const lastText = req.messages.at(-1)?.blocks?.[0]?.text ?? '';
        if (lastText === 'Spend my credits') {
          const error = "402 Payment Required: This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 3284. To increase, visit https://openrouter.ai/workspaces/default/keys/0c1ef0c6f3d2c23cb6911e6e4f8a9b0c1d2e3f40 and adjust the key's total limit";
          return {
            steps: [], messages: [], text: '', stopReason: '', hasUsage: false, firstTokenMs: 0, durationMs: 0, tools: [], warnings: [], error,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            http: { ...jsonResponse(req.http), statusCode: 402, status: '402 Payment Required', body: '' },
          };
        }
        const sessionId = req.http.requestId;
        const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
        const firstBlocks = [
          { type: 'text', text: 'Let me check the forecast for Lisbon.' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: '{"city":"Lisbon","date":"2026-10-24"}' },
        ];
        const toolResult = { type: 'tool_result', id: 'call_1', name: 'get_weather', server: 'Weather', text: '{"rain":0.72,"high_c":19}' };
        const secondBlocks = [{ type: 'text', text: 'Bring an umbrella: there is a **72%** chance of rain after noon.\n\n- High: `19 °C`\n- Wind: light, from the west' }];
        const stepHttp = (body: string) => ({ ...jsonResponse(req.http), headers: [{ key: 'Content-Type', value: 'text/event-stream', enabled: true }], body });
        const firstStep = { index: 0, blocks: firstBlocks, toolResults: [toolResult], stopReason: 'tool_use', rawStopReason: 'tool_calls', model: req.model, usage: usage(1180, 64), hasUsage: true, firstTokenMs: 412, durationMs: 1650, http: stepHttp('data: {"choices":[{"delta":{"content":"Let me"}}]}\n\ndata: [DONE]\n') };
        const secondStep = { index: 1, blocks: secondBlocks, toolResults: [], stopReason: 'end_turn', rawStopReason: 'stop', model: req.model, usage: usage(1290, 38), hasUsage: true, firstTokenMs: 380, durationMs: 1200, http: stepHttp('data: {"choices":[{"delta":{"content":"Bring"}}]}\n\ndata: [DONE]\n') };
        emit('ai:deltas', {
          sessionId, deltas: [
            { sessionId, step: 0, index: 0, type: 'text', text: 'Let me check ' },
            { sessionId, step: 0, index: 0, type: 'text', text: 'the forecast for Lisbon.' },
            { sessionId, step: 0, index: 1, type: 'tool_use', id: 'call_1', name: 'get_weather' },
            { sessionId, step: 0, index: 1, type: 'tool_use', input: '{"city":"Lis' },
          ]
        });
        await new Promise(resolve => setTimeout(resolve, 60));
        return {
          steps: [firstStep, secondStep],
          messages: [
            { role: 'assistant', blocks: firstBlocks },
            { role: 'tool', blocks: [toolResult] },
            { role: 'assistant', blocks: secondBlocks },
          ],
          text: secondBlocks[0].text,
          stopReason: 'end_turn',
          usage: usage(2470, 102),
          hasUsage: true,
          firstTokenMs: 412,
          durationMs: 2850,
          tools: [{ name: 'get_weather', originalName: 'get_weather', server: 'Weather', description: '' }],
          warnings: [],
          error: '',
          http: {
            ...stepHttp(''),
            testResult: { tests: [{ name: 'calls the weather tool', passed: true, error: '' }, { name: 'answers fast', passed: false, error: 'expected 1650 to be below 800' }], logs: [], error: '' },
          },
        };
      },
      SendMcpRequest: async (req) => {
        state.sentMcpRequests.push(clone(req));
        const base = {
          http: { ...jsonResponse(req), body: '' },
          serverName: '', serverVersion: '', instructions: '',
          supportedVersions: [], capabilities: [],
          resultType: 'complete', result: '', content: [], structuredContent: '',
          isError: false, tools: [], resources: [], prompts: [],
          nextCursor: '', ttlMs: 0, cacheScope: '',
          inputRequests: '', requestState: '',
          notifications: [], rpcErrorCode: 0, rpcErrorMessage: '', rpcErrorData: '',
          warnings: [], error: '',
        };
        if (req.mcpMethod === 'server/discover' && req.url.includes('legacy')) {
          return {
            ...base,
            serverName: 'E2E Legacy', serverVersion: '0.9.0',
            protocolVersion: '2025-06-18',
            supportedVersions: ['2025-06-18'],
            capabilities: ['tools'],
            warnings: ['This server speaks MCP 2025-06-18, so Kurlo opened a session with initialize and sends later calls in it.'],
          };
        }
        if (req.mcpMethod === 'server/discover') {
          return {
            ...base,
            serverName: 'E2E Weather', serverVersion: '2.1.0',
            protocolVersion: '2026-07-28',
            supportedVersions: ['2026-07-28'],
            capabilities: ['tools'],
            instructions: 'Weather utilities for the end-to-end run.',
          };
        }
        if (req.mcpMethod === 'tools/list') {
          return {
            ...base,
            tools: [{
              name: 'get_weather',
              title: 'Weather lookup',
              description: 'Current weather for a place.',
              inputSchema: '{"type":"object","properties":{"location":{"type":"string"}},"required":["location"]}',
              outputSchema: '',
              annotations: '',
              rejected: '',
            }],
          };
        }
        const raw = '{"jsonrpc":"2.0","id":1,"result":{"resultType":"complete"}}';
        return {
          ...base,
          http: { ...base.http, body: raw },
          content: [{ type: 'text', text: 'It is 21C and clear.', data: '', mimeType: '', uri: '', name: '', description: '' }],
        };
      },
      GrpcDiscover: async (req) => {
        state.grpcDiscoveries.push(clone(req));
        return {
          source: req.useReflection ? 'reflection' : 'proto',
          services: [grpcInventoryMethod.service],
          methods: [grpcInventoryMethod],
        };
      },
      SendGrpcRequest: async (req) => {
        state.sentGrpcRequests.push(clone(req));
        const message = parseJsonMaybe(req.message, {});
        const sku = message?.sku ?? 'sku-example';
        const responseBody = JSON.stringify({ sku, stock: 7, warehouse: 'e2e-main' }, null, 2);
        const timestamp = Date.now();
        return {
          grpcCode: 'OK',
          grpcMessage: '',
          status: 'OK',
          headers: [
            { key: 'content-type', value: 'application/grpc+json' },
            { key: 'x-kurlo-e2e', value: 'grpc' },
          ],
          trailers: [
            { key: 'grpc-status', value: '0' },
            { key: 'x-grpc-trailer', value: 'complete' },
          ],
          messages: [
            { index: 0, direction: 'outgoing', body: req.message, size: byteLength(req.message), timestamp },
            { index: 1, direction: 'incoming', body: responseBody, size: byteLength(responseBody), timestamp: timestamp + 5 },
          ],
          body: responseBody,
          duration: 42,
          size: byteLength(req.message) + byteLength(responseBody),
          timestamp: timestamp + 5,
          error: '',
          method: { ...grpcInventoryMethod, fullName: req.fullMethod || grpcInventoryMethod.fullName },
          preRequestResult: { tests: [], logs: req.preRequestScript ? ['grpc pre-request script accepted'] : [] },
          testResult: { tests: [], logs: req.testScript ? ['grpc test script accepted'] : [] },
        };
      },
      WebSocketConnect: async (sessionId, req) => {
        state.webSocketConnects.push({ sessionId, request: clone(req) });
        emit('ws:open', {
          sessionId,
          url: req.url,
          status: '101 Switching Protocols',
          protocol: 'kurlo-e2e',
          requestHeaders: req.headers ?? [],
          responseHeaders: [
            { key: 'upgrade', value: 'websocket' },
            { key: 'sec-websocket-accept', value: 'mock-accept' },
          ],
          timestamp: Date.now(),
        });
      },
      WebSocketDisconnect: async (sessionId) => {
        emit('ws:close', { sessionId, message: 'Disconnected by E2E', code: 1000, timestamp: Date.now() });
      },
      WebSocketSend: async (sessionId, msg) => {
        state.webSocketMessages.push({ sessionId, message: clone(msg) });
        const payload = msg.type === 'ping' ? 'pong' : `echo:${msg.data}`;
        emit('ws:event', {
          sessionId,
          event: {
            id: `ws-in-${Date.now()}`,
            direction: 'incoming',
            type: msg.type === 'ping' ? 'pong' : msg.type,
            data: payload,
            encoding: msg.encoding ?? 'plain',
            size: byteLength(payload),
            timestamp: Date.now(),
            isSystem: msg.type === 'ping',
            isError: false,
            message: msg.type === 'ping' ? 'pong' : '',
          },
        });
        return { ok: true };
      },
      SocketIOConnect: async (sessionId, req) => {
        const namespace = req.sioNamespace || '/';
        state.socketIOConnects.push({ sessionId, request: clone(req) });
        emit('sio:open', {
          sessionId,
          url: req.url,
          namespace,
          requestHeaders: req.headers ?? [],
          responseHeaders: [{ key: 'x-socket-io', value: 'kurlo-e2e' }],
          statusCode: 101,
          statusText: '101 Switching Protocols',
          timestamp: Date.now(),
        });
      },
      SocketIODisconnect: async (sessionId) => {
        emit('sio:close', { sessionId, message: 'Socket.IO disconnected by E2E', timestamp: Date.now() });
      },
      SocketIOEmit: async (sessionId, msg) => {
        state.socketIOEmits.push({ sessionId, message: clone(msg) });
        const namespace = msg.namespace || '/';
        const timestamp = Date.now();
        emit('sio:event', {
          sessionId,
          event: {
            id: `sio-in-${timestamp}`,
            direction: 'incoming',
            eventName: msg.eventName,
            args: [JSON.stringify({ ok: true, echo: parseJsonMaybe(msg.args?.[0], msg.args?.[0] ?? '') })],
            namespace,
            timestamp,
            isSystem: false,
            isError: false,
          },
        });
        if (msg.ack) {
          emit('sio:ack', {
            sessionId,
            ackId: 1,
            eventName: msg.eventName,
            args: [JSON.stringify({ accepted: true })],
            namespace,
            timestamp: timestamp + 1,
          });
        }
        return { ok: true, ackId: msg.ack ? 1 : undefined };
      },
      CancelRequest: async (requestId) => {
        state.calls.push(`cancel:${requestId}`);
        state.pendingCancels?.[requestId]?.();
      },
      SaveFileDialog: async (name, content) => {
        const path = `/tmp/kurlo-e2e-${state.savedFiles.length + 1}-${name}`;
        state.savedFiles.push({ name, content, path });
        return path;
      },
      OpenFileDialog: async (title: string) => title.includes('CSV or JSON') ? '/workspace/data/users.csv' : '',
      OpenDirectoryDialog: async () => '/exports',
      PreviewLoadTestData: async (path: string) => path.includes('missing')
        ? { path, columns: [], rows: [], total: 0, error: 'data file: no such file' }
        : { path: 'data/users.csv', columns: ['email', 'name'], rows: [['ada@shop.test', 'Ada'], ['grace@shop.test', 'Grace']], total: 2 },
      ExportLoadTestK6Files: async (_payload: string, _inlineSecrets: boolean) => ({
        script: "const DATA = JSON.parse(open('./data.json'));", fileName: 'script.k6.js', warnings: [], steps: [],
        files: [{ path: 'script.k6.js', content: "const DATA = JSON.parse(open('./data.json'));" }, { path: 'data.json', content: '[{"email":"ada@shop.test"}]' }],
      }),
      SaveLoadTestK6Folder: async (payload: string, inlineSecrets: boolean, parent: string) => {
        const parsed = JSON.parse(payload) as { loadTest: { data?: { path: string; mode: string } } };
        state.calls.push(`SaveLoadTestK6Folder:${parent}:${inlineSecrets}:${parsed.loadTest.data?.path}:${parsed.loadTest.data?.mode}`);
        return '';
      },
      ReadTextFile: async () => '',
      DefaultWorkspaceLocation: async () => ({ path: '', error: '' }),
      GitStatus: async () => currentGitStatus(),
      GitCommitLogPage: async (limit, offset) => ({
        git: currentGitStatus(),
        commits: docsMode ? [
          { hash: '7b3f2a19f2d4', shortHash: '7b3f2a1', author: 'Ada Lovelace', date: '2026-06-16', message: 'Document OAuth workspace secrets' },
          { hash: '4a92c81bb114', shortHash: '4a92c81', author: 'Kurlo Bot', date: '2026-06-15', message: 'Refresh generated workspace YAML' },
        ] : [],
        limit,
        offset,
        hasMore: false,
        error: '',
        output: '',
      }),
      GitBranches: async () => state.gitBranchesOverride ? clone(state.gitBranchesOverride) : ({
        ok: true,
        git: currentGitStatus(),
        current: docsMode ? 'feature/docs-refresh' : '',
        localBranches: docsMode ? [
          { name: 'feature/docs-refresh', fullName: 'feature/docs-refresh', remote: '', current: true, upstream: 'origin/feature/docs-refresh' },
          { name: 'main', fullName: 'main', remote: '', current: false, upstream: 'origin/main' },
        ] : [],
        remoteBranches: docsMode ? [
          { name: 'origin/main', fullName: 'refs/remotes/origin/main', remote: 'origin', current: false, upstream: '' },
        ] : [],
        error: '',
        output: '',
      }),
      GitDiff: async (path) => ({
        path,
        diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@\n auth:\n   type: oauth2\n+  oauth2RefreshToken: "{{kurloSecret:request.req-login.auth.oauth2RefreshToken}}"\n settings:\n   timeoutMs: 30000\n`,
        stagedDiff: '',
        unstagedDiff: `+  oauth2RefreshToken: "{{kurloSecret:request.req-login.auth.oauth2RefreshToken}}"`,
        binary: false,
        truncated: false,
        error: '',
      }),
      UseLocalWorkspaceStore: async () => {
        state.calls.push('UseLocalWorkspaceStore');
        state.gitStatusOverride = clone(emptyGitStatus);
        return { ok: true, root: '', payload: JSON.stringify(state.store), git: currentGitStatus(), diagnostics: [], missingSecrets: [], error: '', output: '' };
      },
      GitStageWorkspaceFiles: async () => {
        state.calls.push('GitStageWorkspaceFiles');
        return { ok: true, git: currentGitStatus(), files: [], error: '', output: '' };
      },
      GitCommitWorkspace: async (message) => {
        state.calls.push(`GitCommitWorkspace:${message}`);
        return { ok: true, git: currentGitStatus(), files: [], commitCount: 1, error: '', output: '' };
      },
      GitCheckoutBranch: async (branch) => {
        state.calls.push(`GitCheckoutBranch:${branch}`);
        return { ok: true, root: '/workspace', git: currentGitStatus(), error: '', output: '' };
      },
      GitPullWorkspaceWithStrategy: async (strategy) => {
        state.calls.push(`GitPullWorkspace:${strategy}`);
        return { ok: true, root: '/workspace', git: currentGitStatus(), error: '', output: '' };
      },
      ListCookies: async (workspaceId) => state.cookies[workspaceId] ?? [],
      ClearCookies: async (workspaceId) => {
        state.cookies[workspaceId] = [];
        return [];
      },
      UpsertCookie: async (workspaceId, cookie) => {
        const same = (item: CookieJarEntry) => item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path;
        const next = [...(state.cookies[workspaceId] ?? []).filter(item => !same(item)), cookie];
        state.cookies[workspaceId] = next;
        return { cookies: next, error: '' };
      },
      DeleteCookie: async (workspaceId, cookie) => {
        const next = (state.cookies[workspaceId] ?? []).filter(item => item.name !== cookie.name);
        state.cookies[workspaceId] = next;
        return { cookies: next, error: '' };
      },
      CookieSyncStatus: async () => clone(state.cookieSync),
      InstallBrowserExtension: async (browser) => {
        state.calls.push(`InstallBrowserExtension:${browser}`);
        return { browser, version: '2.5.0', path: `/Users/e2e/Library/Application Support/Kurlo/browser-extension/${browser}` };
      },
      StartCookieSync: async (config, workspaceId) => {
        state.cookieSyncWorkspace = workspaceId;
        state.cookieSync = {
          ...state.cookieSync,
          enabled: true,
          running: true,
          port: config.port || 3199,
          url: `http://127.0.0.1:${config.port || 3199}`,
          pairingCode: `kurlo-${config.port || 3199}-e2epairingtoken0000`,
          domains: config.domains ?? [],
          error: '',
        };
        return clone(state.cookieSync);
      },
      StopCookieSync: async () => {
        state.cookieSync = {
          ...state.cookieSync,
          enabled: false,
          running: false,
          url: '',
          pairingCode: '',
          paired: false,
          connected: false,
          browser: '',
          log: [],
        };
        return clone(state.cookieSync);
      },
      SetCookieSyncDomains: async (domains) => {
        state.cookieSync = { ...state.cookieSync, domains: [...domains].sort(), error: '' };
        return clone(state.cookieSync);
      },
      SetCookieSyncWorkspace: async (workspaceId) => {
        state.cookieSyncWorkspace = workspaceId;
        return clone(state.cookieSync);
      },
      RevokeCookieSyncPairing: async () => {
        state.cookieSync = {
          ...state.cookieSync,
          pairingCode: `kurlo-${state.cookieSync.port}-e2erotatedtoken00000`,
          paired: false,
          connected: false,
          browser: '',
        };
        return clone(state.cookieSync);
      },
      ApproveCookieSyncPairing: async (requestId) => {
        state.calls.push(`ApproveCookieSyncPairing:${requestId}`);
        const browser = state.cookieSync.pending.browser;
        state.cookieSync = {
          ...state.cookieSync,
          paired: true,
          connected: true,
          browser,
          pending: { id: '', browser: '', extensionId: '', code: '', requestedAt: 0, expiresAt: 0 },
        };
        return clone(state.cookieSync);
      },
      DenyCookieSyncPairing: async (requestId) => {
        state.calls.push(`DenyCookieSyncPairing:${requestId}`);
        state.cookieSync = {
          ...state.cookieSync,
          paired: false,
          connected: false,
          pending: { id: '', browser: '', extensionId: '', code: '', requestedAt: 0, expiresAt: 0 },
        };
        return clone(state.cookieSync);
      },
      K6Info: async (path: string) => {
        state.calls.push(`K6Info:${path}`);
        return state.k6Found
          ? { found: true, path: '/usr/local/bin/k6', version: 'v1.3.0' }
          : { found: false, path: '', version: '', error: 'k6 is not installed or not on the PATH.' };
      },
      LoadTestTargets: async () => ['shop.kurlo.test'],
      StartLoadRun: async (payload: string) => {
        const parsed = JSON.parse(payload) as { loadTest: { id: string } };
        state.calls.push(`StartLoadRun:${parsed.loadTest.id}`);
        return { running: true, stopping: false, loadTestId: parsed.loadTest.id, collectionId: '', startedAt: Date.now(), plannedMs: 60000, dashboardUrl: '', k6Version: 'v1.3.0', progress: { elapsedMs: 0, vus: 0, maxVUs: 0, iterations: 0, interrupted: 0 } };
      },
      StopLoadRun: async () => {
        state.calls.push('StopLoadRun');
        return { running: true, stopping: true, loadTestId: '', collectionId: '', startedAt: 0, plannedMs: 0, dashboardUrl: '', k6Version: '', progress: { elapsedMs: 0, vus: 0, maxVUs: 0, iterations: 0, interrupted: 0 } };
      },
      LoadRunStatus: async () => ({ running: false, stopping: false, loadTestId: '', collectionId: '', startedAt: 0, plannedMs: 0, dashboardUrl: '', k6Version: '', progress: { elapsedMs: 0, vus: 0, maxVUs: 0, iterations: 0, interrupted: 0 } }),
      LoadRunLog: async () => [],
      LastLoadRun: async () => ({ loadTestId: '', thresholds: [], steps: [] }),
      LoadRunSummaryJSON: async (loadTestId: string) => `{"metrics":{},"loadTestId":"${loadTestId}"}`,
      OpenLoadRunReport: async (loadTestId: string) => {
        state.calls.push(`OpenLoadRunReport:${loadTestId}`);
        return '';
      },
      ExportLoadTestK6: async (payload: string, inlineSecrets: boolean) => {
        const parsed = JSON.parse(payload) as { loadTest: { id: string; name: string }; requests: Array<{ name: string }> };
        state.calls.push(`ExportLoadTestK6:${parsed.loadTest.name}:${parsed.requests.map(request => request.name).join(',')}:${inlineSecrets}`);
        if (parsed.loadTest.id === 'lt-docs') {
          return {
            script: `import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    main: {
      executor: 'ramping-vus',
      stages: [
        { duration: '2m', target: 50 },
        { duration: '10m', target: 50 },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

let token;
export default function () {
  if (!token) {
    const login = http.post('https://shop.kurlo.test/login',
      JSON.stringify({ email: 'ada@shop.test', password: __ENV.password }),
      { headers: { 'Content-Type': 'application/json' } });
    token = login.json('access_token');
  }
  const orders = http.get('https://shop.kurlo.test/orders',
    { headers: { Authorization: 'Bearer ' + token } });
  check(orders, { 'status is 200': (r) => r.status === 200 });
  sleep(0.5 + Math.random());
}
`,
            fileName: 'checkout-flow.k6.js',
            warnings: [{ level: 'info', message: 'password is secret and is not written into the script. Pass it when running: k6 run -e password=…' }],
          };
        }
        return {
          script: `import http from 'k6/http';\n\nexport default function () {\n  http.get('https://shop.kurlo.test/login');\n}\n`,
          fileName: 'login-load-test.k6.js',
          warnings: [
            { level: 'warn', step: 2, message: 'The pre-request and test scripts of List orders are not exported. Add checks to the step instead.' },
            { level: 'info', message: 'password is secret and is not written into the script. Pass it when running: k6 run -e password=…' },
          ],
        };
      },
      LoadMockRoutes: async (refs) => {
        const stored = new Map((state.store.requests ?? []).map(request => [request.id, request]));
        return clone(refs.flatMap(ref => (stored.get(ref.requestId)?.examples ?? []).map(example => ({
          exampleId: example.id, exampleName: example.name, requestId: ref.requestId, requestName: ref.requestName,
          method: example.snapshot?.method || ref.method || 'GET', pathTemplate: example.match?.pathTemplate || '/',
          query: Object.keys(example.match?.query ?? {}).sort().map(key => ({ key, value: example.match!.query![key], enabled: true })),
          statusCode: example.response?.statusCode || 200, status: example.response?.status ?? '', headers: [], body: '', bodyMediaType: '', delayMs: 0,
        }))));
      },
      StartMockServer: async (config) => {
        const stored = new Map((state.store.requests ?? []).map(request => [request.id, request]));
        const routeCount = config.routes.length + (config.requests ?? []).reduce((total, ref) => total + (ref.loaded ? ref.routes.length : (stored.get(ref.requestId)?.examples ?? []).length), 0);
        state.calls.push(`StartMockServer:${config.collectionName}:${routeCount}`);
        state.mockServer = {
          running: true,
          port: config.port,
          url: `http://127.0.0.1:${config.port}`,
          collectionId: config.collectionId,
          collectionName: config.collectionName,
          routeCount,
          error: '',
        };
        return clone(state.mockServer);
      },
      StopMockServer: async () => {
        state.calls.push('StopMockServer');
        state.mockServer = { running: false, port: 0, url: '', collectionId: '', collectionName: '', routeCount: 0, error: '' };
        return clone(state.mockServer);
      },
      MockServerStatus: async () => clone(state.mockServer),
      MockServerLog: async () => clone(state.mockServerLog),
      ClipboardSet: async (text) => {
        state.calls.push(`clipboard:${text.length}`);
        state.clipboard = text;
      },
      ClipboardGet: async () => state.clipboard ?? '',
      RevealWorkspaceItem: async (kind, id) => {
        state.calls.push(`reveal:${kind}:${id}`);
        return '';
      },
      CheckForUpdate: async () => ({ info: null, error: '' }),
    };

    state.emit = emit;
    window.__kurloE2E = state;
    (window as E2EWindow).go = { api: { App: app as E2EAppBridge } };
    window.runtime = {
      EventsOn: on,
      BrowserOpenURL: (url) => state.calls.push(`open:${url}`),
      WindowIsMaximised: async () => false,
      WindowMinimise: async () => { },
      WindowToggleMaximise: async () => { },
      Quit: () => { state.calls.push('runtime:Quit'); },
      WindowSetLightTheme: async () => { },
      WindowSetDarkTheme: async () => { },
      WindowSetBackgroundColour: async () => { },
    };
  }, { largeResponseBody, runtime, docsMode, storeOverride, options });
}
