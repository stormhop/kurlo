import { openFileDialog, readTextFile, saveFileDialog, saveResponseBody } from '../../backend';
import { emptyHttpResponse } from '../../wire';
import type { HttpResponse, ScriptResult } from '../../backend';
import { countMatchesAsync, shouldVirtualizeResponseBody } from '../../response-render';
import { diffResponseBodies, type ResponseDiff } from '../../responseDiff';
import type { GrpcResponse, RequestExample, RequestType, ResponseTab } from '../../types/models';
import { responseFromExample } from '../../examples';
import { clamp, clipboardCopy, formatSize, prettyJson, prettyMarkup } from '../../utils';

const RESPONSE_PAGE_CHARS = 512 * 1024;
const LARGE_RESPONSE_BYTES = 10 * 1024 * 1024;
const responseDisplayCache = new WeakMap<HttpResponse, {
  body: string;
  page: number;
  paged: boolean;
  value: string;
}>();

type ResponseHost = {
  _responseSearchCountKey: string;
  _responseSearchCountSource: string;
  _responseSearchCountTimer: number | undefined;
  _responseSearchCountToken: number;
  copiedBody: boolean;
  grpcResponse: GrpcResponse | null;
  requestError: string;
  requestType: RequestType;
  response: HttpResponse | null;
  responseBodyIsPaged: boolean;
  responseBodyVirtualized: boolean;
  responseBodyPage: number;
  responseBodyPageCount: number;
  responseDisplayBody: string;
  responseRenderMode: 'json' | 'html' | 'text';
  responseSearch: string;
  responseSearchCounting: boolean;
  responseSearchIndex: number;
  responseSearchOpen: boolean;
  responseSearchTotal: number;
  responseTab: ResponseTab;
  responseTabs: Map<string, ResponseTab>;
  responses: Map<string, HttpResponse>;
  previousResponses: Map<string, HttpResponse>;
  savedResponse: boolean;
  safeResponseSearchIndex: number;
  activeRequestId: string;
  clampResponseSearchIndex: () => void;
  copyGrpcResponseBody: () => Promise<void>;
  copyResponseBody: () => Promise<void>;
  formatResponseBody: (resp: HttpResponse | null) => string;
  isHtmlResponse: (resp?: HttpResponse | null) => boolean;
  isJsonResponse: (resp?: HttpResponse | null) => boolean;
  nextResponseMatch: () => void;
  prevResponseMatch: () => void;
  responseFullBody: (resp?: HttpResponse | null) => string;
  responseRawBody: (resp?: HttpResponse | null) => string;
  scrollCurrentSearchMatch: () => void;
  setActiveResponse: (response: HttpResponse | null, requestId?: string) => void;
  setActiveResponseTab: (tab: ResponseTab, requestId?: string) => void;
  previousResponse: (requestId?: string) => HttpResponse | null;
  requestExamples: RequestExample[];
  diffBaselineExampleIds: Map<string, string>;
  diffBaselineExampleId: (requestId?: string) => string;
  setDiffBaselineExample: (exampleId: string, requestId?: string) => void;
  diffBaselineResponse: () => HttpResponse | null;
  diffBaselineLabel: () => string;
  diffBaselineOptions: () => Array<{ id: string; label: string }>;
  responseDiff: () => ResponseDiff | null;
  clearResponseDiffBaseline: (requestId?: string) => void;
  setResponseBodyPage: (page: number) => void;
  testSummary: (result?: ScriptResult | null) => { passed: number; total: number; allPassed: boolean } | null;
};

