import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

type KurloE2EState = {
  store: Record<string, unknown>;
  savedStores: Record<string, unknown>[];
  savedViews: Array<{ activeId: string; activeWorkspaceId: string; openIds: string[] }>;
  sentRequests: Array<Record<string, unknown>>;
  sseConnects: Array<Record<string, unknown>>;
  grpcDiscoveries: Array<Record<string, unknown>>;
  sentMcpRequests: Array<Record<string, unknown>>;
  sentAiRequests: Array<Record<string, unknown>>;
  sentGrpcRequests: Array<Record<string, unknown>>;
  webSocketConnects: Array<Record<string, unknown>>;
  webSocketMessages: Array<Record<string, unknown>>;
  socketIOConnects: Array<Record<string, unknown>>;
  socketIOEmits: Array<Record<string, unknown>>;
  savedFiles: Array<{ name: string; content: string; path: string }>;
  environment: Record<string, string>;
  calls: string[];
};

declare global {
  interface Window {
    __kurloE2E: KurloE2EState;
  }
}

const stepPauseMs = Number.parseInt(process.env.KURLO_E2E_STEP_PAUSE_MS ?? '0', 10);
const responseScreenshotPath = process.env.KURLO_E2E_RESPONSE_SCREENSHOT ?? '';
const docsScreenshotDir = process.env.KURLO_DOCS_SCREENSHOT_DIR ?? '';
const readmeScreenshotPath = process.env.KURLO_README_SCREENSHOT ?? '';

const DOCS_VIEWPORT = { width: 1200, height: 780 };
const DOCS_CROP_PADDING = 26;
const DOCS_DARK_VARIANTS = new Set(['request-editor', 'request-mcp', 'request-ai']);

async function docsDialogClip(page: Page) {
  const dialog = page.locator('[role="dialog"][aria-modal="true"]').first();
  if (!(await dialog.isVisible().catch(() => false))) return undefined;
  const box = await dialog.boundingBox();
  if (!box) return undefined;
  const viewport = page.viewportSize() ?? DOCS_VIEWPORT;
  const x = Math.max(0, Math.round(box.x) - DOCS_CROP_PADDING);
  const y = Math.max(0, Math.round(box.y) - DOCS_CROP_PADDING);
  return {
    x,
    y,
    width: Math.min(viewport.width - x, Math.round(box.width) + DOCS_CROP_PADDING * 2),
    height: Math.min(viewport.height - y, Math.round(box.height) + DOCS_CROP_PADDING * 2),
  };
}

async function docsElementClip(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) return undefined;
  const viewport = page.viewportSize() ?? DOCS_VIEWPORT;
  const x = Math.max(0, Math.round(box.x) - DOCS_CROP_PADDING);
  const y = Math.max(0, Math.round(box.y) - DOCS_CROP_PADDING);
  return {
    x,
    y,
    width: Math.min(viewport.width - x, Math.round(box.width) + DOCS_CROP_PADDING * 2),
    height: Math.min(viewport.height - y, Math.round(box.height) + DOCS_CROP_PADDING * 2),
  };
}

async function captureDocsScreenshot(page: Page, name: string, cropTo?: Locator) {
  if (!docsScreenshotDir) return;
  await waitForTransientToasts(page);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const frame = [
      document.documentElement,
      document.body,
      document.getElementById('app'),
      document.querySelector('main.shell'),
    ];
    for (const element of frame) {
      if (!(element instanceof HTMLElement)) continue;
      element.scrollTop = 0;
      element.scrollLeft = 0;
    }
  });
  const clip = (await docsDialogClip(page)) ?? (cropTo ? await docsElementClip(page, cropTo) : undefined);
  await page.screenshot({
    path: join(docsScreenshotDir, `${name}.png`),
    animations: 'disabled',
    ...(clip ? { clip } : {}),
  });
  if (!DOCS_DARK_VARIANTS.has(name)) return;
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({
    path: join(docsScreenshotDir, `${name}-dark.png`),
    animations: 'disabled',
    ...(clip ? { clip } : {}),
  });
  await page.emulateMedia({ colorScheme: 'light' });
}

async function tourPause(page: Page, label: string) {
  if (!Number.isFinite(stepPauseMs) || stepPauseMs <= 0) return;
  await page.evaluate((text) => {
    let node = document.getElementById('kurlo-e2e-tour-label');
    if (!node) {
      node = document.createElement('div');
      node.id = 'kurlo-e2e-tour-label';
      Object.assign(node.style, {
        position: 'fixed',
        zIndex: '2147483647',
        top: '16px',
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '10px 14px',
        borderRadius: '8px',
        background: 'rgba(16, 20, 28, 0.94)',
        color: '#fff',
        font: '600 13px system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
        boxShadow: '0 10px 28px rgba(0, 0, 0, 0.28)',
        pointerEvents: 'none',
      });
      document.body.appendChild(node);
    }
    node.textContent = text;
  }, label);
  await page.waitForTimeout(stepPauseMs);
}

