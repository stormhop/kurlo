import { cancelHttpRequest, getEnvironment, getGlobalVariables, openFileDialog, readTextFile, sendGrpcRequest, sendHttpRequest } from '../../backend';
import type { RunnableHttpOptions } from './requestSerialization';
import { clampConcurrency, DEFAULT_RUNNER_CONCURRENCY, forEachWithConcurrency } from '../../concurrency';
import type { GrpcRequest, HttpRequest, HttpResponse } from '../../backend';
import type { Collection, CollectionRunnerResult, GrpcResponse, RequestType, SavedRequest } from '../../types/models';
import type { RunnerDataRow } from '../../runnerData';
import { downloadTextFile, requestTabLabel, requestTransportLabel } from '../../utils';
import type { TopView } from '../ui';
import { collectionRunRecord, type CollectionRunRecord } from '../../collectionRuns';

const REQUEST_CANCELED_ERROR = 'Request canceled';

type CollectionRunnerHost = {
  collections: Collection[];
  requests: SavedRequest[];
  activeWorkspaceId: string;
  activeRequestId: string;
  topView: TopView;
  collectionImportToast: string;
  collectionRunnerOpen: boolean;
  collectionRunnerCollectionId: string;
  collectionRunnerSelectedRequestIds: Set<string>;
  collectionRunnerDelayMs: number;
  collectionRunnerIncludeTags: string;
  collectionRunnerExcludeTags: string;
  collectionRunnerIterations: number;
  collectionRunnerDataFileName: string;
  collectionRunnerDataRows: RunnerDataRow[];
  collectionRunnerDataError: string;
  collectionRunnerParallel: boolean;
  collectionRunnerConcurrency: number;
  collectionRunnerTitle: string;
  collectionRunnerRunning: boolean;
  collectionRunnerResults: CollectionRunnerResult[];
  collectionLastRuns: Record<string, CollectionRunRecord>;
  collectionRunnerShowingLastRun: boolean;
  persistRequestStore: () => Promise<unknown>;
  showCollectionLastRun: (collectionId: string) => void;
  collectionRunnerStartedAt: number;
  collectionRunnerFinishedAt: number;
  collectionRunnerCancelRequested: boolean;
  collectionRunnerActiveRequestId: string;
  collectionRunnerActiveRequestIds: Set<string>;
  collectionRunnerCollections: Collection[];
  collectionRunnerEffectiveCollectionId: string;
  collectionRunnerSelectableRequests: SavedRequest[];
  collectionRunnerSelectedRequests: SavedRequest[];
  collectionRunnerRunIterations: number;
  activeCollectionId: () => string;
  closeFloatingMenus: () => void;
  normalizeRequestTypeValue: (value: unknown, url?: string) => RequestType;
  savedRequestIsRunnerSkipped: (req: Pick<SavedRequest, 'requestType' | 'url' | 'method'>) => boolean;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  guardWorkspaceWritable: (action?: string) => boolean;
  folderPathMatches: (path?: string[], prefix?: string[]) => boolean;
  headerValidationErrorForRequest: (req: SavedRequest, envValues?: Record<string, string>) => string;
  savedRequestToRunnableHttpRequest: (req: SavedRequest, envValues?: Record<string, string>, secretValues?: string[], secretKeys?: string[], requestId?: string, options?: RunnableHttpOptions) => HttpRequest;
  savedRequestToRunnableGrpcRequest: (req: SavedRequest, envValues?: Record<string, string>, secretValues?: string[], secretKeys?: string[], requestId?: string) => GrpcRequest;
  activeEnvironmentValues: () => Record<string, string>;
  globalVariableValues: () => Record<string, string>;
  activeSecretEnvironmentValues: () => string[];
  activeSecretEnvironmentKeys: () => string[];
  syncBackendEnvironment: () => Promise<void>;
  syncBackendGlobals: () => Promise<void>;
  syncGlobalsFromBackend: () => Promise<boolean>;
  mergeActiveEnvironmentValues: (values: Record<string, string>) => Promise<boolean>;
  applyCollectionVariableUpdates: (
    req: Pick<SavedRequest, 'collectionId'>,
    updates: Record<string, string> | undefined,
    removed: string[] | undefined,
  ) => Promise<boolean>;
  refreshCookieJar: (silent?: boolean, persistAfterRefresh?: boolean) => Promise<void>;
  ensureValidOAuth2TokenForRequest: (req: SavedRequest) => Promise<void>;
  saveTextFile: (name: string, content: string) => Promise<boolean>;
  collectionRunnerDefaultCollectionId: () => string;
  collectionRunnerFilterTokens: (value: string) => string[];
  collectionRunnerRequestTags: (req: SavedRequest) => string[];
  ensureCollectionRunnerCollection: (collectionId?: string) => string;
  openCollectionRunner: (collectionId?: string, selectedRequestIds?: string[]) => void;
  closeCollectionRunnerTab: () => void;
  selectAllCollectionRunnerRequests: () => void;
  clearCollectionRunnerDataFile: () => void;
  stopCollectionRunner: () => void;
  startCollectionRunner: (title: string, requests: SavedRequest[], options?: { delayMs?: number; iterations?: number; parallel?: boolean; concurrency?: number; dataRows?: RunnerDataRow[]; collectionId?: string }) => Promise<void>;
  runnerResultShell: (req: SavedRequest, status?: CollectionRunnerResult['status'], runId?: string, iteration?: number) => CollectionRunnerResult;
  runnerResultFromResponse: (req: SavedRequest, resp: HttpResponse, runId: string, iteration: number) => CollectionRunnerResult;
  runnerResultFromGrpcResponse: (req: SavedRequest, resp: GrpcResponse, runId: string, iteration: number) => CollectionRunnerResult;
  buildCollectionRunnerSummary: () => { total: number; completed: number; passed: number; failed: number; skipped: number; testsPassed: number; testsTotal: number; duration: number; allPassed: boolean };
  updateCollectionRunnerResult: (runId: string, patch: Partial<CollectionRunnerResult>) => void;
  waitForCollectionRunnerDelay: (ms: number) => Promise<void>;
  executeCollectionRunnerRequest: (req: SavedRequest, runId: string, iteration: number, envValues: Record<string, string>, secretValues: string[], secretKeys: string[], dataRow?: RunnerDataRow, context?: RunnerRequestContext) => Promise<void>;
};