export const responseFeature = {
  get responseTestSummary() {
    const host = this as unknown as ResponseHost;
    return host.testSummary(host.response?.testResult);
  },

  get grpcResponseTestSummary() {
    const host = this as unknown as ResponseHost;
    return host.testSummary(host.grpcResponse?.testResult);
  },

  get responseDisplayBody(): string {
    const host = this as unknown as ResponseHost;
    return host.formatResponseBody(host.response);
  },

  get responseBodyIsPaged(): boolean {
    const host = this as unknown as ResponseHost;
    return Boolean(host.response && host.response.size > LARGE_RESPONSE_BYTES);
  },

  get responseBodyVirtualized(): boolean {
    const host = this as unknown as ResponseHost;
    return shouldVirtualizeResponseBody(host.responseDisplayBody, host.responseRenderMode);
  },

  get responseBodyPageCount(): number {
    const host = this as unknown as ResponseHost;
    if (!host.responseBodyIsPaged) return 1;
    return Math.max(1, Math.ceil(host.responseFullBody().length / RESPONSE_PAGE_CHARS));
  },

  get responseBodyPageLabel(): string {
    const host = this as unknown as ResponseHost;
    if (!host.responseBodyIsPaged) return '';
    const start = host.responseBodyPage * RESPONSE_PAGE_CHARS + 1;
    const total = host.responseFullBody().length;
    const end = Math.min(total, (host.responseBodyPage + 1) * RESPONSE_PAGE_CHARS);
    return `${formatSize(start - 1)}-${formatSize(end)} of ${formatSize(total)}`;
  },

  get responseRenderMode(): 'json' | 'html' | 'text' {
    const host = this as unknown as ResponseHost;
    if (host.responseBodyIsPaged) return 'text';
    if (host.isJsonResponse()) return 'json';
    if (host.isHtmlResponse()) return 'html';
    return 'text';
  },

  get safeResponseSearchIndex(): number {
    const host = this as unknown as ResponseHost;
    const total = host.responseSearchTotal;
    if (!total) return 0;
    if (host.responseSearchIndex < 0) return 0;
    if (host.responseSearchIndex >= total) return total - 1;
    return host.responseSearchIndex;
  },

  isJsonResponse(this: ResponseHost, resp: HttpResponse | null = this.response) {
    const ct = resp?.headers?.find(h => h.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
    return ct.includes('json');
  },

  isHtmlResponse(this: ResponseHost, resp: HttpResponse | null = this.response) {
    const ct = resp?.headers?.find(h => h.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
    return ct.includes('html');
  },

  isEventStreamResponse(this: ResponseHost, resp: HttpResponse | null = this.response) {
    const ct = resp?.headers?.find(h => h.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
    return ct.includes('text/event-stream');
  },

  responseFullBody(this: ResponseHost, resp: HttpResponse | null = this.response) {
    if (!resp?.body) return '';
    return resp.body;
  },

  responseRawBody(this: ResponseHost, resp: HttpResponse | null = this.response) {
    const body = this.responseFullBody(resp);
    if (!body) return '';
    if (this.responseBodyIsPaged) {
      const start = this.responseBodyPage * RESPONSE_PAGE_CHARS;
      return body.slice(start, start + RESPONSE_PAGE_CHARS);
    }
    return body;
  },

  formatResponseBody(this: ResponseHost, resp: HttpResponse | null) {
    if (!resp?.body) return '';
    const paged = resp === this.response
      ? this.responseBodyIsPaged
      : resp.size > LARGE_RESPONSE_BYTES;
    const page = paged ? this.responseBodyPage : 0;
    const cached = responseDisplayCache.get(resp);
    if (cached && cached.body === resp.body && cached.page === page && cached.paged === paged) {
      return cached.value;
    }
    const value = paged
      ? resp.body.slice(page * RESPONSE_PAGE_CHARS, (page + 1) * RESPONSE_PAGE_CHARS)
      : this.isJsonResponse(resp)
        ? prettyJson(resp.body)
        : this.isHtmlResponse(resp)
          ? prettyMarkup(resp.body)
          : resp.body;
    responseDisplayCache.set(resp, { body: resp.body, page, paged, value });
    return value;
  },

  testSummary(this: ResponseHost, result?: ScriptResult | null) {
    if (!result?.tests?.length) return null;
    const passed = result.tests.filter(t => t.passed).length;
    return { passed, total: result.tests.length, allPassed: passed === result.tests.length };
  },

  setActiveResponse(this: ResponseHost, response: HttpResponse | null, requestId = this.activeRequestId) {
    const replaced = requestId ? this.responses.get(requestId) : null;
    this.response = response;
    if (!requestId) return;
    const next = new Map(this.responses);
    if (response) next.set(requestId, response);
    else next.delete(requestId);
    this.responses = next;

    const previous = new Map(this.previousResponses);
    if (response && replaced && replaced !== response) previous.set(requestId, replaced);
    else if (!response) previous.delete(requestId);
    this.previousResponses = previous;
  },

  previousResponse(this: ResponseHost, requestId = this.activeRequestId): HttpResponse | null {
    return (requestId && this.previousResponses.get(requestId)) || null;
  },

  diffBaselineExampleId(this: ResponseHost, requestId = this.activeRequestId): string {
    const chosen = requestId ? this.diffBaselineExampleIds.get(requestId) : '';
    if (!chosen) return '';
    return this.requestExamples.some(example => example.id === chosen) ? chosen : '';
  },

  setDiffBaselineExample(this: ResponseHost, exampleId: string, requestId = this.activeRequestId) {
    if (!requestId) return;
    const next = new Map(this.diffBaselineExampleIds);
    if (exampleId) next.set(requestId, exampleId);
    else next.delete(requestId);
    this.diffBaselineExampleIds = next;
  },

  diffBaselineResponse(this: ResponseHost): HttpResponse | null {
    const exampleId = this.diffBaselineExampleId();
    if (exampleId) {
      const example = this.requestExamples.find(item => item.id === exampleId);
      return example ? responseFromExample(example) : null;
    }
    return this.previousResponse();
  },

  diffBaselineLabel(this: ResponseHost): string {
    const exampleId = this.diffBaselineExampleId();
    if (!exampleId) return 'previous';
    return this.requestExamples.find(item => item.id === exampleId)?.name ?? 'example';
  },

  diffBaselineOptions(this: ResponseHost) {
    return [
      ...(this.previousResponse() ? [{ id: '', label: 'Previous response' }] : []),
      ...this.requestExamples.map(example => ({ id: example.id, label: example.name })),
    ];
  },

  responseDiff(this: ResponseHost) {
    const baseline = this.diffBaselineResponse();
    if (!baseline || !this.response) return null;
    return diffResponseBodies(this.responseFullBody(baseline), this.responseFullBody(this.response));
  },

  clearResponseDiffBaseline(this: ResponseHost, requestId = this.activeRequestId) {
    if (!requestId) return;
    if (this.diffBaselineExampleId(requestId)) {
      this.setDiffBaselineExample('', requestId);
      if (this.previousResponse(requestId)) return;
    } else {
      const previous = new Map(this.previousResponses);
      previous.delete(requestId);
      this.previousResponses = previous;
    }
    if (this.responseTab === 'diff' && !this.diffBaselineResponse()) this.setActiveResponseTab('body');
  },

  setActiveResponseTab(this: ResponseHost, tab: ResponseTab, requestId = this.activeRequestId) {
    this.responseTab = tab;
    if (!requestId) return;
    const next = new Map(this.responseTabs);
    next.set(requestId, tab);
    this.responseTabs = next;
  },

  toggleResponseSearch(this: ResponseHost) {
    this.responseSearchOpen = !this.responseSearchOpen;
  },

  scheduleResponseSearchCount(this: ResponseHost) {
    const query = this.responseSearch.trim();
    const key = [
      this.response?.statusCode ?? 0,
      this.response?.size ?? 0,
      this.response?.duration ?? 0,
      this.responseBodyPage,
      this.responseRenderMode,
      query,
    ].join('|');
    const source = query && this.response ? this.responseDisplayBody : '';
    if (key === this._responseSearchCountKey && source === this._responseSearchCountSource) return;
    this._responseSearchCountKey = key;
    this._responseSearchCountSource = source;
    this._responseSearchCountToken += 1;
    if (this._responseSearchCountTimer !== undefined) {
      window.clearTimeout(this._responseSearchCountTimer);
      this._responseSearchCountTimer = undefined;
    }
    if (!query || !this.response) {
      this.responseSearchTotal = 0;
      this.responseSearchCounting = false;
      return;
    }
    const token = this._responseSearchCountToken;
    this.responseSearchCounting = true;
    this._responseSearchCountTimer = window.setTimeout(() => {
      this._responseSearchCountTimer = undefined;
      void countMatchesAsync(source, query, {
        shouldContinue: () => token === this._responseSearchCountToken,
      }).then((count) => {
        if (token !== this._responseSearchCountToken) return;
        this.responseSearchTotal = count;
        this.responseSearchCounting = false;
        this.clampResponseSearchIndex();
      });
    }, 0);
  },

  scrollCurrentSearchMatch(this: ResponseHost) {
    setTimeout(() => {
      document.querySelector('.rsp-search-current')?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }, 0);
  },

  nextResponseMatch(this: ResponseHost) {
    if (!this.responseSearchTotal) return;
    this.responseSearchIndex = (this.safeResponseSearchIndex + 1) % this.responseSearchTotal;
    this.scrollCurrentSearchMatch();
  },

  prevResponseMatch(this: ResponseHost) {
    if (!this.responseSearchTotal) return;
    this.responseSearchIndex = (this.safeResponseSearchIndex - 1 + this.responseSearchTotal) % this.responseSearchTotal;
    this.scrollCurrentSearchMatch();
  },

  setResponseBodyPage(this: ResponseHost, page: number) {
    this.responseBodyPage = clamp(page, 0, this.responseBodyPageCount - 1);
    this.responseSearchIndex = 0;
  },

  previousResponseBodyPage(this: ResponseHost) {
    this.setResponseBodyPage(this.responseBodyPage - 1);
  },

  nextResponseBodyPage(this: ResponseHost) {
    this.setResponseBodyPage(this.responseBodyPage + 1);
  },

  onResponseSearchKeydown(this: ResponseHost, e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) this.prevResponseMatch();
      else this.nextResponseMatch();
    }
    if (e.key === 'Escape') this.responseSearchOpen = false;
  },

  clampResponseSearchIndex(this: ResponseHost) {
    if (!this.responseSearch || this.responseSearchTotal === 0) {
      if (this.responseSearchIndex !== 0) this.responseSearchIndex = 0;
    } else if (this.responseSearchIndex >= this.responseSearchTotal) {
      this.responseSearchIndex = this.responseSearchTotal - 1;
    }
  },

  async copyResponseBody(this: ResponseHost) {
    if (!this.response) return;
    await clipboardCopy(this.response.error || this.response.body);
    this.copiedBody = true;
    setTimeout(() => (this.copiedBody = false), 2000);
  },

  async copyGrpcResponseBody(this: ResponseHost) {
    if (!this.grpcResponse) return;
    await clipboardCopy(this.grpcResponse.error || this.grpcResponse.body);
    this.copiedBody = true;
    setTimeout(() => (this.copiedBody = false), 2000);
  },

  async copyVisibleResponseOrError(this: ResponseHost) {
    if (this.requestError) {
      await clipboardCopy(this.requestError);
      this.copiedBody = true;
      setTimeout(() => (this.copiedBody = false), 2000);
      return;
    }
    if (this.requestType === 'grpc' && this.grpcResponse) {
      await this.copyGrpcResponseBody();
      return;
    }
    if (this.response) await this.copyResponseBody();
  },

  async saveResponseFile(this: ResponseHost) {
    if (!this.response) return;
    if (this.response.bodyIsBinary) {
      const result = await saveResponseBody(this.activeRequestId, 'response');
      if (result.error) this.requestError = result.error;
      if (result.savedPath) {
        this.savedResponse = true;
        setTimeout(() => (this.savedResponse = false), 1600);
      }
      return;
    }
    const ext = this.isJsonResponse() ? 'json' : this.isHtmlResponse() ? 'html' : 'txt';
    const path = await saveFileDialog(`response.${ext}`, this.response.body);
    if (path) {
      this.savedResponse = true;
      setTimeout(() => (this.savedResponse = false), 1600);
    }
  },

  async loadResponseFromFile(this: ResponseHost) {
    const path = await openFileDialog('Open response file');
    if (!path) return;
    const body = await readTextFile(path);
    const size = new TextEncoder().encode(body).length;
    const lower = path.toLowerCase();
    const head = body.trimStart();
    const contentType = lower.endsWith('.json') || head.startsWith('{') || head.startsWith('[')
      ? 'application/json'
      : lower.endsWith('.html') || lower.endsWith('.htm')
        ? 'text/html'
        : 'text/plain';
    const response: HttpResponse = {
      ...emptyHttpResponse(),
      statusCode: 200,
      status: '200 OK',
      headers: [{ key: 'Content-Type', value: contentType, enabled: true, isFile: false, fileName: '', contentType: '' }],
      body,
      duration: 0,
      size,
      preRequestResult: { tests: [] },
      testResult: { tests: [] },
    };
    this.requestError = '';
    this.responseSearchOpen = false;
    this.responseSearch = '';
    this.responseSearchIndex = 0;
    this.responseBodyPage = 0;
    this.setActiveResponse(response);
    this.setActiveResponseTab('body');
  },

  async saveGrpcResponseFile(this: ResponseHost) {
    if (!this.grpcResponse) return;
    const body = this.grpcResponse.body || this.grpcResponse.error || '';
    const trimmed = body.trim();
    const ext = trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'txt';
    const path = await saveFileDialog(`grpc-response.${ext}`, body);
    if (path) {
      this.savedResponse = true;
      setTimeout(() => (this.savedResponse = false), 1600);
    }
  },
};