async function installKurloBridge(page: Page, largeResponseBody = '', runtime = 'browser/e2e', docsMode = Boolean(docsScreenshotDir)) {
  await page.addInitScript(({ largeResponseBody, runtime, docsMode }) => {
    localStorage.clear();

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
    const initialStore = {
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
    const state = {
      store: initialStore,
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
      gitStatusOverride: null,
      gitBranchesOverride: null,
      failSaves: false,
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
    const eventHandlers = {};
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

    function parseStore(payload) {
      try {
        return JSON.parse(payload);
      } catch {
        return initialStore;
      }
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function byteLength(value) {
      return String(value ?? '').length;
    }

    function emit(eventName, payload) {
      for (const callback of eventHandlers[eventName] ?? []) callback(clone(payload));
    }

    function on(eventName, callback) {
      state.calls.push(`event:${eventName}`);
      eventHandlers[eventName] = [...(eventHandlers[eventName] ?? []), callback];
      return () => {
        eventHandlers[eventName] = (eventHandlers[eventName] ?? []).filter(item => item !== callback);
      };
    }

    function parseJsonMaybe(text, fallback = null) {
      try {
        return text ? JSON.parse(text) : fallback;
      } catch {
        return fallback;
      }
    }

    async function slowResponse(req, sequence) {
      const url = new URL(req.url);
      for (const param of req.params || []) {
        if (param.enabled !== false && param.key) url.searchParams.append(param.key, param.value);
      }
      const delays = (url.searchParams.get('ms') || '300').split(',').map(Number);
      const delay = delays[(sequence - 1) % delays.length];
      state.pendingCancels = state.pendingCancels || {};
      const cancelled = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), delay);
        const cancelLag = Number(url.searchParams.get('cancelLag') || 0);
        state.pendingCancels[req.requestId] = () => { clearTimeout(timer); setTimeout(() => resolve(true), cancelLag); };
      });
      const empty = { logs: [], tests: [] };
      if (cancelled) {
        return { statusCode: 0, status: '', body: '', headers: [], duration: 0, size: 0, timings: {}, preRequestResult: empty, testResult: empty, connection: {}, error: 'Request canceled' };
      }
      const environmentUpdates = {};
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

    function materializeTemplates(req) {
      if (!req.resolveTemplates) return req;
      const values = req.templateValues || {};
      const resolve = (value) => {
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
      const rows = (list) => (list || []).map(row => ({ ...row, key: resolve(row.key), value: resolve(row.value) }));
      const auth = { ...req.auth };
      for (const field of ['token', 'username', 'password', 'keyName', 'keyValue']) auth[field] = resolve(auth[field]);
      let body = resolve(req.body);
      if (req.graphql) {
        const variables = resolve(req.graphql.variables).trim();
        const payload = { query: resolve(req.graphql.query).trim(), variables: variables ? JSON.parse(variables) : {} };
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

    function jsonResponse(req) {
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
      return {
        statusCode: 200,
        status: '200 OK',
        headers: [
          { key: 'content-type', value: 'application/json' },
          { key: 'x-kurlo-e2e', value: 'playwright' },
        ],
        body: bodyText,
        duration: isGraphQL ? 31 : 27,
        size: bodyText.length,
        preRequestResult: {
          tests: [],
          logs: req.preRequestScript ? ['pre-request script accepted'] : [],
        },
        testResult: {
          tests: [{ name: testName, passed: true }],
          logs: req.testScript ? ['test script accepted'] : [],
        },
      };
    }

    const app = {
      AppInfo: async () => ({ name: 'Kurlo', version: 'dev', runtime, goVersion: 'e2e' }),
      LoadWorkspaceDiagnostics: async () => [],
      LoadRequestStore: async () => {
        if (state.perfStoreUrl) return await (await fetch(state.perfStoreUrl)).text();
        return JSON.stringify(state.store);
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
        state.store = parseStore(payload);
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
        const savedPath = await app.SaveFileDialog(defaultName || 'response.json', response.body);
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
        const usage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
        const firstBlocks = [
          { type: 'text', text: 'Let me check the forecast for Lisbon.' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: '{"city":"Lisbon","date":"2026-10-24"}' },
        ];
        const toolResult = { type: 'tool_result', id: 'call_1', name: 'get_weather', server: 'Weather', text: '{"rain":0.72,"high_c":19}' };
        const secondBlocks = [{ type: 'text', text: 'Bring an umbrella: there is a **72%** chance of rain after noon.\n\n- High: `19 °C`\n- Wind: light, from the west' }];
        const stepHttp = (body) => ({ ...jsonResponse(req.http), headers: [{ key: 'Content-Type', value: 'text/event-stream', enabled: true }], body });
        const firstStep = { index: 0, blocks: firstBlocks, toolResults: [toolResult], stopReason: 'tool_use', rawStopReason: 'tool_calls', model: req.model, usage: usage(1180, 64), hasUsage: true, firstTokenMs: 412, durationMs: 1650, http: stepHttp('data: {"choices":[{"delta":{"content":"Let me"}}]}\n\ndata: [DONE]\n') };
        const secondStep = { index: 1, blocks: secondBlocks, toolResults: [], stopReason: 'end_turn', rawStopReason: 'stop', model: req.model, usage: usage(1290, 38), hasUsage: true, firstTokenMs: 380, durationMs: 1200, http: stepHttp('data: {"choices":[{"delta":{"content":"Bring"}}]}\n\ndata: [DONE]\n') };
        emit('ai:deltas', { sessionId, deltas: [
          { sessionId, step: 0, index: 0, type: 'text', text: 'Let me check ' },
          { sessionId, step: 0, index: 0, type: 'text', text: 'the forecast for Lisbon.' },
          { sessionId, step: 0, index: 1, type: 'tool_use', id: 'call_1', name: 'get_weather' },
          { sessionId, step: 0, index: 1, type: 'tool_use', input: '{"city":"Lis' },
        ] });
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
      OpenFileDialog: async () => '',
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
        state.gitStatusOverride = null;
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
        const next = [...(state.cookies[workspaceId] ?? []), cookie];
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
      ExportLoadTestK6: async (payload: string, inlineSecrets: boolean) => {
        const parsed = JSON.parse(payload) as { loadTest: { name: string }; requests: Array<{ name: string }> };
        state.calls.push(`ExportLoadTestK6:${parsed.loadTest.name}:${parsed.requests.map(request => request.name).join(',')}:${inlineSecrets}`);
        return {
          script: `import http from 'k6/http';\n\nexport default function () {\n  http.get('https://shop.kurlo.test/login');\n}\n`,
          fileName: 'login-load-test.k6.js',
          warnings: [
            { level: 'warn', step: 2, message: 'The pre-request and test scripts of List orders are not exported. Add checks to the step instead.' },
            { level: 'info', message: 'password is secret and is not written into the script. Pass it when running: k6 run -e password=…' },
          ],
        };
      },
      StartMockServer: async (config) => {
        state.calls.push(`StartMockServer:${config.collectionName}:${config.routes.length}`);
        state.mockServer = {
          running: true,
          port: config.port,
          url: `http://127.0.0.1:${config.port}`,
          collectionId: config.collectionId,
          collectionName: config.collectionName,
          routeCount: config.routes.length,
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
      },
      CheckForUpdate: async () => ({ info: null, error: '' }),
    };

    state.emit = emit;
    window.__kurloE2E = state;
    window.go = { api: { App: app } };
    window.runtime = {
      EventsOn: on,
      BrowserOpenURL: (url) => state.calls.push(`open:${url}`),
      WindowIsMaximised: async () => false,
      WindowMinimise: async () => {},
      WindowToggleMaximise: async () => {},
      WindowSetLightTheme: async () => {},
      WindowSetDarkTheme: async () => {},
      WindowSetBackgroundColour: async () => {},
    };
  }, { largeResponseBody, runtime, docsMode });
}

async function fillPrompt(page: Page, title: string, value: string) {
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  await dialog.locator('input').fill(value);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

async function chooseAppSelect(page: Page, select: Locator, optionLabel: string) {
  await select.locator('.app-select-trigger').click();
  await select.locator('.app-select-option').filter({ hasText: optionLabel }).first().click();
}

async function chooseRequestType(page: Page, label: string) {
  await expect(page.getByRole('dialog', { name: 'New request' })).toHaveCount(0);
  const protocol = label.replace(/\s+request$/i, '');
  if (/^http$/i.test(protocol)) return;
  await page.getByLabel('Method and protocol').click();
  await page.getByRole('option', { name: protocol, exact: true }).click();
}

async function fillCodeEditor(page: Page, testId: string, value: string) {
  const editor = page.getByTestId(testId).locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+A`);
  await page.keyboard.insertText(value);
}

async function expectResponseTabsToFit(page: Page) {
  await expect.poll(async () => page.locator('.response-status-bar').evaluate((bar) => {
    const statusLeft = bar.querySelector<HTMLElement>('.status-left');
    const statusRight = bar.querySelector<HTMLElement>('.status-right');
    const tabs = bar.querySelector<HTMLElement>('.response-mini-tabs');
    const actions = bar.querySelector<HTMLElement>('.resp-actions');
    const buttons = [...bar.querySelectorAll<HTMLElement>('.response-mini-tabs button')];
    if (!statusLeft || !statusRight || !tabs || !actions || !buttons.length) return false;
    const barRect = bar.getBoundingClientRect();
    const leftRect = statusLeft.getBoundingClientRect();
    const rightRect = statusRight.getBoundingClientRect();
    const tabsRect = tabs.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const labelsFit = buttons.every(button => button.scrollWidth <= button.clientWidth + 1);
    const active = bar.querySelector<HTMLElement>('.response-mini-tabs button.active');
    const activeRect = active?.getBoundingClientRect();
    const activeInsideBar = !activeRect || (activeRect.top >= barRect.top - 1 && activeRect.bottom <= barRect.bottom + 1);
    const groupsStayInsideBar = leftRect.left >= barRect.left - 1 && rightRect.right <= barRect.right + 1;
    const groupsDoNotOverlap = leftRect.right <= rightRect.left - 4;
    const tabsOnTheirOwnRow = tabsRect.top >= Math.max(leftRect.bottom, actionsRect.bottom) - 1
      && tabsRect.left >= barRect.left - 1 && tabsRect.right <= barRect.right + 1;
    return labelsFit && activeInsideBar && groupsStayInsideBar && groupsDoNotOverlap && tabsOnTheirOwnRow;
  })).toBe(true);
}

async function expectScriptResultsPanelLayout(page: Page) {
  await expect.poll(async () => page.locator('.test-results-panel').evaluate((panel) => {
    const blocks = [...panel.querySelectorAll<HTMLElement>('.script-result-block')];
    if (!blocks.length) return false;
    const previousScrollTop = panel.scrollTop;
    const panelRect = panel.getBoundingClientRect();
    const blocksHaveOwnContent = blocks.every(block => block.scrollHeight <= block.clientHeight + 1);

    panel.scrollTop = 0;
    const firstBlockRect = blocks[0].getBoundingClientRect();
    const firstHeader = blocks[0].querySelector<HTMLElement>('.script-result-header');
    const firstHeaderRect = firstHeader?.getBoundingClientRect();
    const firstBlockStartsInsidePanel = firstBlockRect.top >= panelRect.top + 8 && firstBlockRect.top < panelRect.bottom;
    const firstHeaderVisible = !firstHeaderRect || (firstHeaderRect.top >= panelRect.top + 8 && firstHeaderRect.bottom <= panelRect.bottom);

    panel.scrollTop = panel.scrollHeight;
    const lastBlock = blocks[blocks.length - 1];
    const lastRow = lastBlock.querySelector<HTMLElement>(':scope > :last-child');
    if (!lastRow) {
      panel.scrollTop = previousScrollTop;
      return false;
    }
    panel.scrollTop = panel.scrollHeight;
    const rowRect = lastRow.getBoundingClientRect();
    const reachedEnd = Math.ceil(panel.scrollTop + panel.clientHeight) >= panel.scrollHeight - 1;
    const lastRowVisible = rowRect.bottom <= panelRect.bottom - 8 && rowRect.top >= panelRect.top;

    panel.scrollTop = 0;
    return blocksHaveOwnContent && firstBlockStartsInsidePanel && firstHeaderVisible && reachedEnd && lastRowVisible;
  })).toBe(true);
}

async function maybeCaptureResponseScreenshot(page: Page) {
  if (!responseScreenshotPath) return;
  await page.screenshot({ path: responseScreenshotPath });
}

async function waitForTransientToasts(page: Page) {
  await page.locator('.curl-toast').waitFor({ state: 'hidden', timeout: 2500 }).catch(() => {});
}

async function setGitStatus(page: Page, status: Record<string, unknown>) {
  await page.evaluate((partial) => {
    const state = window.__kurloE2E as unknown as { gitStatusOverride: Record<string, unknown> | null };
    state.gitStatusOverride = { ...(state.gitStatusOverride ?? {}), ...partial };
  }, status);
}

async function setGitBranches(page: Page, branches: Record<string, unknown>) {
  await page.evaluate((value) => {
    (window.__kurloE2E as unknown as { gitBranchesOverride: Record<string, unknown> | null }).gitBranchesOverride = value;
  }, branches);
}

async function openGitPanel(page: Page) {
  await page.getByLabel('Open Git and storage status').click();
  await expect(page.locator('.git-workspace')).toBeVisible();
}

function collectionRow(page: Page, name: string) {
  return page.locator('.collection-group').filter({ hasText: name }).first();
}

function folderRow(page: Page, name: string) {
  return page.locator('.collection-subfolder').filter({ hasText: name }).first();
}

async function addRequestFromFolder(page: Page, folderName: string, requestTypeLabel: string) {
  await page.getByRole('button', { name: 'Collections' }).click();
  const folder = folderRow(page, folderName);
  await folder.getByLabel('Folder menu').click();
  await folder.locator('.folder-menu').getByRole('button', { name: 'Add request' }).click();
  await chooseRequestType(page, requestTypeLabel);
}

async function chooseRequestSection(page: Page, section: string) {
  const compactTrigger = page.getByRole('button', { name: 'Request section', exact: true });
  if (await compactTrigger.isVisible()) {
    await compactTrigger.click();
    await page.getByRole('option', { name: section }).click();
    return;
  }
  await page.locator('.request-editor-tabs-shell').getByRole('tab', { name: section }).click();
}

test.describe('Kurlo desktop browser E2E', () => {
  test('keeps the macOS workspace switcher clear of search with the code panel open', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await installKurloBridge(page, '', 'darwin/e2e');
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Code snippet', { exact: true }).click();
    await expect(page.locator('.code-snippet-panel')).toBeVisible();
    const toolbarOpenFrames = await page.locator('.searchbar-right').evaluate((actions) => new Promise<number[]>((resolve) => {
      const frames: number[] = [];
      const sample = () => {
        frames.push(actions.getBoundingClientRect().x);
        if (frames.length >= 8) {
          resolve(frames);
          return;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }));
    expect(Math.max(...toolbarOpenFrames) - Math.min(...toolbarOpenFrames)).toBeLessThanOrEqual(0.1);
    await expect(page.locator('.global-search-label')).toBeHidden();
    const searchIcon = page.locator('.global-search > svg');
    await expect.poll(async () => (await searchIcon.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(13);
    await page.getByLabel('Code snippet', { exact: true }).click();
    await expect(page.locator('.code-snippet-panel')).toBeHidden();
    await page.getByLabel('Code snippet', { exact: true }).click();
    await expect(page.locator('.code-snippet-panel')).toBeVisible();
    await expect.poll(async () => (await searchIcon.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(13);

    const tabStrip = page.locator('.request-tab-strip');
    const savedTabs = page.locator('.saved-request-tabs');
    const overviewTab = page.getByRole('tab', { name: 'Overview' });
    const newRequestButton = page.getByLabel('New unsaved request');
    for (let index = 0; index < 2; index += 1) {
      await newRequestButton.click();
      await chooseRequestType(page, 'HTTP Request');
    }
    await expect(tabStrip).toHaveCSS('border-top-style', 'none');
    await expect(tabStrip).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(overviewTab).toHaveText('Overview');
    await expect.poll(async () => overviewTab.evaluate((tab) => tab.closest('.saved-request-tabs') !== null)).toBe(true);
    await expect.poll(async () => savedTabs.evaluate((tabs) => tabs.scrollWidth > tabs.clientWidth)).toBe(true);
    await savedTabs.evaluate((tabs) => {
      tabs.scrollLeft = tabs.scrollWidth;
    });
    await expect.poll(async () => savedTabs.evaluate((tabs) => {
      const overview = tabs.querySelector<HTMLElement>('.overview-request-tab');
      if (!overview) return false;
      return overview.getBoundingClientRect().right <= tabs.getBoundingClientRect().left;
    })).toBe(true);
    await expect.poll(async () => tabStrip.evaluate((strip) => {
      const tabs = strip.querySelector<HTMLElement>('.saved-request-tabs');
      const create = strip.querySelector<HTMLElement>('.new-request-tab-btn');
      if (!tabs || !create) return false;
      const stripBox = strip.getBoundingClientRect();
      const tabsBox = tabs.getBoundingClientRect();
      const createBox = create.getBoundingClientRect();
      return tabsBox.right <= createBox.left
        && createBox.right <= stripBox.right
        && createBox.width >= 28;
    })).toBe(true);
    await page.mouse.move(0, 0);
    await expect(newRequestButton).toHaveCSS('border-left-color', 'rgba(0, 0, 0, 0)');
    await expect(newRequestButton).toHaveCSS('border-radius', '6px');

    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.locator('.global-search-label')).toBeHidden();
    await expect(searchIcon).toHaveAttribute('viewBox', '0 0 24 24');
    await expect.poll(async () => page.locator('.global-search').evaluate((search) => {
      const icon = search.querySelector<SVGElement>(':scope > svg');
      if (!icon) return false;
      const searchBox = search.getBoundingClientRect();
      const iconBox = icon.getBoundingClientRect();
      const horizontalOffset = Math.abs(
        (iconBox.left + iconBox.width / 2) - (searchBox.left + searchBox.width / 2),
      );
      const verticalOffset = Math.abs(
        (iconBox.top + iconBox.height / 2) - (searchBox.top + searchBox.height / 2),
      );
      return horizontalOffset <= 0.5 && verticalOffset <= 0.5;
    })).toBe(true);

    const toolbarButtons = page.locator('.searchbar-right > .save-btn, .searchbar-right > .searchbar-settings-btn');
    const toolbarButtonCount = await toolbarButtons.count();
    const toolbarGeometry = async () => toolbarButtons.evaluateAll((buttons) => buttons.map((button) => {
      const buttonBox = button.getBoundingClientRect();
      const iconBox = button.querySelector('svg')?.getBoundingClientRect();
      return {
        buttonX: buttonBox.x,
        buttonY: buttonBox.y,
        buttonWidth: buttonBox.width,
        buttonHeight: buttonBox.height,
        iconX: iconBox?.x ?? 0,
        iconY: iconBox?.y ?? 0,
        iconWidth: iconBox?.width ?? 0,
        iconHeight: iconBox?.height ?? 0,
      };
    }));
    const toolbarBeforeHover = await toolbarGeometry();
    for (let index = 0; index < toolbarButtonCount; index += 1) {
      await toolbarButtons.nth(index).hover();
      const toolbarDuringHover = await toolbarGeometry();
      expect(toolbarDuringHover).toEqual(toolbarBeforeHover);
    }
    for (const item of toolbarBeforeHover) {
      expect(Number.isInteger(item.iconX)).toBe(true);
      expect(Number.isInteger(item.iconY)).toBe(true);
    }
    await expect.poll(async () => page.locator('.workspace-searchbar').evaluate((header) => {
      const actions = header.querySelector<HTMLElement>('.searchbar-right');
      if (!actions) return false;
      return actions.scrollWidth === actions.clientWidth
        && actions.getBoundingClientRect().right <= header.getBoundingClientRect().right + 1;
    })).toBe(true);
    const runnerButton = page.getByRole('button', { name: 'Collection runner', exact: true });
    const runnerIcon = runnerButton.locator('svg');
    await page.locator('.request-editor').hover();
    const runnerIconBeforeHover = await runnerIcon.screenshot({ animations: 'disabled' });
    await runnerButton.hover();
    const runnerIconDuringHover = await runnerIcon.screenshot({ animations: 'disabled' });
    expect(runnerIconDuringHover.equals(runnerIconBeforeHover)).toBe(true);

    const requestSectionButton = page.getByRole('button', { name: 'Request section', exact: true });
    await expect(requestSectionButton).toBeVisible();
    await requestSectionButton.click();
    const requestSectionList = page.getByRole('listbox', { name: 'Request sections' });
    await expect(requestSectionList).toBeVisible();
    await expect(requestSectionList.getByRole('option', { name: 'Settings', exact: true })).toBeVisible();
    await requestSectionList.getByRole('option', { name: 'Body' }).click();
    const bodyModeRow = page.locator('.body-mode-row');
    const bodyTypeButton = page.getByRole('button', { name: 'Body type', exact: true });
    await expect(bodyTypeButton).toBeVisible();
    await bodyTypeButton.click();
    await expect(page.getByRole('listbox', { name: 'Body types' })).toBeVisible();
    await page.getByRole('option', { name: 'Raw', exact: true }).click();

    const rawTypeButton = page.locator('.raw-type-button');
    const beautifyButton = bodyModeRow.getByRole('button', { name: 'Beautify', exact: true });
    await expect(rawTypeButton).toBeVisible();
    await expect(beautifyButton).toBeVisible();
    await expect.poll(async () => {
      const [rawBox, beautifyBox] = await Promise.all([
        rawTypeButton.boundingBox(),
        beautifyButton.boundingBox(),
      ]);
      if (!rawBox || !beautifyBox) return false;
      return Math.abs(
        (rawBox.y + rawBox.height / 2) - (beautifyBox.y + beautifyBox.height / 2),
      ) <= 1;
    }).toBe(true);

    const compactBodyLayout = await bodyModeRow.evaluate((row) => {
      const content = row.nextElementSibling;
      return {
        rowHeight: row.getBoundingClientRect().height,
        contentTop: content?.getBoundingClientRect().top ?? 0,
      };
    });
    await bodyTypeButton.click();
    await expect(page.getByRole('listbox', { name: 'Body types' })).toBeVisible();
    await expect.poll(async () => bodyModeRow.evaluate((row, before) => {
      const content = row.nextElementSibling;
      return row.getBoundingClientRect().height === before.rowHeight
        && (content?.getBoundingClientRect().top ?? 0) === before.contentTop;
    }, compactBodyLayout)).toBe(true);
    await page.getByRole('option', { name: 'URL-encoded', exact: true }).click();

    const compactKvTable = page.locator('.tab-content .headers-kv-table');
    await expect(compactKvTable).toBeVisible();
    await expect.poll(async () => compactKvTable.evaluate((table) => {
      const head = table.querySelector<HTMLElement>('.kv-head');
      const row = table.querySelector<HTMLElement>('.kv-row');
      const descriptionHead = head?.querySelectorAll<HTMLElement>('.kv-head-cell')[2];
      const descriptionInput = row?.querySelector<HTMLElement>('.kv-desc');
      const valueInput = row?.querySelectorAll<HTMLElement>('.kv-input')[1];
      if (!head || !row || !descriptionHead || !descriptionInput || !valueInput) return false;

      const tableBox = table.getBoundingClientRect();
      const valueInputBox = valueInput.getBoundingClientRect();
      return table.scrollWidth <= table.clientWidth + 1
        && getComputedStyle(descriptionHead).display === 'none'
        && getComputedStyle(descriptionInput).display === 'none'
        && valueInputBox.width >= 80
        && valueInputBox.right <= tableBox.right + 1;
    })).toBe(true);
    await expect(page.getByLabel('Resize key column')).toBeHidden();
    await expect(page.getByLabel('Resize value column')).toBeHidden();
    await expect(page.getByLabel('Resize panels')).toHaveCSS('height', '7px');
    await expect.poll(async () => compactKvTable.evaluate((table) => {
      const tabContent = table.closest<HTMLElement>('.tab-content');
      if (!tabContent) return false;
      const scrollbarColor = getComputedStyle(tabContent).scrollbarColor;
      if (scrollbarColor === undefined) return true;
      return scrollbarColor !== 'auto'
        && scrollbarColor !== ''
        && !scrollbarColor.includes('rgb(206, 212, 218)');
    })).toBe(true);

    await chooseRequestSection(page, 'Headers');
    const headersTable = page.locator('.tab-content .headers-kv-table');
    const panelDivider = page.getByLabel('Resize panels');
    const headerActionGeometry = async () => headersTable.evaluate((table) => {
      const content = table.closest<HTMLElement>('.tab-content');
      const remove = table.querySelector<HTMLElement>('.kv-del');
      if (!content || !remove) return null;

      const contentBox = content.getBoundingClientRect();
      const tableBox = table.getBoundingClientRect();
      const removeBox = remove.getBoundingClientRect();
      return {
        tableWidth: tableBox.width,
        removeLeft: removeBox.left,
        removeWidth: removeBox.width,
        rightClearance: contentBox.left + content.clientWidth - removeBox.right,
        scrollable: content.scrollHeight > content.clientHeight,
      };
    });
    const headersBeforeScroll = await headerActionGeometry();
    expect(headersBeforeScroll).not.toBeNull();
    for (let index = 0; index < 12; index += 1) await panelDivider.press('ArrowUp');
    await expect.poll(async () => (await headerActionGeometry())?.scrollable ?? false).toBe(true);
    const headersWithScroll = await headerActionGeometry();
    expect(headersWithScroll).not.toBeNull();
    if (headersBeforeScroll && headersWithScroll) {
      expect(Math.abs(headersWithScroll.tableWidth - headersBeforeScroll.tableWidth)).toBeLessThanOrEqual(1);
      expect(Math.abs(headersWithScroll.removeLeft - headersBeforeScroll.removeLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(headersWithScroll.removeWidth - headersBeforeScroll.removeWidth)).toBeLessThanOrEqual(1);
      expect(headersWithScroll.rightClearance).toBeGreaterThanOrEqual(7);
    }
    for (let index = 0; index < 12; index += 1) await panelDivider.press('ArrowDown');

    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(page.locator('.global-search-label')).toBeHidden();

    const codePanelResizer = page.getByLabel('Resize code snippet panel');
    await expect(codePanelResizer).toHaveCSS('cursor', 'col-resize');
    expect(await codePanelResizer.evaluate((resizer) => getComputedStyle(resizer, '::after').content)).toBe('none');
    await expect.poll(async () => page.locator('.workspace-searchbar').evaluate((header) => {
      const workspace = header.querySelector<HTMLElement>('.workspace-switcher-trigger');
      const search = header.querySelector<HTMLElement>('.global-search');
      const actions = header.querySelector<HTMLElement>('.searchbar-right');
      const codePanel = document.querySelector<HTMLElement>('.code-snippet-panel');
      if (!workspace || !search || !actions || !codePanel) return false;

      const headerBox = header.getBoundingClientRect();
      const workspaceBox = workspace.getBoundingClientRect();
      const searchBox = search.getBoundingClientRect();
      const actionsBox = actions.getBoundingClientRect();
      const codePanelBox = codePanel.getBoundingClientRect();
      return workspaceBox.right <= searchBox.left
        && searchBox.right <= actionsBox.left
        && actionsBox.right <= codePanelBox.left
        && headerBox.right <= codePanelBox.left;
    })).toBe(true);

    await page.setViewportSize({ width: 1440, height: 800 });
    const resizerBox = await codePanelResizer.boundingBox();
    expect(resizerBox).not.toBeNull();
    if (!resizerBox) return;
    await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + 80);
    await page.mouse.down();
    await page.mouse.move(300, resizerBox.y + 80);
    await page.mouse.up();

    await expect.poll(async () => page.locator('.workspace').evaluate((workspace) => {
      const codePanel = document.querySelector<HTMLElement>('.code-snippet-panel');
      if (!codePanel) return false;
      const workspaceBox = workspace.getBoundingClientRect();
      const codePanelBox = codePanel.getBoundingClientRect();
      const availableWidth = workspaceBox.width;
      const editorWidth = codePanelBox.left - workspaceBox.left;
      return editorWidth >= 560 && codePanelBox.width <= availableWidth / 2 + 1;
    })).toBe(true);

    await page.getByLabel('Code snippet', { exact: true }).click();
    await expect(page.locator('.code-snippet-panel')).toBeHidden();
    await expect(requestSectionButton).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.locator('.request-editor-tabs-shell')).not.toHaveClass(/compact/);
    await chooseRequestSection(page, 'Body');
    await page.locator('.body-mode-label:has(input[value="raw"])').click();
    await expect(page.getByRole('button', { name: 'Body type', exact: true })).toBeHidden();
    await expect.poll(async () => bodyModeRow.evaluate((row) => {
      const binaryLabel = Array.from(row.querySelectorAll<HTMLElement>('.body-mode-label'))
        .find((label) => label.textContent?.trim() === 'Binary');
      const rawType = row.querySelector<HTMLElement>('.raw-type-menu');
      const beautify = row.querySelector<HTMLElement>('.body-mode-beautify');
      if (!binaryLabel || !rawType || !beautify) return false;

      const rowBox = row.getBoundingClientRect();
      const binaryBox = binaryLabel.getBoundingClientRect();
      const rawTypeBox = rawType.getBoundingClientRect();
      const beautifyBox = beautify.getBoundingClientRect();
      return rawTypeBox.left >= binaryBox.right
        && rawTypeBox.left - binaryBox.right <= 16
        && beautifyBox.left > rawTypeBox.right
        && rowBox.right - beautifyBox.right <= 16;
    })).toBe(true);
  });

  test('keeps the Windows titlebar actions clear of search at scaled-window width', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installKurloBridge(page, '', 'windows/e2e');
    await page.goto('/');

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Windows UI');
    await collectionRow(page, 'Windows UI').getByLabel('Collection menu').click();
    await collectionRow(page, 'Windows UI').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('Cursor request');
    await page.getByLabel('Request name').press('Enter');
    await expect(page.locator('.win-controls')).toBeVisible();
    await expect(page.locator('.save-btn:not(.revert-btn)').first()).toBeVisible();
    await expect(page.locator('.collection-request').filter({ hasText: 'Cursor request' })).toHaveCSS('cursor', 'default');
    await expect(page.locator('.saved-request-tab').filter({ hasText: 'Cursor request' }).getByRole('tab')).toHaveCSS('cursor', 'default');

    const expectHeaderNotToOverlap = async () => {
      const [header, search, save, settings, controls] = await Promise.all([
        page.locator('.workspace-searchbar').boundingBox(),
        page.locator('.global-search').boundingBox(),
        page.locator('.save-btn:not(.revert-btn)').first().boundingBox(),
        page.getByLabel('Settings', { exact: true }).boundingBox(),
        page.locator('.win-controls').boundingBox(),
      ]);

      expect(header).not.toBeNull();
      expect(search).not.toBeNull();
      expect(save).not.toBeNull();
      expect(settings).not.toBeNull();
      expect(controls).not.toBeNull();
      if (!header || !search || !save || !settings || !controls) return;

      expect(search.x + search.width).toBeLessThanOrEqual(save.x);
      expect(settings.x + settings.width).toBeLessThanOrEqual(controls.x);
      expect(controls.x + controls.width).toBeLessThanOrEqual(header.x + header.width);
      expect(search.x).toBeGreaterThanOrEqual(header.x);
    };

    await expectHeaderNotToOverlap();

    await page.setViewportSize({ width: 1120, height: 800 });
    await expect(page.locator('.save-btn-label')).toBeHidden();
    await expectHeaderNotToOverlap();
  });

  test('full click-through flow: environment, collection, requests, send, history, runner, report', async ({ page }) => {
    if (docsScreenshotDir) {
      await mkdir(docsScreenshotDir, { recursive: true });
      await page.setViewportSize(DOCS_VIEWPORT);
    }
    await installKurloBridge(page);
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Kurlo' })).toBeVisible();
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    await expect(page.locator('.shell')).toHaveClass(/sidebar-hidden/);
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await page.getByRole('button', { name: 'Collections' }).click();
    await expect(page.locator('.shell')).not.toHaveClass(/sidebar-hidden/);
    await page.getByRole('button', { name: 'Collections' }).click();
    await expect(page.locator('.shell')).not.toHaveClass(/sidebar-hidden/);
    await tourPause(page, 'App loaded');

    if (docsScreenshotDir) {
      try {
        await page.getByRole('button', { name: 'Cookies', exact: true }).click();
        await expect(page.locator('.cookie-modal')).toBeVisible();
        await captureDocsScreenshot(page, 'cookie-jar-empty');
        await page.getByLabel('Close cookie jar').click();
      } catch (err) { console.log('docs screenshot cookie-jar-empty skipped:', err); }
    }

    await page.getByRole('button', { name: 'Environments' }).click();
    await page.getByLabel('New environment').click();
    await fillPrompt(page, 'New environment', 'Local Smoke');

    const envRows = page.getByTestId('environment-variable-row');
    await envRows.nth(0).getByLabel('Environment variable key').fill('baseUrl');
    await envRows.nth(0).getByLabel('Environment variable value').fill('https://api.kurlo.test');
    await expect(envRows).toHaveCount(2);
    await envRows.nth(1).getByLabel('Environment variable key').fill('token');
    await envRows.nth(1).getByRole('button', { name: 'Default' }).click();
    await envRows.nth(1).getByLabel('Environment variable value').fill('secret-e2e-token');
    await page.getByRole('button', { name: /^(Use environment|In use)$/ }).click();
    await expect(page.getByRole('button', { name: 'In use', exact: true })).toBeVisible();
    await tourPause(page, 'Environment created and activated');
    await waitForTransientToasts(page);
    await captureDocsScreenshot(page, 'environments-panel');

    await page.getByRole('button', { name: 'Collections' }).click();
    await page.locator('.collections-head-actions').getByLabel('Import collection').click();
    const importDialog = page.getByRole('dialog', { name: 'Import collection' });
    await expect(importDialog).toBeVisible();
    for (const source of ['Bruno / OpenCollection', 'Postman collection', 'Insomnia export', 'OpenAPI / Swagger', 'HAR from DevTools']) {
      await expect(importDialog).toContainText(source);
    }
    await captureDocsScreenshot(page, 'import-postman');
    await importDialog.getByRole('button', { name: 'Cancel' }).click();

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Smoke API');
    await expect(collectionRow(page, 'Smoke API')).toBeVisible();

    await collectionRow(page, 'Smoke API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Smoke API').locator('.collection-menu').getByRole('button', { name: 'Add folder' }).click();
    await fillPrompt(page, 'New folder', 'Auth');
    await expect(folderRow(page, 'Auth')).toBeVisible();
    await tourPause(page, 'Collection and folder created');

    await folderRow(page, 'Auth').getByLabel('Folder menu').click();
    await folderRow(page, 'Auth').locator('.folder-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await expect(page.getByLabel('Request name')).toBeVisible();

    await page.getByLabel('Request name').fill('Login user');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Method and protocol').click();
    await expect(page.getByRole('option', { name: 'GraphQL' })).toHaveCount(1);
    if (docsScreenshotDir) {
      try { await captureDocsScreenshot(page, 'request-protocol-picker'); } catch (err) { console.log('docs screenshot request-protocol-picker skipped:', err); }
    }
    await page.getByRole('option', { name: 'POST' }).click();
    await page.getByLabel('Request URL').fill('{{baseUrl}}/login');
    await page.getByLabel('Method and protocol').click();
    await expect(page.getByText('The protocol is fixed once a saved request has a URL.', { exact: false })).toBeVisible();
    await expect(page.getByRole('option', { name: 'GraphQL' })).toHaveCount(0);
    await page.getByRole('option', { name: 'POST' }).click();

    await chooseRequestSection(page, 'Params');
    await page.getByTestId('params-row').first().locator('input[placeholder="Key"]').fill('scope');
    await page.getByTestId('params-row').first().locator('input[placeholder="Value"]').fill('smoke');

    await chooseRequestSection(page, 'Authorization');
    await page.getByLabel('Auth Type').click();
    await page.getByRole('button', { name: 'Bearer token' }).click();
    await page.locator('#bearer-token').fill('{{token}}');
    await captureDocsScreenshot(page, 'auth-bearer');
    if (docsScreenshotDir) {
      try {
        await page.getByLabel('Auth Type').click();
        await page.getByRole('button', { name: 'OAuth 2.0' }).click();
        await page.locator('#oauth2-url').fill('https://auth.kurlo.test/oauth/token');
        await page.locator('#oauth2-id').fill('kurlo-docs-client');
        await page.locator('#oauth2-secret').fill('<redacted>');
        await page.locator('#oauth2-scope').fill('openid profile');
        await captureDocsScreenshot(page, 'auth-oauth2-token-fetch');
        await page.getByLabel('Auth Type').click();
        await page.getByRole('button', { name: 'Bearer token' }).click();
        await page.locator('#bearer-token').fill('{{token}}');
      } catch (err) { console.log('docs screenshot auth-oauth2-token-fetch skipped:', err); }
    }

    await chooseRequestSection(page, 'Headers');
    await page.getByTestId('request-header-row').first().locator('input[placeholder="Key"]').fill('X-Trace');
    await page.getByTestId('request-header-row').first().locator('input[placeholder="Value"]').fill('kurlo-e2e');
    await captureDocsScreenshot(page, 'headers-tab');

    await chooseRequestSection(page, 'Body');
    await page.locator('label.body-mode-label').filter({ hasText: 'raw' }).click();
    const requestPassword = docsScreenshotDir ? '<redacted>' : 'visible-test';
    await fillCodeEditor(
      page,
      'request-body-editor',
      JSON.stringify({ username: 'codex', password: requestPassword }, null, 2),
    );
    const requestBodyEditor = page.getByTestId('request-body-editor').locator('.cm-content');
    await requestBodyEditor.click();
    await page.keyboard.type('x');
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect(requestBodyEditor).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(page.getByRole('dialog', { name: 'Delete request' })).toHaveCount(0);
    await expect(requestBodyEditor).not.toContainText(/x$/);

    await chooseRequestSection(page, 'Scripts');
    await fillCodeEditor(page, 'pre-request-script-editor', 'pm.variables.set("requestId", "e2e-login")');
    await captureDocsScreenshot(page, 'scripting-pre-request');
    await page.locator('.script-section').getByRole('tab', { name: /^Tests/ }).click();
    await fillCodeEditor(page, 'test-script-editor', 'pm.test("status is 200", () => pm.expect(pm.response.code).to.eql(200))');
    await tourPause(page, 'HTTP request configured');

    const panelDivider = page.getByLabel('Resize panels');
    const dividerSteps = docsScreenshotDir ? 8 : 24;
    for (let i = 0; i < dividerSteps; i += 1) await panelDivider.press('ArrowDown');
    await chooseRequestSection(page, 'Settings');
    await captureDocsScreenshot(page, 'request-settings');
    const browserEmulationSetting = page.locator('label.postman-setting').filter({ hasText: 'Browser request emulation' });
    await browserEmulationSetting.locator('.switch-control').click();
    await page.getByPlaceholder('http://localhost:5173').fill('https://app.kurlo.test');
    const corsSetting = page.locator('label.postman-setting').filter({ hasText: 'Enforce CORS' });
    await corsSetting.locator('.switch-control').click();
    const cspSetting = page.locator('label.postman-setting').filter({ hasText: 'Enforce CSP connect-src' });
    await cspSetting.locator('.switch-control').click();
    await page.locator('label.postman-setting-tall textarea').fill("default-src 'self'; connect-src https://api.kurlo.test");
    await captureDocsScreenshot(page, 'browser-security', page.locator('.settings-list'));
    await page.locator('.settings-actions').getByRole('button', { name: 'Reset' }).click();
    for (let i = 0; i < dividerSteps; i += 1) await panelDivider.press('ArrowUp');

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();
    await expectResponseTabsToFit(page);
    await expect(page.locator('.test-results-panel')).toContainText('status is 200');
    await expect(page.locator('.test-results-panel')).toContainText('test script accepted');
    await expectScriptResultsPanelLayout(page);
    await captureDocsScreenshot(page, 'response-viewer-tests');
    await page.locator('.response-mini-tabs').getByRole('tab', { name: 'Body' }).click();
    await captureDocsScreenshot(page, 'response-viewer-json');
    await chooseRequestSection(page, 'Body');
    await captureDocsScreenshot(page, 'request-editor');
    if (docsScreenshotDir) {
      try {
        await page.getByRole('button', { name: 'Search response', exact: true }).click();
        await page.getByLabel('Search response body').fill('login-e2e');
        await expect(page.locator('.response-search-count')).toHaveText('1/1');
        await captureDocsScreenshot(page, 'response-viewer-search');
        await page.getByRole('button', { name: 'Search response', exact: true }).click();
      } catch (err) { console.log('docs screenshot response-viewer-search skipped:', err); }
    }
    if (docsScreenshotDir) {
      try {
        await page.getByLabel('Settings', { exact: true }).click();
        await page.getByRole('tab', { name: 'General', exact: true }).click({ timeout: 4000 });
        await page.locator('summary').filter({ hasText: 'Scripts' }).click();
        await page.getByRole('button', { name: /Tengo/ }).click();
        await page.getByLabel('Close settings').click();
        await chooseRequestSection(page, 'Scripts');
        await page.locator('.script-section').getByRole('tab', { name: /^Pre-request/ }).click();
        await fillCodeEditor(page, 'pre-request-script-editor', [
          'pm.variables.set("requestId", "tengo-docs")',
          'pm.log("Tengo pre-request ready")',
        ].join('\n'));
        await captureDocsScreenshot(page, 'scripting-tengo');
        await page.getByLabel('Settings', { exact: true }).click();
        await page.getByRole('tab', { name: 'General', exact: true }).click({ timeout: 4000 });
        await page.locator('summary').filter({ hasText: 'Scripts' }).click();
        await page.getByRole('button', { name: /JavaScript/ }).click();
        await page.getByLabel('Close settings').click();
        await page.locator('.script-section').getByRole('tab', { name: /^Tests/ }).click();
      } catch (err) { console.log('docs screenshot scripting-tengo skipped:', err); }
    }
    if (docsScreenshotDir) {
      try {
        await page.locator('.response-status-bar').screenshot({ path: join(docsScreenshotDir, 'status-bar.png'), animations: 'disabled' });
      } catch (err) { console.log('docs screenshot status-bar skipped:', err); }
      try {
        await page.getByLabel('Code snippet', { exact: true }).click();
        await expect(page.locator('.curl-preview')).not.toContainText('Loading snippet', { timeout: 4000 });
        await captureDocsScreenshot(page, 'code-snippets');
        await page.getByLabel('Code snippet', { exact: true }).click();
      } catch (err) { console.log('docs screenshot code-snippets skipped:', err); }
    }
    await maybeCaptureResponseScreenshot(page);
    const responseBodyViewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await responseBodyViewer.click();
    await expect(responseBodyViewer).toBeFocused();
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+A`);
    await expect.poll(() => responseBodyViewer.evaluate((viewer) => {
      const selection = window.getSelection();
      return Boolean(
        selection?.toString().includes('"requestId": "login-e2e"')
        && selection.anchorNode
        && selection.focusNode
        && viewer.contains(selection.anchorNode)
        && viewer.contains(selection.focusNode)
      );
    })).toBe(true);
    await page.getByLabel('Save to file').click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedFiles.length)).toBe(1);

    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.locator('.history-entry').first()).toContainText('POST');
    await expect(page.locator('.history-entry').first()).toContainText('/login?scope=smoke');
    await expect(page.locator('.history-entry').first()).toContainText('200');
    await tourPause(page, 'HTTP response saved and history checked');
    await captureDocsScreenshot(page, 'history');

    await page.locator('.history-entry-main').first().click();
    const historyDetail = page.getByRole('region', { name: 'History entry' });
    await expect(historyDetail).toBeVisible();
    await expect(historyDetail.locator('.history-detail-title h1')).toContainText('Login user');
    await expect(historyDetail.locator('.history-detail-title')).toContainText('from Smoke API / Auth');
    await expect(historyDetail.locator('.history-detail-stats')).toContainText('200');
    await expect(historyDetail.locator('.history-detail-url')).toContainText('/login?scope=smoke');
    await expect(historyDetail.getByRole('textbox', { name: 'Response body' })).toContainText('"requestId": "login-e2e"');
    await expect(page.locator('.history-entry.active')).toHaveCount(1);
    await captureDocsScreenshot(page, 'history-detail');
    await page.getByLabel('Close history entry').click();
    await expect(historyDetail).toBeHidden();

    await page.getByRole('tab', { name: 'Overview' }).click();
    const recent = page.getByRole('region', { name: 'Continue where you left off' });
    await expect(recent).toContainText('Login user');
    await expect(recent).toContainText('Smoke API / Auth');
    await expect(recent).toContainText('200');
    await recent.getByRole('button', { name: /Login user/ }).click();
    await expect(page.getByLabel('Request URL')).toHaveValue(/\/login/);
    if (docsScreenshotDir) {
      try {
        await page.getByRole('button', { name: 'Cookies', exact: true }).click();
        await page.getByPlaceholder('Type a domain name').fill('api.kurlo.test');
        await page.getByRole('button', { name: 'Add domain' }).click();
        await page.getByLabel('Raw cookie').fill('session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax');
        await page.locator('.cookie-raw-actions').getByRole('button', { name: 'Save' }).click();
        await expect(page.locator('.cookie-domain-card')).toContainText('session');
        await captureDocsScreenshot(page, 'cookie-jar-populated');
        await page.getByLabel('Close cookie jar').click();
      } catch (err) {
        console.log('docs screenshot cookie-jar-populated skipped:', err);
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    await page.getByRole('button', { name: 'Collections' }).click();
    await folderRow(page, 'Auth').getByLabel('Folder menu').click();
    await folderRow(page, 'Auth').locator('.folder-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'GraphQL Request');
    await page.getByLabel('Request name').fill('Current user GraphQL');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('{{baseUrl}}/graphql');
    await fillCodeEditor(page, 'graphql-query-editor', 'query CurrentUser { me { id name } }');
    await page.getByRole('button', { name: 'Query', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();
    await expectResponseTabsToFit(page);
    await page.locator('.response-mini-tabs').getByRole('tab', { name: 'Body' }).click();
    await expect(page.locator('.response-body-viewer')).toContainText('Kurlo Tester');
    await captureDocsScreenshot(page, 'request-graphql');
    await tourPause(page, 'GraphQL request sent');

    await page.getByRole('button', { name: 'Collections' }).click();
    await folderRow(page, 'Auth').getByLabel('Folder menu').click();
    await folderRow(page, 'Auth').locator('.folder-menu').getByRole('button', { name: 'Run folder' }).click();
    await expect(page.getByRole('region', { name: 'Collection runner' })).toBeVisible();
    await expect(page.getByTestId('runner-request-row')).toHaveCount(2);
    const runnerCheck = page.getByTestId('runner-request-row').first().locator('.check');
    await expect(runnerCheck).toBeChecked();
    const lockedMark = await runnerCheck.evaluate(async (input: HTMLInputElement) => {
      input.disabled = true;
      await new Promise(requestAnimationFrame);
      await Promise.all(input.getAnimations({ subtree: true }).map(animation => animation.finished));
      const transform = getComputedStyle(input, '::before').transform;
      input.disabled = false;
      return transform;
    });
    expect(lockedMark).toBe('matrix(1, 0, 0, 1, 0, 0)');
    await page.getByRole('button', { name: /Run 2 requests/i }).click();
    await expect(page.getByTestId('runner-result-row')).toHaveCount(2);
    await expect(page.locator('.runner-results-summary')).toContainText('Passed');
    await expect(page.locator('.runner-results-summary')).toContainText('Requests 2/2');
    await page.getByRole('button', { name: 'Download report' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedFiles.length)).toBe(2);
    await tourPause(page, 'Runner finished and report downloaded');
    await captureDocsScreenshot(page, 'collection-runner-results');
    const storedRuns = await page.evaluate(() => (window.__kurloE2E.store as { collectionRuns?: Record<string, { results: unknown[] }> }).collectionRuns ?? {});
    expect(Object.values(storedRuns).map(run => run.results.length)).toEqual([2]);

    await page.getByRole('button', { name: 'Collections' }).click();
    await collectionRow(page, 'Smoke API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Smoke API').locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.collection-last-run')).toContainText('Last run just now');
    await expect(page.locator('.collection-last-run')).toContainText('2 of 2 passed');
    await page.locator('.collection-last-run-link').click();
    await expect(page.getByRole('region', { name: 'Collection runner' })).toBeVisible();
    await expect(page.getByTestId('runner-result-row')).toHaveCount(2);

    await page.getByRole('button', { name: 'Collections' }).click();
    await folderRow(page, 'Auth').getByLabel('Folder menu').click();
    await folderRow(page, 'Auth').locator('.folder-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('Live events SSE');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Method and protocol').click();
    await page.getByRole('option', { name: 'SSE' }).click();
    await page.getByLabel('Request URL').fill('{{baseUrl}}/events');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.sse-panel')).toContainText('Connected');
    await expect(page.locator('.sse-event-list')).toContainText('Kurlo stream is live');
    await captureDocsScreenshot(page, 'request-sse');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Collections' }).click();
    await collectionRow(page, 'Smoke API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Smoke API').locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
    await page.locator('.collection-settings-shell').getByRole('tab', { name: /^Headers/ }).click();
    const collectionHeaderRows = page.locator('.collection-kv-table .kv-row');
    await collectionHeaderRows.nth(0).locator('input[placeholder="Header"]').fill('X-Client');
    await collectionHeaderRows.nth(0).locator('input[placeholder="Value"]').fill('kurlo-docs');
    await collectionHeaderRows.nth(1).locator('input[placeholder="Header"]').fill('Accept');
    await collectionHeaderRows.nth(1).locator('input[placeholder="Value"]').fill('application/json');
    await page.getByRole('heading', { name: 'Smoke API', exact: true }).click();
    await captureDocsScreenshot(page, 'collection-defaults');

    await addRequestFromFolder(page, 'Auth', 'gRPC Request');
    await page.getByLabel('Request name').fill('Inventory gRPC');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('gRPC target').fill('grpc.kurlo.test:443');
    await page.getByLabel('gRPC method').click();
    await expect(page.getByRole('option', { name: /Inventory \/ GetItem/ })).toBeVisible();
    await page.getByRole('option', { name: /Inventory \/ GetItem/ }).click();
    await fillCodeEditor(page, 'grpc-message-editor', JSON.stringify({ sku: 'sku-42' }, null, 2));
    await chooseRequestSection(page, 'Metadata');
    await page.locator('.kv-row').first().locator('input[placeholder="Metadata key"]').fill('x-client');
    await page.locator('.kv-row').first().locator('input[placeholder="Value"]').fill('playwright');
    await page.getByRole('button', { name: 'Invoke', exact: true }).click();
    await expect(page.locator('.response-status-bar')).toContainText('OK');
    await expect(page.locator('.grpc-message-list')).toContainText('sku-42');
    await expect(page.locator('.grpc-message-list')).toContainText('stock');
    await captureDocsScreenshot(page, 'request-grpc');
    await tourPause(page, 'gRPC discovery and invoke checked');

    await addRequestFromFolder(page, 'Auth', 'WebSocket Request');
    await page.getByLabel('Request name').fill('Chat WebSocket');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('wss://ws.kurlo.test/socket');
    await fillCodeEditor(page, 'websocket-message-editor', JSON.stringify({ hello: 'socket' }, null, 2));
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.ws-panel')).toContainText('Connected');
    await expect(page.locator('.ws-message-list')).toContainText('Connected to wss://ws.kurlo.test/socket');
    await page.locator('.ws-message-actions .ws-message-send').click();
    await expect(page.locator('.ws-message-list')).toContainText('hello');
    await expect(page.locator('.ws-message-list')).toContainText('echo');
    await captureDocsScreenshot(page, 'request-websocket');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    await tourPause(page, 'WebSocket connect, send, echo, disconnect checked');

    await addRequestFromFolder(page, 'Auth', 'Socket.IO Request');
    await page.getByLabel('Request name').fill('Socket.IO chat');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('https://io.kurlo.test');
    await page.locator('.sio-event-name-input').fill('chat:message');
    await page.getByRole('checkbox', { name: 'Ack' }).check();
    await fillCodeEditor(page, 'socketio-message-editor', JSON.stringify({ text: 'hello sio' }, null, 2));
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.sio-panel')).toContainText('Connected');
    await page.locator('.sio-editor-toolbar .ws-message-send').click();
    await expect(page.locator('.sio-panel .ws-message-list')).toContainText('chat:message');
    await expect(page.locator('.sio-panel .ws-message-list')).toContainText('ack for "chat:message"');
    await captureDocsScreenshot(page, 'request-socketio');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    await tourPause(page, 'Socket.IO connect, emit, ack, disconnect checked');

    if (docsScreenshotDir) {
      await page.getByRole('button', { name: 'Collections' }).click();
      try { await page.locator('aside.sidebar').screenshot({ path: join(docsScreenshotDir, 'sidebar-collections.png'), animations: 'disabled' }); } catch (err) { console.log('docs screenshot sidebar-collections skipped:', err); }
      try {
        await page.getByLabel('Workspace switcher').click({ timeout: 4000 });
        await captureDocsScreenshot(page, 'workspace-switcher');
        await page.keyboard.press('Escape');
      } catch (err) { console.log('docs screenshot workspace-switcher skipped:', err); }
      try {
        await page.getByLabel('Workspace switcher').click({ timeout: 4000 });
        await page.getByRole('button', { name: 'View all workspaces' }).click({ timeout: 4000 });
        const workspaceNotes = page.getByLabel('Notes', { exact: true });
        await workspaceNotes.fill(
          [
            'Staging base URL: https://api.kurlo.test',
            'Auth: run Login user first — it writes {{token}} into the environment.',
            'Run the Smoke API collection before tagging a release.',
          ].join('\n'),
        );
        await workspaceNotes.blur();
        await page.locator('.workspace-overview').evaluate((overview) => { overview.scrollTop = 0; });
        await captureDocsScreenshot(page, 'workspace-overview');
        await workspaceNotes.fill('');
        await page.getByRole('button', { name: 'Git', exact: true }).click({ timeout: 4000 });
        await expect(page.locator('.git-workspace')).toContainText('feature/docs-refresh');
        await page.locator('.git-file-open').first().click();
        await expect(page.locator('.git-diff')).toContainText('oauth2RefreshToken');
        await captureDocsScreenshot(page, 'git-workspace');
      } catch (err) { console.log('docs screenshot workspace-overview skipped:', err); }
      try {
        await page.locator('.global-search').click({ timeout: 4000 });
        await expect(page.getByRole('dialog', { name: 'Search requests and commands' })).toBeVisible({ timeout: 4000 });
        await captureDocsScreenshot(page, 'global-search');
        await page.keyboard.press('Escape');
      } catch (err) { console.log('docs screenshot global-search skipped:', err); }
      await page.keyboard.press('Escape');
    }

    await page.getByLabel('Settings', { exact: true }).click();
    if (docsScreenshotDir) {
      try {
        await page.getByRole('tab', { name: 'General', exact: true }).click({ timeout: 4000 });
        await captureDocsScreenshot(page, 'settings-general');
      } catch (err) { console.log('docs screenshot settings-general skipped:', err); }
      try { await page.getByRole('tab', { name: 'Theme', exact: true }).click({ timeout: 4000 }); await captureDocsScreenshot(page, 'settings-theme'); } catch (err) { console.log('docs screenshot settings-theme skipped:', err); }
      try { await page.getByRole('tab', { name: 'Shortcuts', exact: true }).click({ timeout: 4000 }); await captureDocsScreenshot(page, 'settings-shortcuts'); } catch (err) { console.log('docs screenshot settings-shortcuts skipped:', err); }
      try { await page.getByRole('tab', { name: 'About', exact: true }).click({ timeout: 4000 }); await captureDocsScreenshot(page, 'settings-updates-dev'); } catch (err) { console.log('docs screenshot settings-updates-dev skipped:', err); }
      try { await page.getByRole('tab', { name: 'About', exact: true }).click({ timeout: 4000 }); await captureDocsScreenshot(page, 'settings-about'); } catch (err) { console.log('docs screenshot settings-about skipped:', err); }
    }
    await page.getByRole('tab', { name: 'Proxy', exact: true }).click();
    await page.getByRole('radio', { name: 'On', exact: true }).check();
    await page.locator('#proxy-hostname').fill('proxy.corp.example');
    await page.locator('#proxy-port').fill('8080');
    await page.locator('#proxy-bypass').fill('localhost, 127.0.0.1, .internal');
    await captureDocsScreenshot(page, 'settings-proxy');

    await page.getByRole('tab', { name: 'General', exact: true }).click();
    await page.locator('summary').filter({ hasText: 'Advanced data' }).click();
    await page.getByRole('button', { name: 'Export all data', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Export all data' })).toBeVisible();
    await captureDocsScreenshot(page, 'backup-export-warning');
    await page.getByRole('dialog', { name: 'Export all data' }).getByRole('button', { name: 'Cancel' }).click();
    await page.getByLabel('Close settings').click();

    const state = await page.evaluate(() => window.__kurloE2E);
    expect(state.sentRequests).toHaveLength(4);
    const sentTo = (target: string) => state.sentRequests.some(req => {
      try {
        const url = new URL(String(req.url));
        return `${url.origin}${url.pathname}` === target;
      } catch {
        return false;
      }
    });
    expect(sentTo('https://api.kurlo.test/login')).toBe(true);
    expect(sentTo('https://api.kurlo.test/graphql')).toBe(true);
    expect(state.sentRequests.some(req => String(req.body).includes(requestPassword))).toBe(true);
    expect(state.sseConnects).toHaveLength(1);
    expect(state.grpcDiscoveries.some(req => String(req.target).includes('grpc.kurlo.test:443'))).toBe(true);
    expect(state.sentGrpcRequests.some(req => String(req.fullMethod).includes('shop.Inventory/GetItem'))).toBe(true);
    expect(state.webSocketConnects).toHaveLength(1);
    expect(state.webSocketMessages.some(entry => String(entry.message?.data).includes('hello'))).toBe(true);
    expect(state.socketIOConnects).toHaveLength(1);
    expect(state.socketIOEmits.some(entry => entry.message?.eventName === 'chat:message')).toBe(true);
    expect(state.savedStores.length).toBeGreaterThan(4);
    expect(state.savedFiles.some(file => file.content.includes('Kurlo collection runner report'))).toBe(true);
  });

  test('renders an ordinary JSON response without virtualization', async ({ page }) => {
    const ordinaryResponsePath = process.env.KURLO_E2E_ORDINARY_RESPONSE_PATH;
    const responseBody = ordinaryResponsePath
      ? await readFile(ordinaryResponsePath, 'utf8')
      : JSON.stringify({
        resources: Array.from({ length: 60 }, (_, index) => ({
          id: `resource-${index}`,
          title: `exampleEditForAutotest-${index}`,
          path: `widget-kind/resource-${index}.json`,
        })),
      }, null, 2);
    const formattedResponseBody = JSON.stringify(JSON.parse(responseBody), null, 2);
    expect(formattedResponseBody.split('\n').length).toBeGreaterThan(250);

    await installKurloBridge(page, responseBody);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/large-response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();

    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).not.toHaveAttribute('data-virtualized', 'true');
    await expect(viewer.locator('.response-line')).toHaveCount(formattedResponseBody.split('\n').length);
    await viewer.evaluate((element) => {
      for (const top of [400, 1_200, 2_400, 4_000, 1_600]) {
        element.scrollTop = top;
        element.dispatchEvent(new Event('scroll'));
      }
    });
    await expect(viewer.locator('.response-line-no')).toHaveCount(formattedResponseBody.split('\n').length);
  });

  test('virtualizes a large JSON response while scrolling', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    const realResponsePath = process.env.KURLO_E2E_REAL_RESPONSE_PATH;
    const realResponseBody = realResponsePath ? await readFile(realResponsePath, 'utf8') : '';
    await installKurloBridge(page, realResponseBody);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await expect(page.getByLabel('Request URL')).toBeVisible();
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/large-response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();

    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).toHaveAttribute('data-virtualized', 'true');
    const renderedLines = viewer.locator('.response-line');
    await expect(renderedLines).not.toHaveCount(0);
    expect(await renderedLines.count()).toBeLessThan(200);
    const gutter = viewer.locator('.response-gutter');
    expect(await gutter.evaluate(element => getComputedStyle(element).position)).toBe('sticky');
    await captureDocsScreenshot(page, 'response-viewer-large-body');

    await viewer.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(async () => Number(
      await renderedLines.first().getAttribute('data-line-number'),
    )).toBeGreaterThan(1_000);
    expect(await renderedLines.count()).toBeLessThan(200);
    const firstGutterNumber = gutter.locator('.response-line-no').first();
    expect(await firstGutterNumber.getAttribute('data-line-number')).toBe(await renderedLines.first().getAttribute('data-line-number'));
    const gutterLeft = await firstGutterNumber.evaluate(
      element => Math.round(element.getBoundingClientRect().left),
    );
    await viewer.evaluate((element) => {
      element.scrollLeft = 240;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(async () => firstGutterNumber.evaluate(
      element => Math.round(element.getBoundingClientRect().left),
    )).toBe(gutterLeft);


    await page.getByLabel('Search response').click();
    const realCategoryName = realResponseBody
      ? (JSON.parse(realResponseBody) as { Categories?: Array<{ Name?: unknown }> }).Categories?.[0]?.Name
      : undefined;
    const uniqueQuery = realResponseBody ? JSON.stringify(realCategoryName) : 'Product 10-3"';
    await page.getByLabel('Search response body').fill(uniqueQuery);
    await expect(page.locator('.response-search-count')).toHaveText('1/1');
    await expect(viewer.locator('.rsp-search-current')).toContainText(uniqueQuery);
    await expect.poll(async () => Number(
      await renderedLines.first().getAttribute('data-line-number'),
    )).toBeLessThan(1_000);
    expect(await renderedLines.count()).toBeLessThan(200);
  });

  test('keeps a large response painted while its scrollbar is dragged', async ({ page }) => {
    const photos = JSON.stringify(Array.from({ length: 5_000 }, (_, index) => ({
      albumId: Math.floor(index / 50) + 1,
      id: index + 1,
      title: `photo ${index + 1}`,
      url: `https://via.placeholder.com/600/${index}`,
      thumbnailUrl: `https://via.placeholder.com/150/${index}`,
    })), null, 2);
    await installKurloBridge(page, photos);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/large-response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();

    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).toHaveAttribute('data-virtualized', 'true');
    const thumb = page.locator('.response-vscroll-thumb');
    await expect(thumb).toBeVisible();
    expect(await viewer.evaluate(element => element.offsetWidth - element.clientWidth)).toBe(0);

    const drag = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.response-body-viewer.virtualized')!;
      const handle = document.querySelector<HTMLElement>('.response-vscroll-thumb')!;
      const viewerRect = scroller.getBoundingClientRect();
      const handleRect = handle.getBoundingClientRect();
      const x = handleRect.left + handleRect.width / 2;
      let y = handleRect.top + 4;
      const pointer = { bubbles: true, pointerId: 7, isPrimary: true, clientX: x };
      handle.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, button: 0, clientY: y }));
      let blankSteps = 0;
      const steps = 40;
      for (let step = 0; step < steps; step += 1) {
        y += (viewerRect.height - handleRect.height) / steps;
        handle.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientY: y }));
        const probe = viewerRect.top + viewerRect.height / 2;
        const covered = Array.from(scroller.querySelectorAll<HTMLElement>('.response-virtual-code .response-line')).some((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top <= probe && rect.bottom > probe;
        });
        if (!covered) blankSteps += 1;
      }
      handle.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientY: y }));
      return { blankSteps, top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight };
    });
    expect(drag.blankSteps).toBe(0);
    expect(drag.top).toBeGreaterThan(drag.max * 0.9);

    const owned = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.response-body-viewer.virtualized')!;
      const viewerRect = scroller.getBoundingClientRect();
      const coveredAt = (selector: string, y: number) => Array.from(scroller.querySelectorAll<HTMLElement>(selector)).some((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top <= y && rect.bottom > y;
      });
      const painted = () => {
        const probes = [viewerRect.top + viewerRect.height / 2, viewerRect.bottom - 30];
        return probes.every(y => coveredAt('.response-virtual-code .response-line', y) && coveredAt('.response-gutter .response-line-no', y));
      };
      let blank = 0;
      let slowest = 0;
      const timed = (fire: () => void) => {
        const started = performance.now();
        fire();
        slowest = Math.max(slowest, performance.now() - started);
        if (!painted()) blank += 1;
      };
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
      for (let step = 0; step < 30; step += 1) {
        timed(() => scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 3_000, bubbles: true, cancelable: true })));
      }
      const afterWheel = scroller.scrollTop;
      const key = (init: KeyboardEventInit) => timed(() => scroller.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
      key({ key: 'Home' });
      const afterHome = scroller.scrollTop;
      key({ key: 'End' });
      const afterEnd = scroller.scrollTop;
      key({ key: 'ArrowUp', metaKey: true });
      key({ key: 'ArrowDown', metaKey: true });
      const afterCommandDown = scroller.scrollTop;
      key({ key: 'PageUp' });
      const afterPageUp = scroller.scrollTop;
      return { blank, slowest, afterWheel, afterHome, afterEnd, afterCommandDown, afterPageUp, max: scroller.scrollHeight - scroller.clientHeight, page: scroller.clientHeight };
    });
    expect(owned.blank).toBe(0);
    expect(owned.afterWheel).toBe(90_000);
    expect(owned.afterHome).toBe(0);
    expect(owned.afterEnd).toBe(owned.max);
    expect(owned.afterCommandDown).toBe(owned.max);
    expect(owned.max - owned.afterPageUp).toBeGreaterThan(owned.page / 2);
    console.log(`slowest synchronous scroll render: ${owned.slowest.toFixed(1)} ms`);

    await viewer.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(async () => (await thumb.boundingBox())?.y ?? 0).toBeLessThan((await viewer.boundingBox())!.y + 4);
    const start = (await thumb.boundingBox())!;
    const viewerBox = (await viewer.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + 4);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2, viewerBox.y + viewerBox.height + 40, { steps: 12 });
    await page.mouse.up();
    await expect.poll(async () => Number(
      await viewer.locator('.response-virtual-code .response-line').last().getAttribute('data-line-number'),
    )).toBe(photos.split('\n').length);

    await page.mouse.move(start.x + start.width / 2, viewerBox.y + 10);
    await page.mouse.wheel(0, -600);
    await expect.poll(async () => viewer.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(300);
  });

  test('keeps sidebar arrow shortcuts out of the response body and dialogs', async ({ page }) => {
    const photos = JSON.stringify(Array.from({ length: 5_000 }, (_, index) => ({ id: index + 1, title: `photo ${index + 1}` })), null, 2);
    await installKurloBridge(page, photos);
    await page.goto('/');
    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Orders API');
    for (const name of ['First', 'Second']) {
      await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
      await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
      await chooseRequestType(page, 'HTTP Request');
      await page.getByLabel('Request name').fill(name);
      await page.getByLabel('Request name').press('Enter');
      await page.getByLabel('Request URL').fill('https://api.kurlo.test/large-response');
    }
    await page.locator('.collection-request').filter({ hasText: 'First' }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();
    const activeTab = page.locator('.saved-request-tab.active');
    await expect(activeTab).toContainText('First');

    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).toHaveAttribute('data-virtualized', 'true');
    await viewer.click();
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => viewer.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowLeft');
    await expect(activeTab).toContainText('First');
    await expect(viewer).toBeVisible();

    await page.getByLabel('Settings', { exact: true }).click();
    const settingsTheme = page.getByRole('tab', { name: 'Theme', exact: true });
    await settingsTheme.click();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('tab', { name: 'Proxy', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByLabel('Close settings').click();
    await expect(activeTab).toContainText('First');
  });

  test('pins the line numbers while a wide virtualized response scrolls', async ({ page }) => {
    const wideBody = JSON.stringify(Array.from({ length: 1_500 }, (_, index) => ({
      id: index,
      payload: `row-${index}-`.padEnd(2_000, 'x'),
    })), null, 2);
    await installKurloBridge(page, wideBody);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/large-response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();

    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).toHaveAttribute('data-virtualized', 'true');
    const gutter = viewer.locator('.response-gutter');
    const gutterLeft = await gutter.evaluate(element => Math.round(element.getBoundingClientRect().left));

    await viewer.evaluate((element) => {
      element.scrollTop = 20_000;
      element.scrollLeft = 900;
      element.dispatchEvent(new Event('scroll'));
    });
    expect(await viewer.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await expect.poll(async () => Number(
      await viewer.locator('.response-line').first().getAttribute('data-line-number'),
    )).toBeGreaterThan(500);

    expect(await gutter.evaluate(element => Math.round(element.getBoundingClientRect().left))).toBe(gutterLeft);
    const alignment = await viewer.evaluate((element) => {
      const numbers = Array.from(element.querySelectorAll<HTMLElement>('.response-gutter .response-line-no'));
      const rows = Array.from(element.querySelectorAll<HTMLElement>('.response-virtual-code .response-line'));
      const viewerRect = element.getBoundingClientRect();
      const probeY = viewerRect.top + viewerRect.height / 2;
      const number = numbers.find(node => {
        const rect = node.getBoundingClientRect();
        return rect.top <= probeY && rect.bottom > probeY;
      });
      const row = rows.find(node => node.dataset.lineNumber === number?.dataset.lineNumber);
      const hit = document.elementFromPoint(viewerRect.left + 20, probeY);
      return {
        sameCount: numbers.length === rows.length,
        offset: number && row ? Math.abs(number.getBoundingClientRect().top - row.getBoundingClientRect().top) : -1,
        gutterOnTop: Boolean(hit?.closest('.response-gutter')),
      };
    });
    expect(alignment.sameCount).toBe(true);
    expect(alignment.offset).toBeGreaterThanOrEqual(0);
    expect(alignment.offset).toBeLessThan(1);
    expect(alignment.gutterOnTop).toBe(true);
  });

  test('creates requests of each protocol without a chooser dialog', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await expect(page.getByRole('dialog', { name: 'New request' })).toHaveCount(0);
    await expect(page.getByLabel('Method and protocol')).toHaveText('GET');

    const palette = page.getByRole('dialog', { name: 'Search requests and commands' });
    const input = palette.getByRole('combobox', { name: 'Search requests and commands' });
    await page.locator('.global-search').click();
    await input.fill('> new websocket');
    await expect(palette.getByRole('option').first()).toHaveAttribute('data-command-id', 'create-request-ws');
    await input.press('Enter');
    await expect(page.getByRole('dialog', { name: 'New request' })).toHaveCount(0);
    await expect(page.getByLabel('Method and protocol')).toHaveText('WS');
  });

  test('runs default and rebound shortcuts on Windows and Linux, and shows their keycaps', async ({ page }) => {
    for (const runtime of ['windows/e2e', 'linux/e2e']) {
      await installKurloBridge(page, '', runtime);
      await page.goto('/');
      const requestTabs = page.locator('.saved-request-tab:not(.overview-request-tab)');
      await expect(requestTabs).toHaveCount(1);
      await page.getByLabel('New unsaved request').click();
      await expect(requestTabs).toHaveCount(2);
      await page.getByLabel('Request URL').click();
      await page.keyboard.press('Control+Alt+\\');
      await expect(page.locator('.code-snippet-panel')).toBeVisible();
      await page.keyboard.press('Control+Alt+\\');
      await expect(page.locator('.code-snippet-panel')).toBeHidden();
      await page.keyboard.press('Control+w');
      await expect(requestTabs).toHaveCount(1);

      const searchKeys = page.locator('.global-search .keycaps');
      await expect(searchKeys).toHaveAttribute('aria-label', 'Ctrl+K');

      await page.keyboard.press('Control+,');
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await settings.getByRole('tab', { name: 'Shortcuts', exact: true }).click();
      const searchRow = settings.locator('.shortcut-row').filter({ has: page.getByText('Search', { exact: true }) });
      await searchRow.locator('.shortcut-combo').click();
      await page.keyboard.press('Control+Alt+P');
      await expect(searchRow.locator('.keycaps')).toHaveAttribute('aria-label', 'Ctrl+Alt+P');
      await page.keyboard.press('Escape');
      await expect(settings).toBeHidden();
      await expect(searchKeys).toHaveAttribute('aria-label', 'Ctrl+Alt+P');
      await page.keyboard.press('Control+Alt+P');
      await expect(page.getByRole('dialog', { name: 'Search requests and commands' })).toBeVisible();
      await page.keyboard.press('Escape');
    }
  });

  test('runs the request, view, create and tab shortcuts', async ({ page }) => {
    await installKurloBridge(page, '', 'windows/e2e');
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    const url = page.getByLabel('Request URL');
    await url.fill('https://api.kurlo.test/slow?ms=4000');
    const send = page.locator('.send-split .btn-send');
    await url.press('Control+Enter');
    await expect(send).toHaveText(/Cancel/);
    await url.press('Escape');
    await expect(send).toHaveText(/^Send/);
    await expect(page.getByText('Request canceled')).toBeVisible();

    await url.fill('https://api.kurlo.test/users');
    await url.press('Control+Shift+C');
    await expect(page.locator('.curl-toast')).toHaveText('Copied as cURL');

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Alt+2');
    await expect(page.locator('.sidebar')).toContainText(/Environments/);
    await page.keyboard.press('Control+Alt+3');
    await expect(page.locator('.sidebar')).toContainText(/History/);
    await page.keyboard.press('Control+Alt+1');

    const layout = () => page.evaluate(() => localStorage.getItem('kurlo.responseLayout.v1'));
    const before = await layout();
    await page.keyboard.press('Control+Alt+V');
    await expect.poll(layout).not.toBe(before);

    await page.keyboard.press('Control+Alt+E');
    await expect(page.locator('.environment-menu')).toBeVisible();
    await expect(page.locator('.environment-menu .menu-item').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.environment-menu')).toHaveCount(0);

    await page.keyboard.press('Control+O');
    await expect(page.getByRole('dialog', { name: 'Import collection' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Import collection' })).toHaveCount(0);

    await page.keyboard.press('Control+Shift+N');
    const prompt = page.getByRole('dialog', { name: 'New collection' });
    await expect(prompt).toBeVisible();
    await prompt.getByRole('textbox').fill('Shortcut collection');
    await prompt.getByRole('textbox').press('Enter');
    await expect(collectionRow(page, 'Shortcut collection')).toBeVisible();

    await page.keyboard.press('Control+Shift+R');
    await expect(page.getByRole('button', { name: 'Collection runner', exact: true })).toHaveClass(/active/);

    const closeButtons = page.locator('.saved-request-tab').getByRole('button', { name: 'Close tab', exact: true });
    await page.getByLabel('New unsaved request').click();
    await page.getByLabel('New unsaved request').click();
    const opened = await closeButtons.count();
    expect(opened).toBeGreaterThanOrEqual(3);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Alt+Shift+W');
    const saveDraft = page.getByRole('dialog', { name: 'Save request' });
    await expect(saveDraft).toBeVisible();
    await saveDraft.getByRole('button', { name: 'Discard' }).click();
    await expect(closeButtons).toHaveCount(1);
    await page.getByLabel('New unsaved request').click();
    await expect(closeButtons).toHaveCount(2);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Shift+W');
    await expect(closeButtons).toHaveCount(0);
  });

  test('lays out the shortcut settings without sideways scrolling and with aligned keycaps', async ({ page }) => {
    await installKurloBridge(page, '', 'darwin/e2e');
    await page.goto('/');
    await page.getByRole('button', { name: /^Settings/ }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('tab', { name: 'Shortcuts', exact: true }).click();
    const list = settings.locator('.shortcut-list');
    await expect(list.locator('.shortcut-row').first()).toBeVisible();
    const layout = await list.evaluate(el => {
      const textLeft = (node: Element) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect().left;
      };
      const body = el.closest('.settings-body') as HTMLElement;
      const glyphs = [...el.querySelectorAll('.keycaps-md .keycap-glyph')].map(cap => Math.round(cap.getBoundingClientRect().width));
      const lastCaps = [...el.querySelectorAll('.shortcut-row .keycaps')].map(caps => Math.round(caps.lastElementChild!.getBoundingClientRect().right));
      return {
        listScrolls: el.scrollWidth > el.clientWidth + 1,
        bodyScrolls: body.scrollWidth > body.clientWidth + 1,
        glyphWidths: new Set(glyphs).size,
        rightEdges: new Set(lastCaps).size,
        headingAligned: Math.round(textLeft(el.querySelector('.shortcut-group h3')!)) === Math.round(textLeft(el.querySelector('.shortcut-row > span')!)),
      };
    });
    expect(layout).toEqual({ listScrolls: false, bodyScrolls: false, glyphWidths: 1, rightEdges: 1, headingAligned: true });
    await list.screenshot({ path: test.info().outputPath('shortcuts.png') });
  });

  test('sends a WebSocket message with the send shortcut and stays connected', async ({ page }) => {
    await installKurloBridge(page, '', 'windows/e2e');
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'WebSocket Request');
    await page.getByLabel('Request URL').fill('wss://ws.kurlo.test/socket');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.ws-panel')).toContainText('Connected');
    await fillCodeEditor(page, 'websocket-message-editor', JSON.stringify({ hello: 'shortcut' }));
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.ws-message-list')).toContainText('shortcut');
    await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
  });

  test('shows what is new after an update and skips the changelog otherwise', async ({ page }) => {
    const changelogRequests: string[] = [];
    page.on('request', request => {
      const url = decodeURIComponent(request.url());
      if (url.includes('kurlo-changelog') && !url.includes('kurlo-changelog-meta')) changelogRequests.push(url);
    });
    await installKurloBridge(page);
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('kurlo-e2e-updated')) {
        sessionStorage.setItem('kurlo-e2e-updated', '1');
        localStorage.setItem('kurlo:last-seen-version', '2.0.2');
      } else {
        localStorage.setItem('kurlo:last-seen-version', '2.0.3');
      }
      const app = (window as any).go.api.App;
      app.AppInfo = async () => ({ name: 'Kurlo', version: '2.0.3', runtime: 'browser/e2e', goVersion: 'e2e' });
    });
    await page.goto('/');

    const whatsNew = page.getByRole('dialog', { name: /What's new in Kurlo/ });
    await expect(whatsNew).toBeVisible();
    await expect(whatsNew).toContainText('2.0.3');
    expect(changelogRequests.length).toBeGreaterThan(0);

    changelogRequests.length = 0;
    await page.goto('/');
    await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(whatsNew).toHaveCount(0);
    expect(changelogRequests).toEqual([]);
  });

  test('opens the full release notes in the system browser', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    const palette = page.getByRole('dialog', { name: 'Search requests and commands' });
    await page.locator('.global-search').click();
    await palette.getByRole('combobox', { name: 'Search requests and commands' }).fill("> what's new");
    await palette.getByRole('combobox', { name: 'Search requests and commands' }).press('Enter');
    const whatsNew = page.getByRole('dialog', { name: /What's new in Kurlo/ });
    await expect(whatsNew).toBeVisible();
    await whatsNew.getByRole('link', { name: 'Full release notes' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('open:')))).toEqual([
      expect.stringMatching(/^open:https:\/\/github\.com\/stormhop\/kurlo\/releases\/tag\/v\d/),
    ]);
    await expect(page).toHaveURL(/127\.0\.0\.1/);
  });

  test('runs commands from the command palette', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/users');

    const palette = page.getByRole('dialog', { name: 'Search requests and commands' });
    const input = palette.getByRole('combobox', { name: 'Search requests and commands' });

    await page.locator('.global-search').click();
    await expect(palette).toBeVisible();
    await expect(palette.locator('.palette-section').first()).toBeVisible();
    await expect(palette.getByRole('option', { name: /Send request/ })).toBeVisible();

    await input.fill('> history');
    await expect(palette.locator('.global-search-item')).toHaveCount(0);
    await expect(palette.getByRole('option').first()).toHaveAttribute('data-command-id', 'go-history');
    await input.press('Enter');
    await expect(palette).toBeHidden();
    await expect(page.locator('.history-panel')).toBeVisible();

    await page.locator('.global-search').click();
    await input.fill('> response');
    const layoutOption = palette.getByRole('option', { name: /Show response below the request/ });
    await expect(layoutOption).toBeVisible();
    await input.press('ArrowDown');
    await input.press('ArrowUp');
    await expect(layoutOption).toHaveAttribute('aria-selected', 'true');
    await input.press('Enter');
    expect(await page.evaluate(() => localStorage.getItem('kurlo.responseLayout.v1'))).toBe('below');

    await page.locator('.global-search').click();
    await input.fill('> response');
    await expect(palette.getByRole('option', { name: /Show response beside the request/ })).toBeVisible();
    await input.press('Escape');
    await expect(palette).toBeHidden();
  });

  test('closes a labelled dropdown after an option is picked', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Billing');
    await page.getByRole('button', { name: 'Collection runner' }).click();

    const picker = page.locator('.runner-select');
    const trigger = picker.locator('.app-select-trigger');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await picker.getByRole('option', { name: 'Billing' }).click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(picker.getByRole('option')).toHaveCount(0);
    await expect(trigger).toContainText('Billing');
  });

  test('keeps wrapped response lines inside the viewer gutter', async ({ page }) => {
    const nestedPackage = JSON.stringify({
      name: '@kurlo/factory',
      title: 'Release validation package for a frontend factory workspace',
      scripts: {
        'lint:fix': './node_modules/.bin/lint-fix',
        validate: './node_modules/.bin/configurator validate',
      },
      version: '16.7.0-rc.16',
      description: 'Contains schema definitions for frontend release validation',
      dependencies: {
        '@kurlo/factory': '>=16.7.0-rc.0 <17.0.0',
        '@kurlo-uiremote/chat': '~16.5.0',
        '@kurlo-uiremote/calendar': '~16.6.1',
      },
    }, null, 2);
    const responseBody = JSON.stringify({ content: nestedPackage }, null, 2);
    await installKurloBridge(page, responseBody);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/large-response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();

    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).not.toHaveAttribute('data-virtualized', 'true');
    const wrappedLine = viewer.locator('.response-line[data-line-number="2"]');
    await expect(wrappedLine).toBeVisible();
    await wrappedLine.hover();

    const metrics = await wrappedLine.evaluate((line) => {
      const viewerNode = line.closest('.response-body-viewer') as HTMLElement;
      const gutterNode = line.querySelector('.response-line-no') as HTMLElement;
      const lineRect = line.getBoundingClientRect();
      const gutterRect = gutterNode.getBoundingClientRect();
      return {
        clientWidth: viewerNode.clientWidth,
        gutterHeight: gutterRect.height,
        lineHeight: lineRect.height,
        scrollWidth: viewerNode.scrollWidth,
      };
    });

    expect(metrics.lineHeight).toBeGreaterThan(40);
    expect(Math.abs(metrics.gutterHeight - metrics.lineHeight)).toBeLessThan(1);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  });

  test('Git panel commits Kurlo changes, and writes the pending edit first', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();

    await setGitStatus(page, {
      isRepo: true,
      workspaceRoot: '/workspace',
      root: '/workspace',
      branch: 'main',
      head: 'a1b2c3d',
      upstream: 'origin/main',
      remotes: ['origin'],
      clean: false,
      files: [{ path: 'workspaces/Main/collections/API/requests/Login.yml', index: ' ', worktree: 'M', status: 'modified' }],
    });

    await openGitPanel(page);
    await expect(page.getByText('Login.yml')).toBeVisible();

    await page.evaluate(() => { window.__kurloE2E.calls.length = 0; });
    await page.getByRole('button', { name: 'Commit all', exact: true }).first().click();
    await fillPrompt(page, 'Commit Kurlo workspace', 'Update the login request');

    const calls = await page.evaluate(() => window.__kurloE2E.calls);
    const saveIndex = calls.indexOf('SaveRequestStore');
    const commitIndex = calls.findIndex(call => call.startsWith('GitCommitWorkspace:'));

    expect(commitIndex).toBeGreaterThan(-1);
    expect(calls[commitIndex]).toBe('GitCommitWorkspace:Update the login request');
    expect(saveIndex).toBeGreaterThan(-1);
    expect(saveIndex).toBeLessThan(commitIndex);
  });

  for (const layout of [{ width: 1500, scale: 1 }, { width: 1000, scale: 1.25 }]) {
    test(`Git panel keeps workspace issues, history and output readable at ${layout.width}px and ${layout.scale} scale`, async ({ page }) => {
      await page.setViewportSize({ width: layout.width, height: 780 });
      await installKurloBridge(page);
      await page.addInitScript(scale => localStorage.setItem('kurlo.uiScale.v1', String(scale)), layout.scale);
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
      await setGitStatus(page, {
        isRepo: true, root: '/workspace', workspaceRoot: '/workspace',
        branch: 'main', head: 'a1b2c3d', upstream: 'origin/main', remotes: ['origin'],
        clean: false,
        files: [{ path: 'workspaces/Main/collections/API/examples/Login/403.body.txt', index: '?', worktree: '?', status: 'untracked' }],
      });
      await page.evaluate(() => {
        const app = window.go.api.App;
        app.LoadWorkspaceDiagnostics = async () => [
          {
            scope: 'store', severity: 'error', blocking: true, path: 'workspaces/Main/collections/HB-copy/collection.yml',
            message: 'This collection has the same id "collection-fb71d1c7-ca15-45e0-bb05-e127ac36fa75" as workspaces/Main/collections/HB/collection.yml, so the folder looks like a copy. Give the copy and everything inside it new ids, or remove it.',
          },
          {
            scope: 'store', severity: 'error', blocking: true, path: 'workspaces/Main/collections/API/collection.yml',
            message: 'collection.yml is missing but its child files remain. Restore the collection file before saving.',
          },
        ];
        app.GitCommitLogPage = async (limit, offset) => ({
          git: await app.GitStatus(), limit, offset, hasMore: false, error: '', output: '',
          commits: Array.from({ length: 12 }, (_, index) => ({
            hash: `commit-${index}`, shortHash: `hash-${index}`, author: 'Workspace author',
            date: '2026-10-06', message: index ? 'Update workspace files' : 'Restore original workspace ID',
          })),
        });
        app.GitPullWorkspaceWithStrategy = async () => ({
          ok: true, root: '/workspace', payload: JSON.stringify(window.__kurloE2E.store),
          git: await app.GitStatus(), diagnostics: await app.LoadWorkspaceDiagnostics(),
          missingSecrets: [], error: '',
          output: 'Updating 2e346da..55a5b55\nFast-forward\nworkspaces/Main/workspace.yml | 2 +-\n1 file changed, 1 insertion(+), 1 deletion(-)',
        });
      });
      await openGitPanel(page);
      await page.getByRole('button', { name: 'Pull', exact: true }).click();
      await expect(page.locator('.git-yaml-card')).toContainText('2 workspace files need fixing');
      await expect(page.locator('.git-yaml-row')).toHaveCount(2);
      await expect(page.locator('.git-yaml-row').first()).toContainText('collections/HB-copy');
      await expect(page.getByRole('button', { name: 'Commit all', exact: true })).toBeDisabled();
      expect(await page.locator('.git-layout').evaluate(grid => getComputedStyle(grid).borderTopWidth)).toBe('1px');
      await page.getByRole('tab', { name: 'History' }).click();

      await expect.poll(() => page.locator('.git-workspace').evaluate(panel => {
        const card = panel.querySelector<HTMLElement>('.git-yaml-card')!;
        const grid = panel.querySelector<HTMLElement>('.git-layout')!;
        const toolbar = panel.querySelector<HTMLElement>('.git-toolbar')!;
        const content = panel.querySelector<HTMLElement>('.git-content')!;
        const rows = [...panel.querySelectorAll<HTMLElement>('.git-commit-row')];
        const diagnostics = [...panel.querySelectorAll<HTMLElement>('.git-yaml-row')];
        return grid.getBoundingClientRect().top >= card.getBoundingClientRect().bottom - 1
          && toolbar.scrollWidth <= toolbar.clientWidth + 1
          && content.scrollWidth <= content.clientWidth + 1
          && rows.length > 1
          && rows.every(row => row.querySelector('span')!.getBoundingClientRect().bottom <= row.getBoundingClientRect().bottom + 1)
          && rows.slice(1).every((row, index) => row.getBoundingClientRect().top >= rows[index].getBoundingClientRect().bottom - 1)
          && diagnostics.every(row => {
            const edit = row.querySelector('button')!.getBoundingClientRect();
            const bounds = row.getBoundingClientRect();
            return row.scrollWidth <= row.clientWidth + 1 && edit.right <= bounds.right && edit.bottom <= bounds.bottom;
          });
      })).toBe(true);

      await page.getByRole('tab', { name: /Changes/ }).click();
      await expect(page.locator('.git-commit-list')).toHaveCount(0);
      await expect(page.locator('.git-file-row')).toHaveCount(1);
      await page.getByRole('tab', { name: 'History' }).click();
      await expect(page.locator('.git-commit-list')).toBeVisible();
      await expect(page.locator('.git-output-log')).toHaveCount(0);
      await page.getByRole('button', { name: 'More Git actions' }).click();
      await page.getByRole('menuitem', { name: 'Show Git output' }).click();
      const outputDialog = page.getByRole('dialog');
      await expect(outputDialog.getByRole('heading', { name: 'Git output' })).toBeVisible();
      await expect(outputDialog.locator('.git-output-log')).toContainText('Fast-forward');
      await outputDialog.getByRole('button', { name: 'Close Git output' }).click();
      await expect(page.locator('.git-output-log')).toHaveCount(0);
    });
  }

  test('Git branch picker lists each branch once and keeps remote actions on the tracking branch', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 820 });
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await setGitStatus(page, {
      isRepo: true, root: '/workspace', workspaceRoot: '/workspace',
      branch: 'main', head: 'a1b2c3d', upstream: 'origin/main', remotes: ['origin'], clean: true, files: [],
    });
    await setGitBranches(page, {
      ok: true, git: {}, current: 'main', error: '', output: '',
      localBranches: [
        { name: 'main', fullName: 'main', remote: '', current: true, upstream: 'origin/main' },
        { name: 'feature', fullName: 'feature', remote: '', current: false, upstream: 'origin/feature' },
        { name: 'stale', fullName: 'stale', remote: '', current: false, upstream: 'origin/stale' },
      ],
      remoteBranches: [
        { name: 'main', fullName: 'origin/main', remote: 'origin', current: false, upstream: '' },
        { name: 'feature', fullName: 'origin/feature', remote: 'origin', current: false, upstream: '' },
        { name: 'release', fullName: 'origin/release', remote: 'origin', current: false, upstream: '' },
      ],
    });
    await openGitPanel(page);
    await page.locator('.git-branch-chip').click();
    const picker = page.getByRole('dialog', { name: 'Switch branch' });
    const rows = picker.locator('.git-branch-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toHaveAttribute('aria-current', 'true');
    await expect(rows.first()).toContainText('origin/main');
    await expect(picker.locator('.git-branch-row', { hasText: 'stale' })).toContainText('gone');
    await expect(picker.locator('.git-branch-row', { hasText: 'release' })).toContainText('remote only');
    await expect(picker.locator('.git-branch-popover-foot')).toHaveCount(0);

    await picker.getByRole('button', { name: 'Actions for feature' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Delete from origin' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Rename on origin' })).toBeVisible();
    await picker.getByRole('button', { name: 'Actions for feature' }).click();
    await expect(menu).toHaveCount(0);

    await picker.getByLabel('Filter branches').fill('rele');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('origin/release');
  });

  test('Git changes and history share the left panel and a commit opens in the diff', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 820 });
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await setGitStatus(page, {
      isRepo: true, root: '/workspace', workspaceRoot: '/workspace',
      branch: 'main', head: 'a1b2c3d', upstream: 'origin/main', remotes: ['origin'], clean: false,
      files: [{ path: 'kurlo.yml', index: ' ', worktree: 'M', status: 'modified', managed: true }],
    });
    await page.evaluate(() => {
      const app = window.go.api.App;
      app.GitCommitLogPage = async (limit, offset) => ({
        git: await app.GitStatus(), limit, offset, hasMore: false, error: '', output: '',
        commits: [{ hash: 'abc1234def', shortHash: 'abc1234', author: 'Evgeny', date: '2026-10-06', message: 'Restore original workspace ID' }],
      });
      app.GitCommitDiff = async (hash) => ({ path: hash, diff: '@@ -1 +1 @@\n-old\n+new', stagedDiff: '', unstagedDiff: '', binary: false, truncated: false, error: '' });
    });
    await openGitPanel(page);
    await expect(page.locator('.git-layout > *')).toHaveCount(2);
    await expect(page.getByText('Clean', { exact: true })).toHaveCount(0);
    const changes = page.getByRole('tab', { name: /Changes/ });
    await expect(changes).toHaveAttribute('aria-selected', 'true');
    await expect(changes).toContainText('1');
    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.locator('.git-history')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh commit history' })).toHaveCount(0);
    await page.locator('.git-commit-row').first().click();
    await expect(page.locator('.git-diff .git-panel-title')).toContainText('Restore original workspace ID');
    await expect(page.locator('.git-diff .git-panel-title')).toContainText('abc1234 · Evgeny');
  });

  test('Git panel shows a pulled syntax error in a workspace that is not open', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await setGitStatus(page, {
      isRepo: true, root: '/workspace', workspaceRoot: '/workspace',
      branch: 'main', head: 'a665a49', upstream: 'origin/main', remotes: ['origin'], clean: true, files: [],
    });
    await page.evaluate(() => {
      const app = window.go.api.App;
      app.LoadWorkspaceDiagnostics = async () => [{
        scope: 'workspace', severity: 'error', blocking: true, path: 'workspaces/My-Workspace/workspace.yml',
        line: 5, message: "line 5: could not find expected ':'",
      }];
      app.GitPullWorkspaceWithStrategy = async () => ({
        ok: true, root: '/workspace', payload: JSON.stringify(window.__kurloE2E.store),
        git: await app.GitStatus(), diagnostics: await app.LoadWorkspaceDiagnostics(),
        missingSecrets: [], error: '', output: '',
      });
    });
    await openGitPanel(page);
    await page.getByRole('button', { name: 'Pull', exact: true }).click();
    const row = page.locator('.git-yaml-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('workspace.yml:5');
    await expect(row).toContainText('Workspace “My Workspace” stays locked until this is fixed');
    await expect(page.locator('.git-yaml-card')).toContainText('1 workspace file could not be loaded');
  });

  test('Git history loads older commits while scrolling a 5000-commit repository', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await setGitStatus(page, {
      isRepo: true, root: '/workspace', workspaceRoot: '/workspace',
      branch: 'main', head: 'c0', upstream: 'origin/main', remotes: ['origin'], clean: true, files: [],
    });
    await page.evaluate(() => {
      const app = window.go.api.App;
      const total = 5000;
      const calls: number[] = [];
      (window as unknown as { __logCalls: number[] }).__logCalls = calls;
      app.GitCommitLogPage = async (limit: number, offset: number) => {
        calls.push(offset);
        await new Promise(resolve => setTimeout(resolve, 150));
        const end = Math.min(total, offset + limit);
        return {
          git: await app.GitStatus(), limit, offset, hasMore: end < total, error: '', output: '',
          commits: Array.from({ length: end - offset }, (_, index) => ({
            hash: `c${offset + index}`, shortHash: `c${offset + index}`, author: 'Author',
            date: '2026-10-06', message: `Commit ${offset + index}`,
          })),
        };
      };
    });
    await openGitPanel(page);
    await page.getByRole('tab', { name: 'History' }).click();
    const list = page.locator('.git-commit-list');
    await expect(list.locator('.git-commit-row').first()).toContainText('Commit 0');
    const loadedOffsets = () => page.evaluate(() => (window as unknown as { __logCalls: number[] }).__logCalls.filter(offset => offset > 0));

    await list.evaluate(element => element.scrollTo(0, element.scrollHeight));
    await expect(page.getByRole('button', { name: 'Loading older commits' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fetch', exact: true })).toBeEnabled();
    await expect.poll(loadedOffsets).toEqual([60]);
    await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();

    await list.evaluate(element => element.scrollTo(0, element.scrollHeight));
    await expect.poll(loadedOffsets).toEqual([60, 120]);
    expect(await list.locator('.git-commit-row').count()).toBeLessThan(60);
  });

  test('recovers a missing workspace folder by switching back to app storage', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();

    await setGitStatus(page, {
      isRepo: false,
      workspaceRoot: '/Users/ada/Library/Application Support/OldApp/workspaces',
      missingRoot: true,
    });

    await openGitPanel(page);
    await expect(page.locator('.git-local-eyebrow')).toHaveText('Folder missing');

    await page.evaluate(() => { window.__kurloE2E.calls.length = 0; });
    await page.getByRole('button', { name: /Use Kurlo's app storage/ }).click();

    await expect(page.locator('.git-local-eyebrow')).not.toHaveText('Folder missing');
    const calls = await page.evaluate(() => window.__kurloE2E.calls);
    expect(calls).toContain('UseLocalWorkspaceStore');
    expect(calls.some(call => call.startsWith('CreateLocalWorkspaceRoot'))).toBe(false);
  });

  test('offers to quit without saving when the last save fails', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();

    await page.evaluate(() => {
      const state = window.__kurloE2E as unknown as { failSaves: boolean; calls: string[] };
      state.failSaves = true;
      state.calls.length = 0;
      window.__kurloE2E.emit('kurlo:before-quit', null);
    });

    const dialog = page.getByRole('dialog', { name: 'Quit without saving?' });
    await expect(dialog).toBeVisible();
    const callsWhileAsking = await page.evaluate(() => [...window.__kurloE2E.calls]);
    expect(callsWhileAsking[0]).toBe('AckQuit');
    expect(callsWhileAsking).not.toContain('ConfirmQuit');
    await dialog.getByRole('button', { name: 'Quit without saving' }).click();

    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls)).toContain('ConfirmQuit');
    const calls = await page.evaluate(() => window.__kurloE2E.calls);
    expect(calls).not.toContain('CancelQuit');
  });

  test('stays open when quitting without saving is declined', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();

    await page.evaluate(() => {
      const state = window.__kurloE2E as unknown as { failSaves: boolean; calls: string[] };
      state.failSaves = true;
      state.calls.length = 0;
      window.__kurloE2E.emit('kurlo:before-quit', null);
    });

    const dialog = page.getByRole('dialog', { name: 'Quit without saving?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls)).toContain('CancelQuit');
    const calls = await page.evaluate(() => window.__kurloE2E.calls);
    expect(calls).not.toContain('ConfirmQuit');
  });

  test('Git panel refuses to switch branches while the workspace has local changes', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();

    await setGitStatus(page, {
      isRepo: true,
      workspaceRoot: '/workspace',
      root: '/workspace',
      branch: 'main',
      head: 'a1b2c3d',
      upstream: 'origin/main',
      remotes: ['origin'],
      clean: false,
      files: [{ path: 'workspaces/Main/environments/Local.yml', index: ' ', worktree: 'M', status: 'modified' }],
    });

    await setGitBranches(page, {
      ok: true,
      git: {},
      current: 'main',
      localBranches: [
        { name: 'main', fullName: 'main', remote: '', current: true, upstream: 'origin/main' },
        { name: 'feature', fullName: 'feature', remote: '', current: false, upstream: '' },
      ],
      remoteBranches: [],
      error: '',
      output: '',
    });

    await openGitPanel(page);
    await page.evaluate(() => { window.__kurloE2E.calls.length = 0; });

    await page.locator('.git-branch-chip').click();
    const picker = page.getByRole('dialog', { name: 'Switch branch' });
    await expect(picker).toBeVisible();
    await picker.getByText('feature', { exact: true }).click();

    const blocked = page.getByRole('dialog', { name: 'Checkout blocked' });
    await expect(blocked).toBeVisible();
    await blocked.getByRole('button').first().click();

    const calls = await page.evaluate(() => window.__kurloE2E.calls);
    expect(calls.some(call => call.startsWith('GitCheckoutBranch:'))).toBe(false);
  });

  test('imports a Postman collection into the sidebar', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();

    await page.getByRole('button', { name: 'Collections' }).click();
    await page.getByLabel('Import collection').first().click();

    const sourceDialog = page.getByRole('dialog', { name: 'Import collection' });
    await expect(sourceDialog).toBeVisible();
    await sourceDialog.getByText('Postman collection').click();
    await sourceDialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(sourceDialog).toBeHidden();

    const collection = {
      info: { name: 'Billing API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [{ key: 'baseUrl', value: 'https://api.billing.test' }],
      item: [
        {
          name: 'List invoices',
          request: { method: 'GET', url: { raw: '{{baseUrl}}/invoices' }, header: [{ key: 'Accept', value: 'application/json' }] },
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200))'] } }],
        },
        {
          name: 'Create invoice',
          request: { method: 'POST', url: { raw: '{{baseUrl}}/invoices' }, body: { mode: 'raw', raw: '{"amount":10}' } },
        },
      ],
    };

    await page.setInputFiles('input[type="file"]', {
      name: 'billing.postman_collection.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(collection)),
    });

    await expect(collectionRow(page, 'Billing API')).toBeVisible();
    await expect(page.getByRole('button', { name: 'GET List invoices' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'POST Create invoice' })).toBeVisible();

    const store = await page.evaluate(() => window.__kurloE2E.store as {
      collections: Array<{ id: string; name: string }>;
      requests: Array<{ name: string; method: string; url: string; testScriptJs?: string }>;
    });
    const imported = store.collections.find(entry => entry.name === 'Billing API');
    expect(imported).toBeTruthy();
    const requests = store.requests.filter(entry => ['List invoices', 'Create invoice'].includes(entry.name));
    expect(requests).toHaveLength(2);
    expect(requests.find(entry => entry.name === 'List invoices')?.method).toBe('GET');
    expect(requests.find(entry => entry.name === 'List invoices')?.url).toContain('{{baseUrl}}/invoices');
    expect(requests.find(entry => entry.name === 'List invoices')?.testScriptJs ?? '').toContain('pm.test');
  });

  test('keeps Postman scripts as JavaScript when Tengo is the script engine', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.scriptEngine.v1', 'tengo'));
    await page.goto('/');
    await page.getByRole('button', { name: 'Collections' }).click();
    await page.getByLabel('Import collection').first().click();
    const sourceDialog = page.getByRole('dialog', { name: 'Import collection' });
    await sourceDialog.getByText('Postman collection').click();
    await sourceDialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(sourceDialog).toBeHidden();
    const collection = {
      info: { name: 'Tengo user API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      event: [{ listen: 'prerequest', script: { exec: ['pm.variables.set("trace", "1")'] } }],
      item: [{
        name: 'Ping',
        request: { method: 'GET', url: { raw: 'https://api.billing.test/ping' } },
        event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200))'] } }],
      }],
    };
    await page.setInputFiles('input[type="file"]', {
      name: 'tengo.postman_collection.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(collection)),
    });
    await expect(page.getByRole('button', { name: 'GET Ping' })).toBeVisible();
    const store = await page.evaluate(() => window.__kurloE2E.store as {
      collections: Array<{ name: string; defaults?: { preRequestScript?: string; preRequestScriptJs?: string } }>;
      requests: Array<{ name: string; testScript?: string; testScriptJs?: string }>;
    });
    const ping = store.requests.find(entry => entry.name === 'Ping')!;
    expect(ping.testScriptJs).toContain('pm.test');
    expect(ping.testScript ?? '').toBe('');
    const defaults = store.collections.find(entry => entry.name === 'Tengo user API')?.defaults;
    expect(defaults?.preRequestScriptJs ?? '').toContain('pm.variables.set');
    expect(defaults?.preRequestScript ?? '').toBe('');
  });

  test('keeps the header actions anchored when the runner replaces the request view', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');

    const rightEdge = () => page.locator('.searchbar-right').evaluate(
      (el) => Math.round(el.getBoundingClientRect().right),
    );
    const settingsSize = () => page.getByRole('button', { name: /^Settings/ }).evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return `${Math.round(rect.width)}x${Math.round(rect.height)}`;
    });

    const inRequest = { edge: await rightEdge(), size: await settingsSize() };

    await page.getByRole('button', { name: 'Collection runner', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Collection runner', exact: true })).toHaveClass(/active/);

    expect(await rightEdge()).toBe(inRequest.edge);
    expect(await settingsSize()).toBe(inRequest.size);
  });

  test('compares a fresh response against a saved example', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const responseStatus = page.locator('.status-badge');
    await expect(responseStatus).toContainText('200 OK');
    await page.getByRole('button', { name: 'Save as example', exact: true }).click();
    await expect(page.locator('.examples-row')).toHaveCount(1);

    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders/moved');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(responseStatus).toContainText('200 OK');

    const diffTab = page.locator('.response-mini-tabs').getByRole('tab', { name: /Diff/ });
    await expect(diffTab).toBeVisible();
    await diffTab.click();

    const picker = page.getByRole('button', { name: /^Compare with/ });
    await expect(picker).toBeVisible();
    await picker.click();
    await page.getByRole('option', { name: '200 OK', exact: true }).click();

    await expect(page.locator('.diff-side-before')).toContainText('200 OK');
    await expect(page.locator('.diff-count-add')).toBeVisible();
    await expect(page.locator('.diff-line.diff-removed').first()).toContainText('/orders');
    await captureDocsScreenshot(page, 'response-diff-example');

    await page.getByRole('button', { name: 'Clear baseline' }).click();
    await expect(page.locator('.diff-side-before')).toContainText('previous');
  });

  test('lists every open tab when the title row runs out of room', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 760 });
    await installKurloBridge(page);
    await page.goto('/');

    const overflowButton = page.getByRole('button', { name: 'All open tabs' });
    await expect(overflowButton).toBeHidden();
    for (let index = 0; index < 7; index += 1) {
      await page.getByLabel('New unsaved request').click();
      await chooseRequestType(page, 'HTTP Request');
    }
    await expect(overflowButton).toBeVisible();

    const tabs = page.locator('.saved-request-tabs');
    await expect.poll(async () => tabs.evaluate((list) => list.scrollWidth > list.clientWidth)).toBe(true);
    await expect.poll(async () => page.locator('.saved-request-tab:not(.overview-request-tab)').first().evaluate(tab => tab.getBoundingClientRect().width)).toBeLessThan(120);

    await overflowButton.click();
    const list = page.getByRole('listbox', { name: 'Open tabs' });
    await expect(list.getByRole('option')).toHaveCount(9);
    await list.getByRole('option', { name: 'Overview' }).click();
    await expect(list).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  test('closes a tab with the middle mouse button', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    const requestTabs = page.locator('.saved-request-tab:not(.overview-request-tab)');
    const initial = await requestTabs.count();
    for (let index = 0; index < 2; index += 1) {
      await page.getByLabel('New unsaved request').click();
      await chooseRequestType(page, 'HTTP Request');
    }
    await expect(requestTabs).toHaveCount(initial + 2);

    await requestTabs.last().getByRole('tab').click({ button: 'middle' });
    await expect(requestTabs).toHaveCount(initial + 1);

    await page.getByRole('tab', { name: 'Overview' }).click({ button: 'middle' });
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
    await expect(requestTabs).toHaveCount(initial + 1);
  });

  test('sends the request when Enter is pressed in the URL field', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    const url = page.getByLabel('Request URL');
    await url.fill('https://api.kurlo.test/orders/8123');
    await url.press('Enter');

    await expect(page.getByText('200 OK')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(1);
    await expect(url).toHaveValue('https://api.kurlo.test/orders/8123');

    await url.press('Shift+Enter');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(1);
  });

  test('compares and edits variables across environments in the matrix', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Environments' }).click();
    await page.getByLabel('New environment').click();
    await fillPrompt(page, 'New environment', 'Local');
    const envRows = page.getByTestId('environment-variable-row');
    await envRows.nth(0).getByLabel('Environment variable key').fill('baseUrl');
    await envRows.nth(0).getByLabel('Environment variable value').fill('http://localhost:4242');

    await page.getByLabel('New environment').click();
    await fillPrompt(page, 'New environment', 'Staging');

    await page.getByRole('radio', { name: 'Matrix' }).click();
    await expect(page.getByRole('heading', { name: 'Variables' })).toBeVisible();
    const matrixRows = page.getByTestId('environment-matrix-row');
    await expect(matrixRows).toHaveCount(1);
    await expect(page.getByLabel('baseUrl in Local', { exact: true })).toHaveValue('http://localhost:4242');

    await page.getByRole('button', { name: 'Set baseUrl in Staging' }).click();
    await page.getByLabel('baseUrl in Staging', { exact: true }).fill('https://staging.kurlo.test');

    const name = page.getByLabel('Name of baseUrl');
    await name.fill('apiBase');
    await name.press('Enter');
    await expect(page.getByLabel('apiBase in Staging', { exact: true })).toHaveValue('https://staging.kurlo.test');

    await page.getByRole('button', { name: 'Make apiBase secret' }).click();
    await expect(page.getByLabel('apiBase in Local', { exact: true })).toHaveAttribute('type', 'password');
    await captureDocsScreenshot(page, 'environment-matrix');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => {
      const store = await page.evaluate(() => window.__kurloE2E.store as {
        environments?: Array<{ name: string; values: Array<{ key: string; value: string; secret?: boolean }> }>;
      });
      return (store.environments ?? []).map(environment => ({
        name: environment.name,
        values: environment.values.filter(row => row.key).map(row => `${row.key}=${row.value}${row.secret ? ' (secret)' : ''}`),
      }));
    }).toEqual([
      { name: 'Local', values: ['apiBase=http://localhost:4242 (secret)'] },
      { name: 'Staging', values: ['apiBase=https://staging.kurlo.test (secret)'] },
    ]);

    await page.getByRole('radio', { name: 'Single' }).click();
    await expect(page.getByTestId('environment-variable-row').first().getByLabel('Environment variable key')).toHaveValue('apiBase');
  });

  test('sending a saved request leaves it saved', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Orders API');
    await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('Get order');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders/8123');

    const saveButton = page.locator('.save-btn:not(.revert-btn)');
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(saveButton).toBeDisabled();

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();
    await expect(saveButton).toBeDisabled();
    await expect(saveButton).toHaveText('Saved');
    await expect(page.locator('.saved-request-tab.dirty')).toHaveCount(0);
  });

  test('saves a response as an example, and keeps it in the store', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Orders API');
    await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('Get order');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders/8123');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();

    await page.getByRole('button', { name: 'Save as example', exact: true }).click();

    await expect(page.locator('.examples-row')).toHaveCount(1);
    await expect(page.locator('.examples-name')).toHaveText('200 OK');
    await expect(page.locator('.request-editor-tabs-shell').getByRole('tab', { name: /Examples/ })).toContainText('1');

    await expect(page.locator('.examples-meta')).toContainText('/orders/:id');
    await expect(page.locator('.examples-status-input')).toHaveValue('200');
    await captureDocsScreenshot(page, 'examples-panel');

    await page.locator('.response-mini-tabs').getByRole('tab', { name: 'Body' }).click();
    await page.getByRole('button', { name: 'Save as example', exact: true }).click();
    await expect(page.locator('.examples-row')).toHaveCount(2);
    await expect(page.locator('.examples-name').nth(1)).toHaveText('200 OK (2)');

    await page.locator('.examples-row').nth(1).getByRole('button', { name: /^Delete/ }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete example' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.examples-row')).toHaveCount(1);

    const saveButton = page.locator('.save-btn:not(.revert-btn)').first();
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(saveButton).toBeDisabled();

    await expect.poll(async () => {
      const store = await page.evaluate(() => window.__kurloE2E.store as {
        requests: Array<{ url?: string; examples?: Array<{ name: string; response: { statusCode: number } }> }>;
      });
      const saved = store.requests.find(entry => entry.url === 'https://api.kurlo.test/orders/8123');
      return {
        examples: (saved?.examples ?? []).length,
        name: saved?.examples?.[0]?.name ?? '',
        statusCode: saved?.examples?.[0]?.response.statusCode ?? 0,
      };
    }).toEqual({ examples: 1, name: '200 OK', statusCode: 200 });
  });

  test('serves a collection from the mock server panel, and logs what a client asked for', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Orders API');
    await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('Get order');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders/8123');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();
    await page.getByRole('button', { name: 'Save as example', exact: true }).click();
    await expect(page.locator('.examples-row')).toHaveCount(1);
    await page.locator('.save-btn:not(.revert-btn)').first().click();
    await expect(page.locator('.save-btn:not(.revert-btn)').first()).toBeDisabled();

    await page.getByLabel('Mock server', { exact: true }).click();
    const panel = page.locator('section[aria-label="Mock server"]');
    await expect(panel).toBeVisible();

    await panel.locator('.mock-select').getByRole('button').first().click();
    await page.getByRole('option', { name: 'Orders API — 1 example' }).click();
    await expect(panel.locator('.mock-pane-title').first()).toContainText('1');

    await panel.getByRole('button', { name: 'Start server' }).click();
    await expect(panel.locator('.mock-live-label')).toHaveText('Running');
    await expect(panel.locator('.mock-url')).toContainText('http://127.0.0.1:3100');

    await page.evaluate(() => {
      const base = { timestamp: Date.now(), durationMs: 12 };
      window.__kurloE2E.emit('mock:request', {
        ...base,
        id: 'mock-1',
        method: 'GET',
        path: '/orders/8123',
        query: '',
        matched: true,
        exampleId: '',
        exampleName: '200 OK',
        requestName: 'Get order',
        statusCode: 200,
      });
      window.__kurloE2E.emit('mock:request', {
        ...base,
        id: 'mock-2',
        method: 'POST',
        path: '/orders',
        query: '',
        matched: false,
        statusCode: 404,
      });
    });

    const log = panel.locator('.mock-log-row');
    await expect(log).toHaveCount(2);
    await expect(log.first()).toContainText('no example matched');
    await expect(log.last()).toContainText('/orders/8123');
    await captureDocsScreenshot(page, 'mock-server');

    await panel.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(panel.locator('.mock-live-label')).toHaveCount(0);
    expect(await page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('StartMockServer')))).toEqual([
      'StartMockServer:Orders API:1',
    ]);
  });

  test('builds a load test from collection requests and saves it to the workspace', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Shop API');
    for (const [name, url] of [['Login', 'https://shop.kurlo.test/login'], ['List orders', 'https://shop.kurlo.test/orders']]) {
      await collectionRow(page, 'Shop API').getByLabel('Collection menu').click();
      await collectionRow(page, 'Shop API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
      await chooseRequestType(page, 'HTTP Request');
      await page.getByLabel('Request name').fill(name);
      await page.getByLabel('Request name').press('Enter');
      await page.getByLabel('Request URL').fill(url);
      await page.locator('.save-btn:not(.revert-btn)').first().click();
      await expect(page.locator('.save-btn:not(.revert-btn)').first()).toBeDisabled();
    }

    const loginRow = page.locator('.collection-request-wrap').filter({ hasText: 'Login' }).first();
    await loginRow.hover();
    await loginRow.getByLabel('Request menu').click();
    await loginRow.getByRole('button', { name: 'Load test this request' }).click();

    const editor = page.locator('section[aria-label="Load test"]');
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel('Load test name')).toHaveValue('Login load test');
    await expect(editor.getByRole('option')).toHaveCount(1);

    await editor.getByRole('option').first().click();
    await editor.getByRole('radio', { name: 'Once per user' }).click();
    await editor.getByRole('button', { name: '+ Save a value' }).click();
    await editor.getByLabel('Variable name').fill('token');
    await editor.getByRole('textbox', { name: 'Path' }).fill('$.access_token');

    await editor.getByRole('button', { name: '+ Add request from collection' }).click();
    await editor.getByRole('menuitem', { name: /List orders/ }).click();
    await expect(editor.getByRole('option')).toHaveCount(2);
    await editor.getByLabel('Wait', { exact: true }).fill('1s');
    await editor.getByLabel('Wait', { exact: true }).press('Enter');
    await expect(editor.getByRole('option').nth(1)).toContainText('wait 1s');

    await editor.getByRole('tab', { name: /Load & thresholds/ }).click();
    await editor.getByRole('button', { name: /^Load normal traffic/ }).click();
    await expect(editor.locator('.loadtest-preview')).toContainText('Peak 50 users · 13m total');
    await editor.getByRole('radio', { name: 'Iterations per second' }).click();
    await expect(editor.locator('.loadtest-preview')).toContainText('iterations/s');

    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
      const store = window.__kurloE2E.store as { collections?: Array<{ name: string; loadTests?: unknown[] }> };
      return store.collections?.find(candidate => candidate.name === 'Shop API')?.loadTests?.[0] ?? null;
    })).toMatchObject({
      name: 'Login load test',
      scenarios: [{
        executor: { type: 'ramping-arrival-rate' },
        steps: [
          { once: true, extract: [{ var: 'token', from: 'json', path: '$.access_token' }] },
          { thinkTimeMs: 1000 },
        ],
      }],
    });

    await editor.getByRole('button', { name: 'Export k6 script' }).click();
    const exportDialog = page.getByRole('dialog', { name: 'Export to k6' });
    await expect(exportDialog).toBeVisible();
    await expect(exportDialog.locator('.k6-export-warnings li')).toHaveCount(1);
    await expect(exportDialog.locator('.k6-export-warnings')).toContainText('List orders are not exported');
    await expect(exportDialog.locator('.k6-export-command')).toHaveText('password=… k6 run login-load-test.k6.js');
    await exportDialog.getByRole('radio', { name: 'Write into the script' }).click();
    await expect(exportDialog).toContainText('Do not commit or share it');
    await exportDialog.getByRole('button', { name: 'Save script…' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedFiles.map(file => file.name))).toEqual(['login-load-test.k6.js']);
    expect(await page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('ExportLoadTestK6')))).toEqual([
      'ExportLoadTestK6:Login load test:Login,List orders:false',
      'ExportLoadTestK6:Login load test:Login,List orders:true',
    ]);
    await exportDialog.press('Escape');
    await expect(exportDialog).toBeHidden();

    const sidebarRow = page.locator('.collection-request-wrap').filter({ hasText: 'Login load test' });
    await expect(sidebarRow).toHaveClass(/active/);
    await sidebarRow.getByLabel('Load test menu').click();
    await sidebarRow.getByRole('button', { name: 'Duplicate' }).click();
    await expect(editor.getByLabel('Load test name')).toHaveValue('Login load test copy');
    await expect(page.locator('.collection-request-wrap').filter({ hasText: 'load test' })).toHaveCount(2);
  });

  test('sends an AI request, streams the answer and shows the tool call', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await expect(page.getByLabel('Provider base URL')).toHaveValue('https://api.openai.com/v1');
    const endpoint = page.locator('.ai-endpoint');
    await expect(endpoint).toContainText('POST https://api.openai.com/v1/chat/completions');
    await expect(endpoint.locator('.ai-endpoint-suffix')).toHaveText('/chat/completions');
    await page.getByLabel('Provider base URL').fill('https://api.deepseek.com/v1/chat/completions');
    await expect(endpoint.locator('.ai-endpoint-suffix')).toHaveCount(0);
    await expect(endpoint).toContainText('POST https://api.deepseek.com/v1/chat/completions');
    await page.getByLabel('Provider base URL').fill('https://api.deepseek.com/v1');
    await expect(endpoint.locator('.ai-endpoint-suffix')).toHaveText('/chat/completions');
    await page.getByLabel('Provider base URL').fill('https://api.openai.com/v1');

    await page.getByLabel('Provider and model').click();
    await page.getByRole('radio', { name: 'Ollama' }).click();
    await expect(page.getByRole('radio', { name: 'Ollama' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('Provider base URL')).toHaveValue('http://localhost:11434/v1');
    await expect(page.getByRole('option', { name: 'qwen2.5:7b' })).toBeVisible();
    await page.getByRole('option', { name: 'llama3.2' }).click();
    await expect(page.getByLabel('Provider and model')).toContainText('Ollama');
    await expect(page.getByLabel('Provider and model')).toContainText('llama3.2');
    const picker = page.getByRole('button', { name: 'Provider and model' });
    await picker.click();
    await expect(page.getByRole('dialog', { name: 'Provider and model' })).toBeVisible();
    await expect(page.getByLabel('Model', { exact: true })).toBeFocused();
    await picker.click();
    await expect(page.getByRole('dialog', { name: 'Provider and model' })).toHaveCount(0);

    await fillCodeEditor(page, 'ai-prompt-editor', 'Do I need an umbrella in Lisbon tomorrow?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.locator('.ai-text').last()).toContainText('Bring an umbrella');
    await expect(page.locator('.ai-text').last().locator('strong')).toHaveText('72%');
    await expect(page.locator('.ai-text').last().locator('li')).toHaveCount(2);
    await expect(page.locator('.ai-text').last()).not.toContainText('**');
    await expect(page.locator('.ai-tool-name')).toContainText('get_weather');
    await expect(page.locator('.ai-tool-server')).toContainText('Weather');
    await expect(page.locator('.ai-tool-result')).toContainText('"rain":0.72');
    await expect(page.locator('.ai-metrics')).toContainText('TTFT');
    await expect(page.locator('.ai-stop')).toContainText('end_turn');
    await captureDocsScreenshot(page, 'request-ai');

    const sent = await page.evaluate(() => window.__kurloE2E.sentAiRequests);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ provider: 'openai', model: 'llama3.2' });
    expect(sent[0].messages).toEqual([{ role: 'user', blocks: [{ type: 'text', text: 'Do I need an umbrella in Lisbon tomorrow?' }] }]);
    expect((sent[0].http as Record<string, unknown>).auth).toMatchObject({ type: 'none' });

    await page.getByRole('tab', { name: /Tests/ }).click();
    await expect(page.locator('.test-row.fail')).toContainText('answers fast');

    await page.getByRole('tab', { name: 'Raw' }).click();
    const rawSteps = page.locator('.ai-raw-step');
    await expect(rawSteps).toHaveCount(2);
    await expect(rawSteps.first().locator('.ai-raw-head')).toHaveAttribute('aria-expanded', 'false');
    await expect(rawSteps.last().locator('.ai-raw-head')).toHaveAttribute('aria-expanded', 'true');
    await expect(rawSteps.last().locator('.ai-raw-body')).toContainText('Bring');
    await rawSteps.first().locator('.ai-raw-head').click();
    await expect(rawSteps.first().locator('.ai-raw-body')).toContainText('Let me');

    await page.getByRole('tab', { name: 'Chat' }).click();
    const panel = page.locator('.ai-panel');
    const chatBox = await page.locator('.ai-chat').boundingBox();
    const turnBox = await page.locator('.ai-turn').first().boundingBox();
    expect(turnBox!.width).toBeGreaterThan(chatBox!.width - 80);

    const reply = page.getByRole('textbox', { name: 'Reply' });
    await reply.click();
    await page.keyboard.type('And on');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Saturday?');
    await expect(reply).toHaveValue('And on\nSaturday?');
    expect(await page.evaluate(() => window.__kurloE2E.sentAiRequests.length)).toBe(1);
    await expect(reply).toHaveAttribute('spellcheck', 'false');
    await expect(reply).toHaveAttribute('autocomplete', 'off');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ai-user')).toHaveCount(2);
    await expect(reply).toHaveValue('');
    const followUp = await page.evaluate(() => window.__kurloE2E.sentAiRequests[1]);
    expect((followUp.messages as Array<{ role: string }>).map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect((followUp.messages as Array<{ blocks: Array<{ text: string }> }>).at(-1)?.blocks[0].text).toBe('And on\nSaturday?');
    await captureDocsScreenshot(page, 'request-ai-chat');

    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('#ai-top-p').fill('5');
    const topPError = page.locator('#ai-top-p-error');
    await expect(topPError).toHaveText('Use a number from 0 to 1.');
    const [topP, topPMessage] = [await page.locator('#ai-top-p').boundingBox(), await topPError.boundingBox()];
    expect(topPMessage!.y).toBeGreaterThanOrEqual(topP!.y + topP!.height - 1);
    expect(Math.abs((topPMessage!.x + topPMessage!.width) - (topP!.x + topP!.width))).toBeLessThan(2);
    await page.locator('#ai-top-p').fill('');
    await page.getByRole('tab', { name: /Prompt/ }).click();

    await panel.getByRole('button', { name: 'New chat' }).click();
    await expect(page.locator('.ai-user')).toHaveCount(0);
    await expect(panel).toContainText('Send the prompt to start a conversation.');
  });

  test('keeps the AI prompt and settings inside a narrow request panel', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 470 });
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.responseLayout.v1', 'right'));
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await fillCodeEditor(page, 'ai-prompt-editor', 'привет братик');
    await page.getByTestId('ai-prompt-editor').locator('.cm-content').click();
    const scroller = page.getByTestId('ai-prompt-editor').locator('.cm-scroller');
    await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(0);
    const frame = await page.locator('.ai-editor-prompt').boundingBox();
    const line = await page.getByTestId('ai-prompt-editor').locator('.cm-line').first().boundingBox();
    expect(line!.y).toBeGreaterThanOrEqual(frame!.y + 6);
    expect(line!.y + line!.height).toBeLessThanOrEqual(frame!.y + frame!.height);

    const divider = page.getByRole('button', { name: 'Resize panels' });
    const box = await divider.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 40);
    await page.mouse.down();
    await page.mouse.move(0, box!.y + 40, { steps: 8 });
    await page.mouse.up();
    const editor = await page.locator('.request-editor').boundingBox();
    expect(editor!.width).toBeGreaterThanOrEqual(24 * 16 - 1);

    await page.getByRole('button', { name: 'Request section' }).click();
    await page.getByRole('option', { name: 'Settings' }).click();
    const fits = await page.locator('.request-editor .postman-setting input.setting-number').evaluateAll(inputs => inputs.every(input => {
      const rect = input.getBoundingClientRect();
      const panel = input.closest('.request-editor')!.getBoundingClientRect();
      return rect.right <= panel.right + 0.5 && rect.width > 40;
    }));
    expect(fits).toBe(true);

    await page.locator('#ai-temperature').fill('2132312231');
    const error = page.locator('#ai-temperature-error');
    await expect(error).toHaveText('Use a number from 0 to 2.');
    await expect(page.locator('#ai-temperature')).toHaveAttribute('aria-invalid', 'true');
    const [field, message] = [await page.locator('#ai-temperature').boundingBox(), await error.boundingBox()];
    expect(message!.y).toBeGreaterThanOrEqual(field!.y + field!.height - 1);
    expect(message!.y - (field!.y + field!.height)).toBeLessThan(16);
    expect(field!.width).toBeLessThanOrEqual(8 * 16 + 1);
    await page.locator('#ai-temperature').fill('');
    await expect(error).toHaveCount(0);

    await page.getByRole('button', { name: 'Provider and model' }).click();
    await page.getByRole('radio', { name: 'Ollama' }).click();
    await page.getByRole('option', { name: 'llama3.2' }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const badge = page.locator('.ai-panel .status-badge');
    await expect(badge).toContainText('200');
    expect(await badge.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= el.closest('.response-status-bar')!.getBoundingClientRect().right)).toBe(true);
    const newChat = page.locator('.ai-panel').getByRole('button', { name: 'New chat' });
    await expect(newChat).toBeVisible();
    const statusFits = await page.locator('.ai-panel .response-status-bar').evaluate(bar => [...bar.querySelectorAll('.status-left, .status-right')].every(part => part.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 0.5));
    expect(statusFits).toBe(true);
    const [replyBox, sendBox] = [await page.getByRole('textbox', { name: 'Reply' }).boundingBox(), await page.getByRole('button', { name: 'Send reply' }).boundingBox()];
    expect(Math.abs(replyBox!.height - sendBox!.height)).toBeLessThan(1.5);
    expect(Math.abs((replyBox!.y + replyBox!.height) - (sendBox!.y + sendBox!.height))).toBeLessThan(1.5);
  });

  test('grows the AI prompt field with its text up to the free height', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.responseLayout.v1', 'right'));
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    const field = page.locator('.ai-editor-prompt');
    const root = page.locator('.ai-prompt');
    const empty = (await field.boundingBox())!.height;
    const free = (await root.boundingBox())!.height;
    expect(empty).toBeLessThan(free * 0.75);
    expect(empty).toBeGreaterThan(9 * 16 - 2);
    await fillCodeEditor(page, 'ai-prompt-editor', Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join('\n'));
    const grown = (await field.boundingBox())!.height;
    expect(grown).toBeGreaterThan(empty + 20);
    await fillCodeEditor(page, 'ai-prompt-editor', Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n'));
    const rootBox = (await root.boundingBox())!;
    const fieldBox = (await field.boundingBox())!;
    expect(fieldBox.y + fieldBox.height).toBeLessThanOrEqual(rootBox.y + rootBox.height + 1);
    expect((await page.getByLabel('System prompt').boundingBox())!.height).toBeGreaterThan(40);
    const scroller = page.getByTestId('ai-prompt-editor').locator('.cm-scroller');
    expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight + 20)).toBe(true);
  });

  test('stops the AI prompt and system prompt at their length limits', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    const prompt = page.getByTestId('ai-prompt-editor').locator('.cm-content');
    await prompt.click();
    await page.keyboard.insertText('x'.repeat(200_010));
    await expect(page.locator('.ai-counter-full')).toHaveText('200,000 / 200,000');
    await page.keyboard.type('more');
    await expect(page.locator('.ai-counter-full')).toHaveText('200,000 / 200,000');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.ai-counter')).toHaveText('199,999 / 200,000');
    await expect(page.locator('.ai-counter-full')).toHaveCount(0);

    const system = page.getByLabel('System prompt').locator('.cm-content');
    await system.click();
    await page.keyboard.insertText('s'.repeat(50_005));
    await expect(page.locator('.ai-counter-full')).toHaveText('50,000 / 50,000');
    await expect(page.getByRole('textbox', { name: 'Reply' })).toHaveCount(0);
  });

  test('shows a provider error inside the chat, with its status, link and a hint', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 760 });
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.responseLayout.v1', 'right'));
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await page.getByRole('button', { name: 'Provider and model' }).click();
    await page.getByRole('radio', { name: 'Ollama' }).click();
    await page.getByRole('option', { name: 'llama3.2' }).click();
    await fillCodeEditor(page, 'ai-prompt-editor', 'Spend my credits');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const card = page.locator('.ai-error-card');
    await expect(card.locator('.ai-error-title')).toHaveText('The provider returned an error');
    await expect(card.locator('.ai-error-status')).toHaveText('402 Payment Required');
    await expect(card.locator('.ai-error-message')).toContainText('This request requires more credits');
    await expect(card.locator('.ai-error-message a')).toHaveAttribute('href', /^https:\/\/openrouter\.ai\/workspaces\/default\/keys\//);
    await expect(card.locator('.ai-error-hint')).toHaveText('Add credits at the provider, or lower Max tokens in Settings.');
    const chat = page.locator('.ai-chat');
    expect(await chat.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const [cardBox, chatBox] = [await card.boundingBox(), await chat.boundingBox()];
    expect(cardBox!.x).toBeGreaterThanOrEqual(chatBox!.x);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(chatBox!.x + chatBox!.width + 0.5);
  });

  test('keeps the status code and New chat on the AI status line when the model name is long', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 820 });
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.responseLayout.v1', 'right'));
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await page.getByRole('button', { name: 'Provider and model' }).click();
    await page.getByRole('radio', { name: 'Ollama' }).click();
    await page.getByLabel('Model', { exact: true }).fill('openai/gpt-4o-mini-2024-07-18-extended-preview-with-a-very-long-name');
    await page.keyboard.press('Enter');
    await fillCodeEditor(page, 'ai-prompt-editor', 'Do I need an umbrella in Lisbon tomorrow?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const bar = page.locator('.ai-panel .response-status-bar');
    await expect(bar.locator('.status-badge')).toContainText('200');
    const layout = await bar.evaluate(el => {
      const right = el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight);
      const box = (selector: string) => el.querySelector(selector)!.getBoundingClientRect();
      const model = el.querySelector('.ai-model-name') as HTMLElement;
      return {
        badgeFits: box('.status-badge').right <= right + 0.5,
        newChatFits: box('.ai-new-chat').right <= right + 0.5,
        modelTruncated: model.scrollWidth > model.clientWidth,
        modelBeforeMetrics: box('.ai-model-name').right <= box('.ai-metrics').left,
        metricsFit: (el.querySelector('.ai-metrics') as HTMLElement).scrollWidth <= (el.querySelector('.ai-metrics') as HTMLElement).clientWidth,
      };
    });
    expect(layout).toEqual({ badgeFits: true, newChatFits: true, modelTruncated: true, modelBeforeMetrics: true, metricsFit: true });
    await bar.screenshot({ path: test.info().outputPath('status.png') });
  });

  test('keeps the token visibility button clear of the token text', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await page.getByRole('tab', { name: /Auth/ }).click();
    await page.getByLabel('Auth type').click();
    await page.locator('.auth-select-menu').getByRole('button', { name: 'Bearer Token' }).click();
    const input = page.locator('#bearer-token');
    await input.fill('x'.repeat(200));
    const [field, button] = await Promise.all([input.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.right - parseFloat(getComputedStyle(el).paddingRight);
    }), page.getByRole('button', { name: 'Show token' }).boundingBox()]);
    expect(field).toBeLessThanOrEqual(button!.x + 0.5);
  });

  test('explains why the model list could not be loaded', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await page.getByRole('button', { name: 'Provider and model' }).click();
    await page.getByRole('radio', { name: 'Ollama' }).click();
    await page.keyboard.press('Escape');
    await page.getByLabel('Provider base URL').fill('https://no-models.kurlo.test/v1?key=secret');
    await page.getByRole('button', { name: 'Provider and model' }).click();
    const problem = page.locator('.ai-model-problem');
    await expect(problem).toBeVisible();
    await expect(problem.locator('.ai-model-problem-title')).toHaveText('This server has no model list');
    await expect(problem.locator('.ai-model-problem-status')).toHaveText('404 Not Found');
    await expect(problem.locator('.ai-model-problem-detail')).toHaveText('404 Not FoundGET https://no-models.kurlo.test/v1/models');
    await expect(problem).not.toContainText('secret');
    await expect(problem.locator('.ai-model-problem-hint')).toContainText('type the model name');
    const before = await page.evaluate(() => window.__kurloE2E.sentRequests.length);
    await problem.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(before + 1);
    await page.getByLabel('Model', { exact: true }).fill('my-model');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Provider and model' })).toContainText('my-model');
  });

  test('opens a new MCP server from the AI tools tab as a draft that is dropped when closed unsaved', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await page.getByRole('tab', { name: /Tools/ }).click();
    const before = await page.evaluate(() => window.__kurloE2E.store.requests.length);
    await page.getByRole('button', { name: 'New MCP request' }).click();
    await expect(page.getByLabel('Method and protocol')).toContainText('MCP');
    await page.locator('.saved-request-tab.active').getByRole('button', { name: 'Close tab' }).click();
    await expect(page.getByLabel('Method and protocol')).toContainText('AI');
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests.filter((request: { requestType?: string; isDraft?: boolean }) => request.requestType === 'mcp' && !request.isDraft).length)).toBe(0);
    expect(await page.evaluate(() => window.__kurloE2E.store.requests.length)).toBeLessThanOrEqual(before);
  });

  test('writes request docs in Markdown with a live preview and an automatic reference', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/users?page=2');
    await page.getByRole('tab', { name: 'Docs' }).click();
    const docs = page.locator('.docs-tab');
    await expect(docs.getByRole('radio', { name: 'Edit' })).toHaveAttribute('aria-checked', 'true');
    await docs.getByLabel('Docs', { exact: true }).fill('# List users\n\nReturns **active** users.\n\n| Field | Type |\n|---|---|\n| id | `string` |\n\n[API guide](https://kurlo.dev/docs)');
    await expect(docs.locator('.docs-preview h2')).toHaveText('List users');
    await expect(docs.locator('.docs-preview strong')).toHaveText('active');
    await expect(docs.locator('.docs-preview table td').first()).toHaveText('id');
    await docs.getByRole('radio', { name: 'Preview' }).click();
    await expect(docs.locator('textarea')).toHaveCount(0);
    await expect(docs.locator('.docs-ref-url')).toHaveText('https://api.kurlo.test/users?page=2');
    await expect(docs.locator('.docs-ref-row').first()).toContainText('page');
    await expect(docs.locator('.md-link')).toHaveAttribute('href', 'https://kurlo.dev/docs');
    await captureDocsScreenshot(page, 'request-docs');
  });

  test('switches the response beside the request from the status bar', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 780 });
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await expect(page.locator('.request-split')).not.toHaveClass(/split-right/);
    await page.getByRole('button', { name: 'Show the response beside the request' }).click();
    await expect(page.locator('.request-split')).toHaveClass(/split-right/);
    const divider = await page.getByRole('button', { name: 'Resize panels' }).boundingBox();
    const editor = await page.locator('.request-editor').boundingBox();
    const response = await page.locator('.request-split > :last-child').boundingBox();
    expect(divider!.width).toBeLessThanOrEqual(1.5);
    expect(Math.abs(editor!.x + editor!.width - divider!.x)).toBeLessThan(1);
    expect(Math.abs(response!.x - (divider!.x + divider!.width))).toBeLessThan(1);
    const before = editor!.width;
    await page.mouse.move(divider!.x + 3, divider!.y + 200);
    await page.mouse.down();
    await page.mouse.move(divider!.x + 83, divider!.y + 200, { steps: 6 });
    await page.mouse.up();
    expect((await page.locator('.request-editor').boundingBox())!.width).toBeGreaterThan(before + 40);
    await page.getByRole('button', { name: 'Show the response below the request' }).click();
    await expect(page.locator('.request-split')).not.toHaveClass(/split-right/);
  });

  test('shows HTTP methods and other protocols side by side in the method menu', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await page.getByLabel('Method and protocol').click();
    const groups = page.locator('.method-menu-group');
    await expect(groups).toHaveCount(2);
    const [http, other] = [await groups.first().boundingBox(), await groups.last().boundingBox()];
    expect(other!.x).toBeGreaterThan(http!.x + http!.width - 2);
    expect(Math.abs(other!.y - http!.y)).toBeLessThan(2);
    await page.getByRole('option', { name: 'AI', exact: true }).click();
    await expect(page.getByLabel('Provider base URL')).toBeVisible();
  });

  test('discovers an MCP server, calls a tool, and keeps the raw exchange', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'MCP Request');
    await page.getByLabel('Request URL').fill('https://mcp.kurlo.test/mcp');

    await page.getByLabel('Request URL').press('Tab');

    const discover = page.locator('.mcp-discover');
    await expect(discover).toBeEnabled();
    await discover.click();

    await expect(page.locator('.mcp-server')).toContainText('E2E Weather');
    await expect(page.locator('.mcp-server')).toContainText('1 tool');

    await chooseAppSelect(page, page.locator('.mcp-select').first(), 'tools/call');
    await chooseAppSelect(page, page.locator('.mcp-select').nth(1), 'Weather lookup');
    await expect(page.locator('.mcp-editor')).toContainText('location');

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.mcp-result-panel')).toContainText('It is 21C and clear.');
    await captureDocsScreenshot(page, 'request-mcp');

    await page.getByRole('tab', { name: 'Raw exchange' }).click();
    await expect(page.locator('.mcp-code')).toContainText('jsonrpc');

    const sent = await page.evaluate(() => window.__kurloE2E.sentMcpRequests.map(r => r.mcpMethod));
    expect(sent).toEqual(['server/discover', 'tools/list', 'tools/call']);
  });

  test('names the MCP revision of a server that needs a session', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'MCP Request');
    await page.getByLabel('Request URL').fill('https://legacy.kurlo.test/mcp');
    await page.getByLabel('Request URL').press('Tab');
    await page.locator('.mcp-discover').click();

    await expect(page.locator('.mcp-server')).toContainText('E2E Legacy');
    await expect(page.locator('.mcp-server')).toContainText('MCP 2025-06-18');
    if (process.env.KURLO_E2E_SHOT) await page.locator('.mcp-call').screenshot({ path: process.env.KURLO_E2E_SHOT });

    await page.getByLabel('Request URL').fill('https://mcp.kurlo.test/mcp');
    await page.getByLabel('Request URL').press('Tab');
    await page.locator('.mcp-discover').click();
    await expect(page.locator('.mcp-server')).toContainText('E2E Weather');
    await expect(page.locator('.mcp-server')).not.toContainText('MCP 2026');
  });

  test('reloads a running mock after an example changes with the panel closed', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Orders API');
    await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('Get order');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders/8123');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();
    await page.getByRole('button', { name: 'Save as example', exact: true }).click();
    await page.locator('.save-btn:not(.revert-btn)').first().click();
    await expect(page.locator('.save-btn:not(.revert-btn)').first()).toBeDisabled();

    await page.getByLabel('Mock server', { exact: true }).click();
    const panel = page.locator('section[aria-label="Mock server"]');
    await panel.locator('.mock-select').getByRole('button').first().click();
    await page.getByRole('option', { name: 'Orders API — 1 example' }).click();
    await panel.getByRole('button', { name: 'Start server' }).click();
    await expect(panel.locator('.mock-live-label')).toHaveText('Running');

    await page.locator('.collection-request').filter({ hasText: 'Get order' }).click();
    await expect(panel).toHaveCount(0);

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Save as example', exact: true }).click();
    await expect(page.locator('.examples-row')).toHaveCount(2);
    await page.locator('.save-btn:not(.revert-btn)').first().click();
    await expect(page.locator('.save-btn:not(.revert-btn)').first()).toBeDisabled();

    await expect
      .poll(() => page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('StartMockServer'))))
      .toEqual(['StartMockServer:Orders API:1', 'StartMockServer:Orders API:2']);
  });

  test('pairs a browser from the Sync Cookies tab and syncs into the open workspace', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders');
    await page.getByRole('button', { name: 'Cookies', exact: true }).click();

    const modal = page.getByRole('dialog', { name: 'Cookies' });
    await modal.getByRole('tab', { name: /Sync cookies/i }).click();
    await expect(modal.getByText('Cookie sync is off')).toBeVisible();

    await modal.getByRole('button', { name: 'Turn on' }).click();
    await expect(modal.getByText('Waiting for a browser')).toBeVisible();
    await expect(modal.getByText(/install the extension and press Connect/)).toBeVisible();
    await captureDocsScreenshot(page, 'cookie-jar-sync');

    const manualDisclosure = modal.locator('.cookie-sync-manual > summary');
    await manualDisclosure.click();
    await expect(modal.locator('.cookie-sync-code')).toHaveText(/^kurlo-3199-/);
    await modal.getByRole('button', { name: 'Copy' }).click();
    await expect(modal.getByRole('button', { name: 'Copied' })).toBeVisible();
    await manualDisclosure.click();

    await modal.getByRole('button', { name: /Add api\.kurlo\.test from the open request/ }).click();
    await expect(modal.locator('.cookie-sync-chip')).toHaveText([/api\.kurlo\.test/]);

    await modal.getByPlaceholder('example.com').fill('https://Shop.Kurlo.test/cart?page=2');
    await modal.getByRole('button', { name: 'Add domain' }).click();
    await expect(modal.locator('.cookie-sync-chip')).toHaveText([/api\.kurlo\.test/, /shop\.kurlo\.test/]);

    await modal.getByPlaceholder('example.com').fill('nope');
    await modal.getByRole('button', { name: 'Add domain' }).click();
    await expect(modal.getByText(/does not look like a domain/)).toBeVisible();
    await expect(modal.locator('.cookie-sync-chip')).toHaveCount(2);

    await page.evaluate(() => {
      const state = window.__kurloE2E;
      state.cookieSync = {
        ...state.cookieSync,
        pending: {
          id: 'pair-1',
          browser: 'Chrome',
          extensionId: 'kurlocookiesyncextension',
          code: '482913',
          requestedAt: Date.now(),
          expiresAt: Date.now() + 120000,
        },
      };
      state.emit('cookies:synced', state.cookieSync);
    });

    await expect(modal.getByText('Chrome wants to connect')).toBeVisible();
    await expect(modal.locator('.cookie-sync-approval-code')).toHaveText('482913');
    await expect(modal.getByText(/kurlocookiesyncextension/)).toBeVisible();
    await captureDocsScreenshot(page, 'cookie-jar-sync-approval');

    await modal.getByRole('button', { name: 'Allow' }).click();
    await expect(modal.getByText('Chrome is connected')).toBeVisible();
    await expect(modal.locator('.cookie-sync-approval')).toHaveCount(0);
    expect(await page.evaluate(() => window.__kurloE2E.calls.filter((entry: string) => entry.startsWith('ApproveCookieSyncPairing')))).toEqual(['ApproveCookieSyncPairing:pair-1']);

    await page.evaluate(async () => {
      const app = window.go.api.App;
      await app.UpsertCookie('workspace-e2e', {
        name: 'session',
        value: 'from-browser',
        domain: 'api.kurlo.test',
        path: '/',
        expiresAt: 0,
        session: true,
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        hostOnly: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      window.__kurloE2E.emit('cookies:synced', {
        ...(await app.CookieSyncStatus()),
        paired: true,
        connected: true,
        browser: 'Chrome',
        lastSyncAt: Date.now(),
        lastSyncCount: 1,
        log: [{
          id: 'cookie-sync-1',
          timestamp: Date.now(),
          browser: 'Chrome',
          domain: 'api.kurlo.test',
          accepted: 1,
          skipped: 0,
          removed: 0,
          message: '1 cookie synced',
        }],
      });
    });

    await expect(modal.getByText('Chrome is connected')).toBeVisible();
    await expect(modal.locator('.cookie-sync-log')).toContainText('1 cookie synced');

    await page.evaluate(async () => {
      const state = window.__kurloE2E;
      state.cookieSync = { ...state.cookieSync, connected: true, browser: 'Chrome', unreadable: ['shop.kurlo.test'] };
      state.emit('cookies:synced', state.cookieSync);
    });
    await expect(modal.getByText(/not allowed to read shop\.kurlo\.test/)).toBeVisible();
    await expect(modal.locator('.cookie-sync-chip.unreadable')).toHaveCount(1);
    await captureDocsScreenshot(page, 'cookie-jar-sync-paired');

    await modal.getByRole('tab', { name: 'Manage cookies' }).click();
    await expect(modal.locator('.cookie-domain-card')).toContainText('api.kurlo.test');
    await expect(modal.locator('.cookie-domain-card')).toContainText('session');

    await modal.getByRole('tab', { name: /Sync cookies/i }).click();
    await modal.getByRole('button', { name: 'Disconnect it' }).click();
    await expect(modal.getByText('Waiting for a browser')).toBeVisible();

    await modal.getByRole('button', { name: 'Turn off' }).click();
    await expect(modal.getByText('Cookie sync is off')).toBeVisible();
    await expect(modal.locator('.cookie-sync-code')).toHaveCount(0);
  });
});