type RunnerRequestContext = { globals?: Record<string, string>; iterationCount?: number };

const runnerResultIndexes = new WeakMap<CollectionRunnerResult[], Map<string, number>>();

function runnerResultIndex(results: CollectionRunnerResult[], runId: string): number {
  let indexes = runnerResultIndexes.get(results);
  if (!indexes) {
    indexes = new Map(results.map((result, index) => [result.runId, index]));
    runnerResultIndexes.set(results, indexes);
  }
  const index = indexes.get(runId);
  if (index !== undefined && results[index]?.runId === runId) return index;
  return results.findIndex(result => result.runId === runId);
}

export const collectionRunnerFeature = {
  collectionRunnerDefaultCollectionId(this: CollectionRunnerHost) {
    return this.activeCollectionId() || this.collectionRunnerCollections[0]?.id || '';
  },
  collectionRunnerFilterTokens(this: CollectionRunnerHost, value: string) {
    return value.split(',').map(token => token.trim().toLowerCase()).filter(Boolean);
  },
  collectionRunnerRequestTags(this: CollectionRunnerHost, req: SavedRequest) {
    const tags = [
      ...req.folderPath,
      requestTransportLabel(req),
      this.normalizeRequestTypeValue(req.requestType, req.url),
    ];
    return [...new Set(tags.map(tag => tag.trim()).filter(Boolean))];
  },
  collectionRunnerRequestMatchesFilters(this: CollectionRunnerHost, req: SavedRequest) {
    const searchable = [
      requestTabLabel(req),
      req.url,
      req.collection,
      ...this.collectionRunnerRequestTags(req),
    ].join(' ').toLowerCase();
    const include = this.collectionRunnerFilterTokens(this.collectionRunnerIncludeTags);
    const exclude = this.collectionRunnerFilterTokens(this.collectionRunnerExcludeTags);
    return (!include.length || include.some(token => searchable.includes(token)))
      && (!exclude.length || exclude.every(token => !searchable.includes(token)));
  },
  ensureCollectionRunnerCollection(this: CollectionRunnerHost, collectionId = '') {
    const nextCollectionId = collectionId || this.collectionRunnerEffectiveCollectionId || this.collectionRunnerDefaultCollectionId();
    this.collectionRunnerCollectionId = nextCollectionId;
    return nextCollectionId;
  },
  openCollectionRunner(this: CollectionRunnerHost, collectionId = '', selectedRequestIds?: string[]) {
    this.closeFloatingMenus();
    const previousCollectionId = this.collectionRunnerCollectionId;
    const nextCollectionId = this.ensureCollectionRunnerCollection(collectionId);
    const collectionChanged = previousCollectionId !== nextCollectionId;
    this.collectionRunnerOpen = true;
    this.topView = 'runner';
    this.collectionRunnerTitle = this.collections.find(collection => collection.id === nextCollectionId)?.name || 'Collection Runner';
    if (!this.collectionRunnerRunning && (collectionChanged || !this.collectionRunnerResults.length)) this.showCollectionLastRun(nextCollectionId);
    if (selectedRequestIds) {
      const allowedIds = new Set(this.collectionRunnerSelectableRequests.map(request => request.id));
      this.collectionRunnerSelectedRequestIds = new Set(selectedRequestIds.filter(id => allowedIds.has(id)));
    } else if (collectionChanged || !this.collectionRunnerSelectedRequestIds.size) {
      this.selectAllCollectionRunnerRequests();
    }
  },
  closeCollectionRunnerTab(this: CollectionRunnerHost) {
    if (this.collectionRunnerRunning) this.stopCollectionRunner();
    this.collectionRunnerOpen = false;
    if (this.topView === 'runner') {
      if (this.activeRequestId) this.topView = 'request';
      else this.topView = 'overview';
    }
  },
  setCollectionRunnerCollection(this: CollectionRunnerHost, collectionId: string) {
    this.collectionRunnerCollectionId = collectionId;
    this.collectionRunnerTitle = this.collections.find(collection => collection.id === collectionId)?.name || 'Collection Runner';
    this.collectionRunnerSelectedRequestIds = new Set();
    this.showCollectionLastRun(collectionId);
    this.selectAllCollectionRunnerRequests();
  },
  showCollectionLastRun(this: CollectionRunnerHost, collectionId: string) {
    if (this.collectionRunnerRunning) return;
    const record = this.collectionLastRuns[collectionId];
    this.collectionRunnerResults = record ? record.results.map(result => ({ ...result })) : [];
    this.collectionRunnerStartedAt = record?.startedAt ?? 0;
    this.collectionRunnerFinishedAt = record?.finishedAt ?? 0;
    this.collectionRunnerShowingLastRun = Boolean(record);
  },
  setCollectionRunnerDelayMs(this: CollectionRunnerHost, value: string | number) {
    this.collectionRunnerDelayMs = Math.max(0, Math.floor(Number(value) || 0));
  },
  setCollectionRunnerIterations(this: CollectionRunnerHost, value: string | number) {
    this.collectionRunnerIterations = Math.max(1, Math.floor(Number(value) || 1));
  },
  async selectCollectionRunnerDataFile(this: CollectionRunnerHost) {
    const path = await openFileDialog('Select runner data file');
    if (!path) return;
    try {
      const text = await readTextFile(path);
      const { parseRunnerDataFile } = await import('../../runnerData');
      const rows = parseRunnerDataFile(text, path);
      const fileName = path.split(/[\\/]/).pop() || 'runner-data';
      this.collectionRunnerDataFileName = fileName;
      this.collectionRunnerDataRows = rows;
      this.collectionRunnerDataError = rows.length ? '' : 'Runner data file has no rows.';
      if (rows.length) this.collectionRunnerIterations = rows.length;
    } catch (error) {
      this.collectionRunnerDataRows = [];
      this.collectionRunnerDataFileName = '';
      this.collectionRunnerDataError = error instanceof Error ? error.message : String(error);
    }
  },
  clearCollectionRunnerDataFile(this: CollectionRunnerHost) {
    this.collectionRunnerDataFileName = '';
    this.collectionRunnerDataRows = [];
    this.collectionRunnerDataError = '';
  },
  setCollectionRunnerIncludeTags(this: CollectionRunnerHost, value: string) {
    this.collectionRunnerIncludeTags = value;
  },
  setCollectionRunnerExcludeTags(this: CollectionRunnerHost, value: string) {
    this.collectionRunnerExcludeTags = value;
  },
  setCollectionRunnerParallel(this: CollectionRunnerHost, value: boolean) {
    this.collectionRunnerParallel = value;
  },
  setCollectionRunnerConcurrency(this: CollectionRunnerHost, value: string | number) {
    this.collectionRunnerConcurrency = clampConcurrency(value);
  },
  selectAllCollectionRunnerRequests(this: CollectionRunnerHost) {
    this.collectionRunnerSelectedRequestIds = new Set(this.collectionRunnerSelectableRequests.map(request => request.id));
  },
  deselectAllCollectionRunnerRequests(this: CollectionRunnerHost) {
    this.collectionRunnerSelectedRequestIds = new Set();
  },
  toggleCollectionRunnerRequest(this: CollectionRunnerHost, requestId: string) {
    const next = new Set(this.collectionRunnerSelectedRequestIds);
    if (next.has(requestId)) next.delete(requestId);
    else next.add(requestId);
    this.collectionRunnerSelectedRequestIds = next;
  },
  resetCollectionRunner(this: CollectionRunnerHost) {
    this.collectionRunnerDelayMs = 0;
    this.collectionRunnerIncludeTags = '';
    this.collectionRunnerExcludeTags = '';
    this.collectionRunnerIterations = 1;
    this.clearCollectionRunnerDataFile();
    this.collectionRunnerParallel = false;
    this.collectionRunnerConcurrency = DEFAULT_RUNNER_CONCURRENCY;
    this.collectionRunnerResults = [];
    this.collectionRunnerShowingLastRun = false;
    this.selectAllCollectionRunnerRequests();
  },
  async startCollectionRunnerFromSelection(this: CollectionRunnerHost) {
    this.openCollectionRunner(this.collectionRunnerEffectiveCollectionId);
    await this.persistActiveRequestNow();
    await this.startCollectionRunner(
      this.collections.find(collection => collection.id === this.collectionRunnerEffectiveCollectionId)?.name || 'Collection Runner',
      this.collectionRunnerSelectedRequests,
      {
        delayMs: this.collectionRunnerDelayMs,
        iterations: this.collectionRunnerRunIterations,
        dataRows: this.collectionRunnerDataRows,
        parallel: this.collectionRunnerParallel,
        concurrency: this.collectionRunnerConcurrency,
        collectionId: this.collectionRunnerEffectiveCollectionId,
      },
    );
  },
  runnerResultShell(this: CollectionRunnerHost, req: SavedRequest, status: CollectionRunnerResult['status'] = 'queued', runId = req.id, iteration = 1): CollectionRunnerResult {
    return {
      runId,
      requestId: req.id,
      iteration,
      name: requestTabLabel(req),
      method: requestTransportLabel(req),
      url: req.url,
      status,
      statusCode: 0,
      duration: 0,
      testsPassed: 0,
      testsTotal: 0,
      error: '',
      tests: [],
    };
  },
  runnerResultFromResponse(this: CollectionRunnerHost, req: SavedRequest, resp: HttpResponse, runId: string, iteration: number): CollectionRunnerResult {
    const tests = resp.testResult?.tests ?? [];
    const testsPassed = tests.filter(test => test.passed).length;
    const testsTotal = tests.length;
    const scriptError = resp.preRequestResult?.error || resp.testResult?.error || '';
    const testFailed = testsTotal > 0 && testsPassed !== testsTotal;
    const error = resp.error || scriptError || (resp.statusCode >= 400 ? resp.status : '');
    if (resp.skipped) {
      return {
        ...this.runnerResultShell(req, 'skipped', runId, iteration),
        error: '',
      };
    }
    return {
      ...this.runnerResultShell(req, 'queued', runId, iteration),
      status: error || testFailed ? 'failed' : 'passed',
      statusCode: resp.statusCode,
      duration: resp.duration,
      testsPassed,
      testsTotal,
      error,
      tests: tests.map(test => ({ name: test.name, passed: test.passed, error: test.error })),
    };
  },
  runnerResultFromGrpcResponse(this: CollectionRunnerHost, req: SavedRequest, resp: GrpcResponse, runId: string, iteration: number): CollectionRunnerResult {
    const tests = resp.testResult?.tests ?? [];
    const testsPassed = tests.filter(test => test.passed).length;
    const testsTotal = tests.length;
    const scriptError = resp.preRequestResult?.error || resp.testResult?.error || '';
    const testFailed = testsTotal > 0 && testsPassed !== testsTotal;
    const grpcError = resp.grpcCode && resp.grpcCode !== 'OK' ? `gRPC ${resp.grpcCode}${resp.grpcMessage ? `: ${resp.grpcMessage}` : ''}` : '';
    const error = resp.error || scriptError || grpcError;
    return {
      ...this.runnerResultShell(req, 'queued', runId, iteration),
      status: error || testFailed ? 'failed' : 'passed',
      statusCode: resp.grpcCode === 'OK' ? 200 : 0,
      duration: resp.duration,
      testsPassed,
      testsTotal,
      error,
      tests: tests.map(test => ({ name: test.name, passed: test.passed, error: test.error })),
    };
  },
  buildCollectionRunnerSummary(this: CollectionRunnerHost) {
    const results = this.collectionRunnerResults;
    const completed = results.filter(result => ['passed', 'failed', 'error', 'skipped'].includes(result.status));
    const failed = results.filter(result => result.status === 'failed' || result.status === 'error').length;
    const passed = results.filter(result => result.status === 'passed').length;
    const skipped = results.filter(result => result.status === 'skipped').length;
    const testsTotal = results.reduce((sum, result) => sum + result.testsTotal, 0);
    const testsPassed = results.reduce((sum, result) => sum + result.testsPassed, 0);
    const duration = (this.collectionRunnerFinishedAt || Date.now()) - this.collectionRunnerStartedAt;
    return { total: results.length, completed: completed.length, passed, failed, skipped, testsPassed, testsTotal, duration: this.collectionRunnerStartedAt ? duration : 0, allPassed: results.length > 0 && results.every(result => result.status === 'passed') };
  },
  updateCollectionRunnerResult(this: CollectionRunnerHost, runId: string, patch: Partial<CollectionRunnerResult>) {
    const results = this.collectionRunnerResults;
    const index = runnerResultIndex(results, runId);
    if (index < 0) return;
    results[index] = { ...results[index], ...patch };
  },
  async downloadCollectionRunnerReport(this: CollectionRunnerHost) {
    if (!this.collectionRunnerResults.length) return;
    const generatedAt = new Date();
    const { buildCollectionRunnerReportHtml, collectionRunnerReportFileName } = await import('../../runnerReport');
    const html = buildCollectionRunnerReportHtml({
      title: this.collectionRunnerTitle || 'Collection Runner',
      generatedAt,
      summary: this.buildCollectionRunnerSummary(),
      results: this.collectionRunnerResults,
      iterations: this.collectionRunnerRunIterations,
      delayMs: this.collectionRunnerDelayMs,
      parallel: this.collectionRunnerParallel,
      concurrency: this.collectionRunnerConcurrency,
      includeTags: this.collectionRunnerIncludeTags,
      excludeTags: this.collectionRunnerExcludeTags,
      dataFileName: this.collectionRunnerDataFileName,
      dataRows: this.collectionRunnerDataRows,
    });
    const fileName = collectionRunnerReportFileName(this.collectionRunnerTitle || 'collection-runner', generatedAt);
    try {
      if (!(await this.saveTextFile(fileName, html))) return;
      this.collectionImportToast = 'Downloaded runner report';
    } catch {
      downloadTextFile(fileName, html);
      this.collectionImportToast = 'Downloaded runner report';
    } finally {
      setTimeout(() => (this.collectionImportToast = ''), 2200);
    }
  },
  async runCollection(this: CollectionRunnerHost, collectionId: string) {
    if (!this.guardWorkspaceWritable('Running collections')) return;
    this.closeFloatingMenus();
    await this.persistActiveRequestNow();
    this.openCollectionRunner(collectionId);
  },
  async runFolder(this: CollectionRunnerHost, collectionId: string, folderPath: string[]) {
    if (!this.guardWorkspaceWritable('Running folders')) return;
    this.closeFloatingMenus();
    await this.persistActiveRequestNow();
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    if (!collection) return;
    const requests = this.requests.filter(request => !request.isDraft && request.collectionId === collectionId && this.folderPathMatches(request.folderPath ?? [], folderPath));
    this.openCollectionRunner(collectionId, requests.map(request => request.id));
    this.collectionRunnerTitle = `${collection.name} / ${folderPath.join(' / ')}`;
  },
  waitForCollectionRunnerDelay(this: CollectionRunnerHost, ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  },
  async executeCollectionRunnerRequest(
    this: CollectionRunnerHost,
    req: SavedRequest,
    runId: string,
    iteration: number,
    envValues: Record<string, string>,
    secretValues: string[],
    secretKeys: string[],
    dataRow: RunnerDataRow = {},
    context: RunnerRequestContext = {},
  ) {
    if (this.collectionRunnerCancelRequested) {
      this.updateCollectionRunnerResult(runId, { status: 'skipped' });
      return;
    }
    this.updateCollectionRunnerResult(runId, { status: 'running' });
    const runnerRequestId = `runner-${runId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.collectionRunnerActiveRequestId = runnerRequestId;
    this.collectionRunnerActiveRequestIds.add(runnerRequestId);
    try {
      try { await this.ensureValidOAuth2TokenForRequest(req); } catch {}
      const runnerEnvValues = { ...envValues, ...dataRow };
      if (this.normalizeRequestTypeValue(req.requestType, req.url) === 'grpc') {
        if (!(req.grpcMethod ?? '').trim()) {
          this.updateCollectionRunnerResult(runId, { status: 'error', error: 'Select a gRPC method before running this request' });
          return;
        }
        const resp = await sendGrpcRequest(this.savedRequestToRunnableGrpcRequest(req, runnerEnvValues, secretValues, secretKeys, runnerRequestId));
        if (this.collectionRunnerCancelRequested && resp.error === REQUEST_CANCELED_ERROR) {
          this.updateCollectionRunnerResult(runId, { status: 'skipped', error: '' });
        } else {
          this.updateCollectionRunnerResult(runId, this.runnerResultFromGrpcResponse(req, resp, runId, iteration));
          try {
            await this.applyCollectionVariableUpdates(req, resp.collectionVariableUpdates, resp.collectionVariablesRemoved);
          } catch {}
        }
      } else {
        const headerError = this.headerValidationErrorForRequest(req, runnerEnvValues);
        if (headerError) {
          this.updateCollectionRunnerResult(runId, { status: 'error', error: headerError });
          return;
        }
        const resp = await sendHttpRequest(this.savedRequestToRunnableHttpRequest(req, runnerEnvValues, secretValues, secretKeys, runnerRequestId, {
          deferTemplates: true,
          globals: context.globals,
          iterationData: Object.keys(dataRow).length ? { ...dataRow } : undefined,
          iteration,
          iterationCount: context.iterationCount,
        }));
        if (this.collectionRunnerCancelRequested && resp.error === REQUEST_CANCELED_ERROR) {
          this.updateCollectionRunnerResult(runId, { status: 'skipped', error: '' });
        } else {
          this.updateCollectionRunnerResult(runId, this.runnerResultFromResponse(req, resp, runId, iteration));
          try {
            await this.applyCollectionVariableUpdates(req, resp.collectionVariableUpdates, resp.collectionVariablesRemoved);
          } catch {}
        }
      }
    } catch (error) {
      this.updateCollectionRunnerResult(runId, { status: 'error', error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.collectionRunnerActiveRequestIds.delete(runnerRequestId);
      if (this.collectionRunnerActiveRequestId === runnerRequestId) this.collectionRunnerActiveRequestId = '';
    }
  },
  async startCollectionRunner(this: CollectionRunnerHost, title: string, requests: SavedRequest[], options: { delayMs?: number; iterations?: number; parallel?: boolean; concurrency?: number; dataRows?: RunnerDataRow[]; collectionId?: string } = {}) {
    if (this.collectionRunnerRunning) return;
    if (!requests.length) {
      this.collectionImportToast = 'No requests to run';
      setTimeout(() => (this.collectionImportToast = ''), 2200);
      return;
    }
    const runnableRequests = requests.filter(request => !this.savedRequestIsRunnerSkipped(request));
    const skippedRealtimeRequests = requests.filter(request => this.savedRequestIsRunnerSkipped(request));
    if (!runnableRequests.length) {
      this.collectionImportToast = 'No runnable requests to run. Realtime, MCP and AI requests are skipped.';
      setTimeout(() => (this.collectionImportToast = ''), 3200);
      return;
    }
    const dataRows = options.dataRows ?? [];
    const iterations = Math.max(1, dataRows.length || Math.floor(Number(options.iterations) || 1));
    const delayMs = Math.max(0, Math.floor(Number(options.delayMs) || 0));
    const runs = Array.from({ length: iterations }, (_, iterationIndex) => runnableRequests.map((request, requestIndex) => ({
      request,
      iteration: iterationIndex + 1,
      runId: `${request.id}:${iterationIndex + 1}:${requestIndex}`,
    }))).flat();
    this.collectionRunnerOpen = true;
    this.topView = 'runner';
    this.collectionRunnerTitle = title;
    this.collectionRunnerResults = runs.map(run => this.runnerResultShell(run.request, 'queued', run.runId, run.iteration));
    this.collectionRunnerStartedAt = Date.now();
    this.collectionRunnerFinishedAt = 0;
    this.collectionRunnerShowingLastRun = false;
    this.collectionRunnerRunning = true;
    this.collectionRunnerCancelRequested = false;
    this.collectionRunnerActiveRequestId = '';
    this.collectionRunnerActiveRequestIds = new Set();
    let envValues = this.activeEnvironmentValues();
    let globals = this.globalVariableValues();
    const secretValues = this.activeSecretEnvironmentValues();
    const secretKeys = this.activeSecretEnvironmentKeys();
    try { await this.syncBackendEnvironment(); } catch {}
    try { await this.syncBackendGlobals(); } catch {}
    if (skippedRealtimeRequests.length) {
      this.collectionImportToast = `Skipped ${skippedRealtimeRequests.length} realtime request${skippedRealtimeRequests.length === 1 ? '' : 's'}`;
      setTimeout(() => (this.collectionImportToast = ''), 3200);
    }
    if (options.parallel) {
      const concurrency = clampConcurrency(options.concurrency ?? this.collectionRunnerConcurrency);
      for (let iteration = 1; iteration <= iterations; iteration += 1) {
        const batch = runs.filter(run => run.iteration === iteration);
        if (this.collectionRunnerCancelRequested) {
          for (const run of batch) this.updateCollectionRunnerResult(run.runId, { status: 'skipped' });
          continue;
        }
        await forEachWithConcurrency(batch, concurrency, run =>
          this.executeCollectionRunnerRequest(run.request, run.runId, run.iteration, envValues, secretValues, secretKeys, dataRows[run.iteration - 1] ?? {}, { globals, iterationCount: iterations }));
        try { envValues = await getEnvironment(); } catch {}
        try { globals = await getGlobalVariables(); } catch {}
        if (delayMs > 0 && iteration < iterations && !this.collectionRunnerCancelRequested) {
          await this.waitForCollectionRunnerDelay(delayMs);
        }
      }
    } else {
      for (let index = 0; index < runs.length; index += 1) {
        const run = runs[index];
        if (this.collectionRunnerCancelRequested) {
          this.updateCollectionRunnerResult(run.runId, { status: 'skipped' });
          continue;
        }
        if (delayMs > 0 && index > 0) {
          await this.waitForCollectionRunnerDelay(delayMs);
          if (this.collectionRunnerCancelRequested) {
            this.updateCollectionRunnerResult(run.runId, { status: 'skipped' });
            continue;
          }
        }
        await this.executeCollectionRunnerRequest(run.request, run.runId, run.iteration, envValues, secretValues, secretKeys, dataRows[run.iteration - 1] ?? {}, { globals, iterationCount: iterations });
        try { envValues = await getEnvironment(); } catch {}
        try { globals = await getGlobalVariables(); } catch {}
      }
    }
    try { await this.mergeActiveEnvironmentValues(envValues); } catch {}
    try { await this.syncGlobalsFromBackend(); } catch {}
    this.collectionRunnerFinishedAt = Date.now();
    this.collectionRunnerRunning = false;
    void this.refreshCookieJar(true, true);
    const record = options.collectionId
      ? collectionRunRecord(options.collectionId, title, this.collectionRunnerStartedAt, this.collectionRunnerFinishedAt, this.collectionRunnerResults)
      : null;
    if (record) {
      this.collectionLastRuns = { ...this.collectionLastRuns, [record.collectionId]: record };
      try { await this.persistRequestStore(); } catch {}
    }
  },
  stopCollectionRunner(this: CollectionRunnerHost) {
    this.collectionRunnerCancelRequested = true;
    for (const requestId of this.collectionRunnerActiveRequestIds) void cancelHttpRequest(requestId);
    if (this.collectionRunnerActiveRequestId) void cancelHttpRequest(this.collectionRunnerActiveRequestId);
  },
  closeCollectionRunner(this: CollectionRunnerHost) {
    this.closeCollectionRunnerTab();
  },
};