test.describe('Startup screen', () => {
  async function endLastSessionOnGit(page: Page, startupView = '') {
    await page.addInitScript((view) => {
      localStorage.setItem('kurlo.topView.v1', JSON.stringify({ topView: 'git', gitWorkspaceOpen: true }));
      if (view) localStorage.setItem('kurlo.startupView.v1', view);
    }, startupView);
  }

  test('opens on the request editor even when the last session ended on Git', async ({ page }) => {
    await installKurloBridge(page);
    await endLastSessionOnGit(page);
    await page.goto('/');

    await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
    await expect(page.locator('.git-workspace')).toHaveCount(0);
    await expect(page.locator('.workspace-overview')).toHaveCount(0);
  });

  test('reopens the last screen when set to where you left off', async ({ page }) => {
    await installKurloBridge(page);
    await endLastSessionOnGit(page, 'restore');
    await page.goto('/');

    await expect(page.locator('.git-workspace')).toBeVisible();
  });

  test('starts on the workspace overview when set to it', async ({ page }) => {
    await installKurloBridge(page);
    await endLastSessionOnGit(page, 'overview');
    await page.goto('/');

    await expect(page.locator('.workspace-overview')).toBeVisible();
  });

  test('chooses the startup screen in settings', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    const card = page.locator('details.settings-card').filter({ hasText: 'On launch' });
    await expect(card.locator('.settings-card-subtitle')).toHaveText('Request editor');
    await card.locator('summary').click();
    await card.getByRole('radio', { name: /Where you left off/ }).click();
    await expect(card.getByRole('radio', { name: /Where you left off/ })).toHaveAttribute('aria-checked', 'true');
    await expect(card.locator('.settings-card-subtitle')).toHaveText('Where you left off');
    expect(await page.evaluate(() => localStorage.getItem('kurlo.startupView.v1'))).toBe('restore');
  });
});

test.describe('Key-value tables', () => {
  test('centres the row checkbox in its column', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.responseLayout.v1', 'below'));
    await page.goto('/');
    await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
    await page.getByRole('tab', { name: /^Headers/ }).click();
    const row = page.getByTestId('request-header-row').first();
    await row.getByPlaceholder('Key').fill('Accept');
    const offsets = await row.evaluate(rowEl => {
      const check = rowEl.querySelector('.check')!.getBoundingClientRect();
      const rowBox = rowEl.getBoundingClientRect();
      const column = parseFloat(getComputedStyle(rowEl).gridTemplateColumns.split(' ')[0]);
      return { left: check.left - rowBox.left, centre: check.left + check.width / 2 - rowBox.left, column };
    });
    expect(offsets.left).toBeGreaterThan(0);
    expect(Math.abs(offsets.centre - offsets.column / 2)).toBeLessThan(1);
  });
});

test.describe('Empty states', () => {
  test('spaces the history filter empty state and keeps the status filter full width', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByPlaceholder('Enter request URL or paste cURL…').fill('https://api.kurlo.test/orders');
    await page.getByRole('button', { name: /^Send( |$)/ }).first().click();
    await expect(page.getByText(/200 OK/).first()).toBeVisible();
    await page.getByRole('button', { name: 'History' }).click();
    const filter = page.locator('.history-status-filter');
    await filter.getByRole('radio', { name: '5xx', exact: true }).click();
    const empty = page.locator('.history-empty');
    await expect(empty.getByText('Nothing matches this filter.')).toBeVisible();
    const gap = await empty.evaluate(el => el.querySelector('.btn')!.getBoundingClientRect().top - el.querySelector('.empty-state-title')!.getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(8);
    const widths = await filter.evaluate(el => ({ filter: el.getBoundingClientRect().width, search: el.parentElement!.querySelector('.sidebar-search')!.getBoundingClientRect().width }));
    expect(Math.abs(widths.filter - widths.search)).toBeLessThan(1);
  });
});

test.describe('Interface size', () => {
  const rootFontSize = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  const sidebarWidth = (page: Page) => page.locator('aside.sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width));

  test('zooms the whole interface from the keyboard and the View menu', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
    expect(await rootFontSize(page)).toBe('16px');
    const baseSidebar = await sidebarWidth(page);
    const sendHeight = await page.getByRole('button', { name: /^Send( |$)/ }).first().evaluate(el => el.getBoundingClientRect().height);

    await page.keyboard.press('Control+=');
    await page.keyboard.press('Control+=');
    await expect.poll(() => rootFontSize(page)).toBe('20px');
    expect(await page.evaluate(() => localStorage.getItem('kurlo.uiScale.v1'))).toBe('1.25');
    await expect.poll(() => sidebarWidth(page)).toBe(Math.round(baseSidebar * 1.25));
    await expect.poll(() => page.getByRole('button', { name: /^Send( |$)/ }).first().evaluate(el => el.getBoundingClientRect().height)).toBeCloseTo(sendHeight * 1.25, 0);

    await page.keyboard.press('Control+-');
    await expect.poll(() => rootFontSize(page)).toBe('17.6px');

    await page.evaluate(() => window.__kurloE2E.emit('kurlo:zoom', 'out'));
    await page.evaluate(() => window.__kurloE2E.emit('kurlo:zoom', 'out'));
    await expect.poll(() => rootFontSize(page)).toBe('14.4px');
    expect(await page.evaluate(() => localStorage.getItem('kurlo.uiScale.v1'))).toBe('0.9');
    await page.evaluate(() => window.__kurloE2E.emit('kurlo:zoom', 'in'));
    await expect.poll(() => rootFontSize(page)).toBe('16px');
    await page.evaluate(() => window.__kurloE2E.emit('kurlo:zoom', 'in'));
    await expect.poll(() => rootFontSize(page)).toBe('17.6px');
    await page.evaluate(() => window.__kurloE2E.emit('kurlo:zoom', 'reset'));
    await expect.poll(() => rootFontSize(page)).toBe('16px');

    await page.keyboard.press('Control+=');
    await page.keyboard.press('Control+0');
    await expect.poll(() => rootFontSize(page)).toBe('16px');
    expect(await page.evaluate(() => localStorage.getItem('kurlo.uiScale.v1'))).toBeNull();
  });

  test('starts at the saved size', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.uiScale.v1', '1.25'));
    await page.goto('/');
    await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
    expect(await rootFontSize(page)).toBe('20px');
    await expect.poll(() => sidebarWidth(page)).toBe(350);
  });
});

test.describe('README screenshot', () => {
  test.use({ colorScheme: 'dark' });
  test('captures the README screenshot', async ({ page }) => {
    test.skip(!readmeScreenshotPath, 'Set KURLO_README_SCREENSHOT to capture the README screenshot');
    await page.setViewportSize({ width: 1440, height: 900 });
    await installKurloBridge(page, '', 'darwin/e2e', false);
    await page.addInitScript(() => {
      const app = (window as any).go.api.App;
      app.AppInfo = async () => ({ name: 'Kurlo', version: '2.0.0', runtime: 'darwin/e2e', goVersion: 'e2e' });
      for (const workspace of (window as any).__kurloE2E.store.workspaces ?? []) workspace.name = 'Acme';
      const send = app.SendRequest;
      app.SendRequest = async (req: any) => {
        if (!String(req.url).includes('/orders')) return send(req);
        const body = JSON.stringify({
          id: 'ord_8f3k2m',
          status: 'confirmed',
          customer: { id: 'cus_1042', name: 'Ada Lovelace', email: 'ada@example.com' },
          items: [
            { sku: 'KB-75', name: 'Mechanical keyboard', quantity: 1, price: 149.0 },
            { sku: 'MS-02', name: 'Wireless mouse', quantity: 2, price: 39.5 },
          ],
          total: 228.0,
          currency: 'EUR',
          createdAt: '2026-09-30T18:42:07Z',
        }, null, 2);
        return { statusCode: 201, status: '201 Created', headers: [{ key: 'content-type', value: 'application/json' }, { key: 'location', value: '/orders/ord_8f3k2m' }], body, duration: 86, size: body.length, error: '', warnings: [], timeline: [], sentRequests: [], testResult: { tests: [{ name: 'status is 201', passed: true }, { name: 'returns an order id', passed: true }], logs: [] }, preRequestResult: { tests: [], logs: [] } };
      };
    });
    await page.goto('/');
    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Orders API');
    for (const [name, method, url] of [
      ['List orders', 'GET', '{{baseUrl}}/orders?status=open'],
      ['Get order', 'GET', '{{baseUrl}}/orders/{{orderId}}'],
      ['Cancel order', 'DELETE', '{{baseUrl}}/orders/{{orderId}}'],
      ['Create order', 'POST', '{{baseUrl}}/orders'],
    ] as const) {
      await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
      await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
      await chooseRequestType(page, 'HTTP Request');
      await page.getByLabel('Request name').fill(name);
      await page.getByLabel('Request name').press('Enter');
      if (method !== 'GET') {
        await page.getByLabel('Method and protocol').click();
        await page.getByRole('option', { name: method }).click();
      }
      await page.getByLabel('Request URL').fill(url);
    }
    await chooseRequestSection(page, 'Body');
    await page.locator('label.body-mode-label').filter({ hasText: 'raw' }).click();
    await fillCodeEditor(page, 'request-body-editor', JSON.stringify({ customerId: 'cus_1042', items: [{ sku: 'KB-75', quantity: 1 }, { sku: 'MS-02', quantity: 2 }], currency: 'EUR' }, null, 2));
    await page.getByRole('button', { name: /^Send( |$)/ }).first().click();
    await expect(page.getByText('201 Created')).toBeVisible();
    await page.locator('.response-mini-tabs').getByRole('tab', { name: 'Body' }).click();
    await page.mouse.move(1439, 899);
    await page.waitForTimeout(400);
    await page.screenshot({ path: readmeScreenshotPath });
  });
});

test.describe('Update release notes', () => {
  test('long notes scroll under the update status instead of squeezing it away', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const app = (window as any).go.api.App;
      const item = (n: number) => `- **Change ${n}.** ${'A long sentence about what changed and why it matters to you. '.repeat(6)}`;
      app.AppInfo = async () => ({ name: 'Kurlo', version: '2.2.6', runtime: 'darwin/e2e', goVersion: 'e2e', packaged: false });
      app.CheckForUpdate = async () => ({
        info: {
          version: '2.3.0',
          releaseNotes: ['### Added', ...Array.from({ length: 8 }, (_, i) => item(i)), '### Fixed', item(9)].join('\n'),
          publishedAt: '2026-10-14T10:00:00Z',
          downloadUrl: 'https://github.com/stormhop/kurlo/releases/download/v2.3.0/kurlo-darwin-universal.app.zip',
          assetName: 'kurlo-darwin-universal.app.zip',
          sha256: 'abc123',
          signatureUrl: '',
          manualInstallUrl: '',
        },
        error: '',
      });
    });
    await page.goto('/');

    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'About', exact: true }).click();
    const about = page.locator('#settings-panel-about');
    await expect(about).toContainText('Kurlo 2.3.0 is available');
    await expect(about).toContainText('Change 9');

    const row = about.locator('.about-update-row');
    const box = await row.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(40);
    const list = await about.locator('.about-list').boundingBox();
    expect(list?.height ?? 0).toBeGreaterThan(box?.height ?? 0);
    await about.getByRole('button', { name: 'Install', exact: true }).click({ trial: true });

    const scrolls = await about.evaluate(element => element.scrollHeight > element.clientHeight);
    expect(scrolls).toBe(true);
  });

  test('About shows the bird perched on the wire in the night scene', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'About', exact: true }).click();
    const scene = page.locator('#settings-panel-about .about-night');
    await expect(scene).toBeVisible();
    await expect.poll(() => scene.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);

    const sceneBox = await scene.boundingBox();
    const birdBox = await scene.locator('.about-night-bird').boundingBox();
    expect(birdBox && sceneBox && birdBox.x > sceneBox.x && birdBox.x + birdBox.width < sceneBox.x + sceneBox.width).toBe(true);
    expect(birdBox && sceneBox && birdBox.y > sceneBox.y && birdBox.y + birdBox.height < sceneBox.y + sceneBox.height).toBe(true);
    await expect(page.locator('#settings-panel-about')).toContainText('Kurlo');
  });
});

test.describe('Windows app package updates', () => {
  test('offers the MSIX download instead of replacing a packaged install', async ({ page }) => {
    const msixUrl = 'https://github.com/stormhop/kurlo/releases/download/v2.1.0/kurlo-2.1.0-windows-amd64.msix';
    await installKurloBridge(page, '', 'windows/e2e', false);
    await page.addInitScript((msixUrl) => {
      const state = (window as any).__kurloE2E;
      const app = (window as any).go.api.App;
      localStorage.setItem('kurlo:auto-update-install', 'true');
      app.AppInfo = async () => ({ name: 'Kurlo', version: '2.0.2', runtime: 'windows/e2e', goVersion: 'e2e', packaged: true });
      app.CheckForUpdate = async () => ({
        info: {
          version: '2.1.0',
          releaseNotes: '### Fixed\n- Packaged installs update cleanly',
          publishedAt: '2026-10-01T10:00:00Z',
          downloadUrl: 'https://github.com/stormhop/kurlo/releases/download/v2.1.0/kurlo-windows-amd64.exe',
          assetName: 'kurlo-windows-amd64.exe',
          sha256: 'abc123',
          signatureUrl: '',
          manualInstallUrl: msixUrl,
        },
        error: '',
      });
      app.ApplyUpdate = async () => {
        state.calls.push('ApplyUpdate');
        return '';
      };
    }, msixUrl);
    await page.goto('/');

    const banner = page.locator('.update-notif');
    await expect(banner).toContainText('Kurlo 2.1.0 is available');
    await banner.getByRole('button', { name: 'Download' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls)).toContain(`open:${msixUrl}`);

    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'About', exact: true }).click();
    const about = page.locator('#settings-panel-about');
    await expect(about).toContainText('Kurlo 2.1.0 is available');
    await expect(about).toContainText('.msix');
    await expect(about).toContainText('Packaged installs update cleanly');
    await expect(about.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
    await about.getByRole('button', { name: 'Download', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.__kurloE2E.calls)).filter((call: string) => call === `open:${msixUrl}`).length).toBe(2);

    const autoInstall = page.getByLabel('Install updates automatically').locator('input');
    await expect(autoInstall).toBeDisabled();
    await expect(autoInstall).not.toBeChecked();
    await expect(about).toContainText('Not available for the Windows app package');

    const calls = await page.evaluate(() => window.__kurloE2E.calls);
    expect(calls).not.toContain('ApplyUpdate');
  });
});

test.describe('Binary responses', () => {
  test('keeps a binary body out of the window and saves it from Go', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/binary-response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText('This response is binary')).toBeVisible();
    await expect(page.getByText('Response body is empty')).toHaveCount(0);
    await expect(page.getByText('application/zip, 100.00 MB.', { exact: false })).toBeVisible();
    await page.locator('.response-binary-actions').getByRole('button', { name: 'Save to file' }).click();
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E.calls as string[]).filter(call => call.startsWith('SaveResponseBody:')))).toHaveLength(1);
    const calls = await page.evaluate(() => window.__kurloE2E.calls as string[]);
    expect(calls.some(call => call === 'SaveFileDialog')).toBe(false);
  });
});

test.describe('Huge responses', () => {
  test('pages a 100 MB text response without freezing the window', async ({ page }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/huge-response');
    const started = Date.now();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible({ timeout: 60_000 });
    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer.locator('.response-line').first()).toBeVisible({ timeout: 60_000 });
    const shownMs = Date.now() - started;

    await expect(page.getByText('Large response preview')).toBeVisible();
    expect(await viewer.locator('.response-line').count()).toBeLessThan(200);

    const pageStarted = Date.now();
    await page.getByLabel('Next response page').click();
    await expect(page.locator('.response-page-count')).toHaveText(/^2\//);
    await expect(viewer.locator('.response-line').first()).toBeVisible();
    const nextPageMs = Date.now() - pageStarted;

    const probe = await page.evaluate(() => {
      const started = performance.now();
      return new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - started), 0));
    });

    console.log(`huge response: shown ${shownMs}ms, next page ${nextPageMs}ms, event loop delay ${Math.round(probe)}ms`);
    expect(pageErrors).toEqual([]);
    expect(shownMs).toBeLessThan(15_000);
    expect(nextPageMs).toBeLessThan(2_000);
  });
});

test.describe('Cookie sync extension', () => {
  test('sets the extension up from the app and flags an outdated one', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      (window as any).go.api.App.AppInfo = async () => ({ name: 'Kurlo', version: '2.5.0', runtime: 'darwin/e2e', goVersion: 'e2e' });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Cookies', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Cookies' });
    await modal.getByRole('tab', { name: /Sync cookies/i }).click();

    await modal.getByRole('button', { name: 'Chrome, Edge, Brave' }).click();
    await expect(modal.getByText('chrome://extensions')).toBeVisible();
    await expect(modal.getByText(/Load unpacked/)).toBeVisible();
    await expect(modal.locator('.cookie-sync-path')).toHaveText(/browser-extension\/chromium$/);
    await expect(modal.getByText(/Version 2\.5\.0/)).toBeVisible();
    expect(await page.evaluate(() => (window.__kurloE2E.calls as string[]).filter(call => call.startsWith('InstallBrowserExtension')))).toEqual(['InstallBrowserExtension:chromium']);

    await page.evaluate(() => {
      const state = window.__kurloE2E as any;
      state.cookieSync = { ...state.cookieSync, enabled: true, running: true, paired: true, connected: true, browser: 'Chrome', extensionVersion: '1.0.0' };
      state.emit('cookies:synced', state.cookieSync);
    });
    await expect(modal.getByText('The extension is older than Kurlo')).toBeVisible();
    await expect(modal.getByText(/runs extension 1\.0\.0, Kurlo is 2\.5\.0/)).toBeVisible();
    await modal.getByRole('button', { name: 'Refresh files' }).click();
    expect(await page.evaluate(() => (window.__kurloE2E.calls as string[]).filter(call => call.startsWith('InstallBrowserExtension')))).toHaveLength(2);

    await page.evaluate(() => {
      const state = window.__kurloE2E as any;
      state.cookieSync = { ...state.cookieSync, extensionVersion: '2.5.0' };
      state.emit('cookies:synced', state.cookieSync);
    });
    await expect(modal.getByText('The extension is older than Kurlo')).toHaveCount(0);
  });
});

test.describe('GitHub star prompt', () => {
  test('shows once after the twentieth send and stays away when closed', async ({ page }) => {
    const shots = process.env.KURLO_STAR_SHOTS ?? '';
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.starPrompt.v1', JSON.stringify({ sends: 19, done: false })));
    await page.goto('/');
    const prompt = page.getByRole('button', { name: 'Star on GitHub' });
    await expect(prompt).toHaveCount(0);
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/users');
    await page.getByRole('button', { name: /^Send( |$)/ }).first().click();
    await expect(prompt).toBeVisible();
    if (shots) await page.locator('.status-bar').screenshot({ path: `${shots}/status-light.png` });
    await page.getByRole('button', { name: 'Hide the GitHub star prompt' }).click();
    await expect(prompt).toHaveCount(0);
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('kurlo.starPrompt.v1') ?? '{}'))).toEqual({ sends: 20, done: true });
    await page.getByRole('button', { name: /^Send( |$)/ }).first().click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(2);
    await page.waitForTimeout(300);
    await expect(prompt).toHaveCount(0);
  });

  test('opens the repository from the status bar and from Support', async ({ page }) => {
    const shots = process.env.KURLO_STAR_SHOTS ?? '';
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.starPrompt.v1', JSON.stringify({ sends: 20, done: false })));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Star on GitHub' })).toBeVisible();
    if (shots) await page.locator('.status-bar').screenshot({ path: `${shots}/status-dark.png` });
    await page.getByRole('button', { name: 'Star on GitHub' }).click();
    await expect(page.getByRole('button', { name: 'Star on GitHub' })).toHaveCount(0);
    expect(await page.evaluate(() => window.__kurloE2E.calls.filter(call => call === 'open:https://github.com/stormhop/kurlo'))).toHaveLength(1);
    await page.locator('.version-pill').click();
    await page.getByRole('tab', { name: 'Support' }).click();
    const card = page.getByRole('button', { name: /Star Kurlo on GitHub/ });
    await expect(card).toBeVisible();
    if (shots) await page.locator('#settings-panel-support').screenshot({ path: `${shots}/support-dark.png` });
    await card.click();
    expect(await page.evaluate(() => window.__kurloE2E.calls.filter(call => call === 'open:https://github.com/stormhop/kurlo'))).toHaveLength(2);
  });
});

test.describe('External workspace changes', () => {
  test('keep the open request on the tab the user is looking at', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.collections = [{ id: 'collection-ext', workspaceId: 'workspace-e2e', name: 'Orders', filesystemName: 'Orders' }];
      store.requests = [{ id: 'req-ext', name: 'Create order', collectionId: 'collection-ext', collection: 'Orders', folderPath: [], requestType: 'http', method: 'POST', url: 'https://api.example.test/orders', testScriptJs: 'pm.test("first", () => {})' }];
      store.activeId = 'req-ext';
      store.openIds = ['req-ext'];
    });
    await page.goto('/');
    await chooseRequestSection(page, 'Scripts');
    await page.getByRole('tab', { name: /^Tests/ }).click();
    await expect(page.getByTestId('test-script-editor')).toContainText('first');
    await page.evaluate(() => {
      const store = window.__kurloE2E.store as { requests: Array<Record<string, unknown>> };
      store.requests[0].testScriptJs = 'pm.test("added by an agent", () => {})';
      window.__kurloE2E.emit('kurlo:workspace-changed', 'Create-order.yml changed');
    });
    await expect(page.getByTestId('test-script-editor')).toContainText('added by an agent');
    await expect(page.locator('.request-editor-tabs-shell').getByRole('tab', { name: 'Scripts' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: /^Tests/ })).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('Protocol badge', () => {
  test('stays as narrow as its label after the request is created', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const request = (id: string, requestType: string, url: string, method = 'GET') => ({ id, name: id, collectionId: 'collection-ef', collection: 'EF', folderPath: [], requestType, method, url });
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.collections = [{ id: 'collection-ef', workspaceId: 'workspace-e2e', name: 'EF', filesystemName: 'EF' }];
      store.requests = [
        request('http', 'http', 'https://api.example.test/'),
        request('ws', 'ws', 'wss://echo.websocket.org'),
        request('gql', 'graphql', 'https://countries.trevorblades.com/', 'POST'),
        request('sio', 'socketio', 'https://api.example.test/'),
      ];
      store.activeId = 'http';
      store.openIds = ['http', 'ws', 'gql', 'sio'];
    });
    await page.goto('/');
    const widths: Record<string, number> = {};
    for (const id of ['http', 'ws', 'gql', 'sio']) {
      await page.getByRole('tab', { name: new RegExp(`\\b${id}$`) }).first().click();
      const trigger = page.getByRole('button', { name: 'Method and protocol' });
      await expect(trigger).toBeVisible();
      widths[id] = Math.round((await trigger.boundingBox())!.width);
    }
    await page.getByRole('tab', { name: /\bws$/ }).first().click();
    for (const type of ['WebSocket', 'Socket.IO', 'GraphQL']) {
      await page.getByLabel('New unsaved request').click();
      await chooseRequestType(page, type);
      const trigger = page.getByRole('button', { name: 'Method and protocol' });
      widths[`${type} draft`] = Math.round((await trigger.boundingBox())!.width);
      await page.getByLabel('Request URL').fill(type === 'WebSocket' ? 'wss://echo.websocket.org' : 'https://api.example.test/');
      widths[`${type} with url`] = Math.round((await trigger.boundingBox())!.width);
    }
    for (const [label, width] of Object.entries(widths)) expect(width, label).toBeLessThanOrEqual(widths.http + 24);
    expect(widths.ws, 'a locked WS badge hugs its label').toBeLessThanOrEqual(56);
  });
});

test.describe('Request tabs', () => {
  test('switching and closing tabs saves only the view, not the whole store', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const request = (id: string) => ({ id, name: id, collectionId: 'collection-tabs', collection: 'Tabs', folderPath: [], requestType: 'http', method: 'GET', url: `https://api.example.test/${id}` });
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.collections = [{ id: 'collection-tabs', workspaceId: 'workspace-e2e', name: 'Tabs', filesystemName: 'Tabs' }];
      store.requests = [request('alpha'), request('beta'), request('gamma')];
      store.activeId = 'alpha';
      store.openIds = ['alpha', 'beta'];
    });
    await page.goto('/');
    await expect(page.getByLabel('Request URL')).toHaveValue(/alpha$/);
    await page.evaluate(() => { window.__kurloE2E.calls.length = 0; });

    await page.getByRole('tab', { name: /\bbeta$/ }).first().click();
    await expect(page.getByLabel('Request URL')).toHaveValue(/beta$/);
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedViews.at(-1))).toEqual({ activeId: 'beta', activeWorkspaceId: 'workspace-e2e', openIds: ['alpha', 'beta'] });

    await page.getByText('gamma', { exact: true }).first().click();
    await expect(page.getByLabel('Request URL')).toHaveValue(/gamma$/);
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedViews.at(-1))).toEqual({ activeId: 'gamma', activeWorkspaceId: 'workspace-e2e', openIds: ['alpha', 'beta', 'gamma'] });

    await page.getByRole('button', { name: 'Close tab' }).nth(2).click();
    await expect(page.getByLabel('Request URL')).toHaveValue(/beta$/);
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedViews.at(-1))).toEqual({ activeId: 'beta', activeWorkspaceId: 'workspace-e2e', openIds: ['alpha', 'beta'] });

    const calls = await page.evaluate(() => window.__kurloE2E.calls);
    expect(calls.filter(call => call === 'SaveRequestStore')).toEqual([]);
    expect(await page.evaluate(() => (window.__kurloE2E.store as { activeId: string }).activeId)).toBe('beta');
  });
});

test.describe('GraphQL explorer', () => {
  test('keeps every field row whole when the schema does not fit', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const fields = [
        'continent(code: ID!): Continent',
        'continents(filter: ContinentFilterInput = {}): [Continent!]!',
        'countries(filter: CountryFilterInput = {}): [Country!]!',
        'country(code: ID!): Country',
        'language(code: ID!): Language',
        'languages(filter: LanguageFilterInput = {}): [Language!]!',
        ...Array.from({ length: 14 }, (_, index) => `extra${index}(id: ID!, first: Int = 10, after: String): [Country!]!`),
      ];
      const schema = `type Query {\n  ${fields.join('\n  ')}\n}\ntype Continent { code: ID! }\ntype Country { code: ID! }\ntype Language { code: ID! }`;
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.collections = [{ id: 'collection-ef', workspaceId: 'workspace-e2e', name: 'EF', filesystemName: 'EF' }];
      store.requests = [{
        id: 'req-countries', name: 'New Request', collectionId: 'collection-ef', collection: 'EF', folderPath: [],
        requestType: 'graphql', method: 'POST', url: 'https://countries.trevorblades.com/', requestTab: 'query',
        bodyType: 'graphql', bodyContent: JSON.stringify({ query: 'query {\n  continents {\n    code\n  }\n}', variables: {} }),
        graphqlSchema: schema,
      }];
      store.activeId = 'req-countries';
      store.openIds = ['req-countries'];
    });
    await page.setViewportSize({ width: 1100, height: 640 });
    await page.goto('/');

    const rows = page.locator('.graphql-explorer-field');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBe(20);
    const layout = await rows.evaluateAll(buttons => buttons.map(button => {
      const box = button.getBoundingClientRect();
      const args = button.querySelector('.graphql-field-args')?.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, argsBottom: args?.bottom ?? box.top };
    }));
    for (let index = 0; index < layout.length; index += 1) {
      expect(layout[index].argsBottom, `arguments of row ${index} stay inside it`).toBeLessThanOrEqual(layout[index].bottom + 0.5);
      if (index) expect(layout[index].top, `row ${index} starts below row ${index - 1}`).toBeGreaterThanOrEqual(layout[index - 1].bottom - 0.5);
    }
    const clipped = await page.locator('.graphql-field-args, .graphql-field-name, .graphql-field-type').evaluateAll(elements => elements
      .filter(element => element.scrollHeight > element.clientHeight + 1)
      .map(element => `${element.className}: ${element.clientHeight}px of ${element.scrollHeight}px, line-height ${getComputedStyle(element).lineHeight}`));
    expect(clipped, 'text lines are not cut vertically').toEqual([]);
    const list = page.locator('.graphql-explorer-list');
    expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  });
});

test.describe('Send races', () => {
  async function openRequest(page: Page, url: string) {
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill(url);
  }

  test('twenty rapid Send clicks settle on the last send', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await openRequest(page, 'https://api.kurlo.test/slow?ms=600&cancelLag=200');

    const send = page.locator('.send-split .btn-send');
    for (let click = 0; click < 21; click += 1) await send.click({ delay: 0 });

    await expect(send).toHaveText(/^Send/, { timeout: 10_000 });
    const sent = await page.evaluate(() => (window.__kurloE2E.sentRequests as unknown[]).length);
    expect(sent).toBe(11);
    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).toContainText(`"sequence": ${sent}`);
    await page.waitForTimeout(600);
    await expect(viewer).toContainText(`"sequence": ${sent}`);
    await expect(page.getByText('Request canceled')).toHaveCount(0);
    await expect(send).toHaveText(/^Send/);
  });

  test('the bird waits in an empty response and while a request is out, and the status lands', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await openRequest(page, 'https://api.kurlo.test/slow?ms=1600');

    await expect(page.locator('.response-empty-state .kurlo-bird-perched')).toBeVisible();

    await page.locator('.send-split .btn-send').click();
    await expect(page.locator('.response-loading-state .kurlo-bird-flying')).toBeVisible();
    await expect(page.locator('.response-waiting-time')).toHaveText(/^1\.\d s$/);

    const badge = page.locator('.response-status-bar .status-badge');
    await expect(badge).toHaveText(/200 OK/);
    await expect(badge).toHaveClass(/status-arrived/);
    await expect(badge).not.toHaveClass(/status-arrived/);
    await expect(page.locator('.response-loading-state')).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/slow?ms=400');
    await page.locator('.send-split .btn-send').click();
    await expect(page.locator('.send-split .btn-send')).toHaveText(/^Send/);
    await expect(badge).not.toHaveClass(/status-arrived/);
  });

  test('Send, Cancel, Send keeps the spinner until the second answer', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await openRequest(page, 'https://api.kurlo.test/slow?ms=1500&cancelLag=500');

    const send = page.locator('.send-split .btn-send');
    await send.click();
    await expect(send).toHaveText(/Cancel/);
    await send.click();
    await expect(send).toHaveText(/^Send/);
    await send.click();
    await expect(send).toHaveText(/Cancel/);
    await page.waitForTimeout(300);
    await expect(send).toHaveText(/Cancel/);
    await expect(page.getByText('Request canceled')).toHaveCount(0);
    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).toContainText('"sequence": 2', { timeout: 5_000 });
    await expect(send).toHaveText(/^Send/);
  });

  test('switching environment mid-request keeps script changes in the environment the request used', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const row = (key: string, value: string) => ({ id: `${key}-${value}`, key, value, enabled: true, description: '' });
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.environments = [
        { id: 'env-a', workspaceId: 'workspace-e2e', name: 'Alpha', values: [row('host', 'a.kurlo.test')] },
        { id: 'env-b', workspaceId: 'workspace-e2e', name: 'Beta', values: [row('host', 'b.kurlo.test'), row('only-b', 'yes')] },
      ];
      store.activeEnvironmentId = 'env-a';
    });
    await page.goto('/');
    await openRequest(page, 'https://{{host}}/slow?ms=800&setenv=token:from-alpha');

    await page.locator('.send-split .btn-send').click();
    await page.locator('.environment-select').click();
    await page.getByRole('button', { name: 'Beta' }).click();
    await expect(page.locator('.environment-select')).toContainText('Beta');

    await expect(page.getByRole('textbox', { name: 'Response body', exact: true })).toContainText('a.kurlo.test', { timeout: 5_000 });
    await expect.poll(async () => page.evaluate(() => {
      const stores = window.__kurloE2E.savedStores as Array<{ environments?: Array<{ id: string; values: Array<{ key: string; value: string }> }> }>;
      const last = stores[stores.length - 1];
      const values = (id: string) => Object.fromEntries((last?.environments?.find(env => env.id === id)?.values ?? []).filter(row => row.key).map(row => [row.key, row.value]));
      return { alpha: values('env-a'), beta: values('env-b') };
    })).toEqual({
      alpha: { host: 'a.kurlo.test', token: 'from-alpha' },
      beta: { host: 'b.kurlo.test', 'only-b': 'yes' },
    });
    expect(await page.evaluate(() => window.__kurloE2E.environment)).toEqual({ host: 'b.kurlo.test', 'only-b': 'yes' });
  });

  test('deleting a request while it is in flight does not bring it back', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.collections = [{ id: 'collection-race', workspaceId: 'workspace-e2e', name: 'Race', filesystemName: 'Race' }];
      store.requests = [{ id: 'req-doomed', name: 'Doomed', collectionId: 'collection-race', collection: 'Race', folderPath: [], method: 'GET', url: 'https://api.kurlo.test/slow?ms=800' }];
      store.activeId = 'req-doomed';
      store.openIds = ['req-doomed'];
    });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto('/');
    await expect(page.getByLabel('Request URL')).toHaveValue('https://api.kurlo.test/slow?ms=800');

    await page.locator('.send-split .btn-send').click();
    const row = page.locator('.sidebar').getByText('Doomed', { exact: true }).first();
    await row.hover();
    await page.getByLabel('Request menu').first().click();
    await page.locator('.request-menu').getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog').getByRole('button', { name: /Delete/ });
    if (await confirm.count()) await confirm.click();

    await page.waitForTimeout(1_200);
    const stored = await page.evaluate(() => {
      const stores = window.__kurloE2E.savedStores as Array<{ requests: Array<{ id: string }> }>;
      return stores[stores.length - 1]?.requests.map(request => request.id) ?? [];
    });
    expect(stored).not.toContain('req-doomed');
    await expect(page.getByText('Doomed', { exact: true })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('Scale', () => {
  test('stays responsive with ten thousand requests, 200-deep folders and unicode names', async ({ page }) => {
    test.setTimeout(180_000);
    await installKurloBridge(page);
    await page.addInitScript((total) => {
      const deep = Array.from({ length: 200 }, (_, index) => `Уровень ${index} 📁`);
      const requests = Array.from({ length: total }, (_, index) => ({
        id: `big-${index}`,
        name: index % 4 === 1 ? `Заказ №${index} 🚀 注文` : index % 4 === 2 ? `request-${index}` : 'New Request',
        collectionId: 'collection-big',
        collection: 'Big',
        folderPath: index % 10 === 0 ? deep : [`Папка ${index % 50}`],
        method: 'GET',
        url: `https://api.example.test/items/${index}`,
      }));
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.collections = [{ id: 'collection-big', workspaceId: 'workspace-e2e', name: 'Big', filesystemName: 'Big' }];
      store.requests = requests;
    }, Number(process.env.SCALE_N ?? 10_000));

    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    const started = Date.now();
    await page.goto('/');
    await expect(collectionRow(page, 'Big')).toBeVisible({ timeout: 60_000 });
    const firstPaint = Date.now() - started;

    const searchStarted = Date.now();
    await page.getByRole('textbox', { name: 'Filter requests' }).fill('Заказ №9997');
    await expect(page.getByText('Заказ №9997 🚀 注文').first()).toBeVisible({ timeout: 30_000 });
    const searchMs = Date.now() - searchStarted;

    await page.getByText('Заказ №9997 🚀 注文').first().click();
    const url = page.getByPlaceholder('Enter request URL or paste cURL…');
    await expect(url).toHaveValue('https://api.example.test/items/9997');

    const savesBefore = await page.evaluate(() => (window.__kurloE2E.savedStores as unknown[]).length);
    const editStarted = Date.now();
    await url.fill('https://api.example.test/edited');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E.savedStores as unknown[]).length), { timeout: 30_000 }).toBeGreaterThan(savesBefore);
    const saveMs = Date.now() - editStarted;

    const saved = await page.evaluate(() => {
      const stores = window.__kurloE2E.savedStores as Array<{ requests: Array<{ id: string; url: string; folderPath: string[] }> }>;
      const last = stores[stores.length - 1];
      return { count: last.requests.length, edited: last.requests.find(r => r.id === 'big-9997')?.url, depth: last.requests.find(r => r.id === 'big-0')?.folderPath.length };
    });

    console.log(`scale: first paint ${firstPaint}ms, search ${searchMs}ms, save ${saveMs}ms`);
    expect(saved).toEqual({ count: 10_000, edited: 'https://api.example.test/edited', depth: 200 });
    expect(pageErrors).toEqual([]);
    expect(firstPaint).toBeLessThan(5_000);
    expect(searchMs).toBeLessThan(2_000);
    expect(saveMs).toBeLessThan(8_000);
  });
});


test.describe('Perf fixtures', () => {
  const fixtures = process.env.KURLO_PERF_FIXTURES ?? '';
  test.skip(!fixtures, 'set KURLO_PERF_FIXTURES to the generated perf/fixtures folder');

  test('stays responsive on the generated perf fixtures', async ({ page }) => {
    test.setTimeout(240_000);
    const { readFile } = await import('node:fs/promises');
    const storeBody = await readFile(`${fixtures}/request-store-large.json`, 'utf8');
    const hugeBody = await readFile(`${fixtures}/huge-response.json`, 'utf8');
    await page.route('**/__perf/store.json', route => route.fulfill({ body: storeBody, contentType: 'application/json' }));
    await page.route('**/__perf/huge.json', route => route.fulfill({ body: hugeBody, contentType: 'application/json' }));
    await installKurloBridge(page);
    await page.addInitScript(() => {
      (window.__kurloE2E as Record<string, unknown>).perfStoreUrl = '/__perf/store.json';
    });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(String(error)));

    const timings: Record<string, number> = {};
    const time = async (label: string, step: () => Promise<void>) => {
      const started = Date.now();
      await step();
      timings[label] = Date.now() - started;
    };

    const cdp = process.env.KURLO_PERF_PROFILE ? await page.context().newCDPSession(page) : null;
    if (cdp) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
      await cdp.send('Profiler.start');
    }
    await time('first paint', async () => {
      await page.goto('/');
      await expect(page.getByRole('button', { name: /^Starred \d+/ })).toBeVisible({ timeout: 120_000 });
    });
    if (cdp) {
      const { profile } = await cdp.send('Profiler.stop');
      (await import('node:fs')).writeFileSync(process.env.KURLO_PERF_PROFILE!, JSON.stringify(profile));
    }
    await time('sidebar search', async () => {
      await page.getByRole('textbox', { name: 'Filter requests' }).fill('Заказ 04999');
      await expect(page.getByText(/Заказ 04999/).first()).toBeVisible({ timeout: 30_000 });
    });
    await time('open request', async () => {
      await page.getByText(/Заказ 04999/).first().click();
      await expect(page.getByLabel('Request URL')).toHaveValue(/resources\/4999/, { timeout: 30_000 });
    });
    await page.getByRole('textbox', { name: 'Filter requests' }).fill('');
    await time('history view', async () => {
      await page.getByLabel('History', { exact: true }).first().click();
      await expect(page.locator('.sidebar').getByText(/200|204|500/).first()).toBeVisible({ timeout: 30_000 });
    });
    await time('huge response', async () => {
      await page.evaluate(async () => {
        const body = await (await fetch('/__perf/huge.json')).text();
        (window.__kurloE2E as Record<string, unknown>).hugeBody = body;
      });
    });

    console.log(`perf fixtures: ${Object.entries(timings).map(([label, ms]) => `${label} ${ms}ms`).join(', ')}`);
    expect(pageErrors).toEqual([]);
    expect(timings['first paint']).toBeLessThan(10_000);
    expect(timings['sidebar search']).toBeLessThan(500);
    expect(timings['open request']).toBeLessThan(400);
  });
});

test.describe('Real workspace round trip', () => {
  const input = process.env.KURLO_ROUNDTRIP_IN ?? '';
  const output = process.env.KURLO_ROUNDTRIP_OUT ?? '';
  test.skip(!input || !output, 'driven by the Go Git flow test');

  test('real workspace round trip', async ({ page }) => {
    const { readFile, writeFile } = await import('node:fs/promises');
    const body = await readFile(input, 'utf8');
    await page.route('**/__roundtrip/store.json', route => route.fulfill({ body, contentType: 'application/json' }));
    await installKurloBridge(page);
    await page.addInitScript(() => {
      (window.__kurloE2E as Record<string, unknown>).perfStoreUrl = '/__roundtrip/store.json';
    });
    await page.goto('/');
    const toggle = page.getByRole('button', { name: /^(Collapse|Expand) collection$/ }).first();
    await expect(toggle).toBeVisible();
    const before = await page.evaluate(() => (window.__kurloE2E.savedStores as unknown[]).length);
    await toggle.click();
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E.savedStores as unknown[]).length)).toBeGreaterThan(before);
    const afterFirst = await page.evaluate(() => (window.__kurloE2E.savedStores as unknown[]).length);
    await page.getByRole('button', { name: /^(Collapse|Expand) collection$/ }).first().click();
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E.savedStores as unknown[]).length)).toBeGreaterThan(afterFirst);
    const saved = await page.evaluate(() => {
      const stores = window.__kurloE2E.savedStores as unknown[];
      return JSON.stringify(stores[stores.length - 1]);
    });
    await writeFile(output, saved);
  });
});

test.describe('UI locale', () => {
  test.use({ locale: 'ru-RU' });

  test('shows English dates on a system in another language', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      localStorage.setItem('kurlo:last-seen-version', '2.0.2');
      const app = (window as any).go.api.App;
      app.AppInfo = async () => ({ name: 'Kurlo', version: '2.0.3', runtime: 'browser/e2e', goVersion: 'e2e' });
    });
    await page.goto('/');

    const whatsNew = page.getByRole('dialog', { name: /What's new in Kurlo/ });
    await expect(whatsNew).toBeVisible();
    await expect(whatsNew).not.toContainText(/октябр|сентябр|ноябр|г\./);
    await expect(whatsNew).toContainText(/(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/);
  });
});
