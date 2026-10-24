import { openFileDialog } from '../../backend';
import { bodyPlaceholder, type BodyEditorLang } from '../../bodyTemplates';
import { mkRow } from '../../constants';
import type { ParsedCurl } from '../../curl';
import {
  DEFAULT_GRAPHQL_QUERY,
  DEFAULT_GRAPHQL_VARIABLES,
} from '../../graphql';
import { stripJsonComments } from '../../jsonEditing';
import { paramsFromUrl, urlWithParams } from '../../queryParams';
import { pathParamsFromUrl } from '../../pathParams';
import { DEFAULT_GRPC_MESSAGE, requestBodyDefaultsFor } from '../../requestBodyDefaults';
import type { BodyMode, BodyType, KVRow, Method, RawBodyType, RequestTab, RequestType, SavedRequest } from '../../types/models';
import {
  activeCount,
  byteLength,
  guardTrailing,
  normalizeBodyTypeForUi,
  normalizeRawBodyTypeForUi,
} from '../../utils';

const RAW_BODY_TYPES: RawBodyType[] = ['text', 'json', 'html', 'xml'];

type RequestBodyHost = {
  apiKeyValue: string;
  authType: SavedRequest['auth']['type'];
  awsAccessKey: string;
  awsSecretKey: string;
  oauth1: import('../../utils').OAuth1Fields;
  basicPass: string;
  basicUser: string;
  bearerToken: string;
  beautifiedBody: boolean;
  bodyContent: string;
  bodyEditorFormat: (() => boolean | void) | null;
  bodyFileName: string;
  bodyFilePath: string;
  bodyType: BodyType;
  curlPasteToast: boolean;
  followRedirects: boolean;
  formRows: KVRow[];
  graphqlOperationName: string;
  graphqlQuery: string;
  graphqlSchema: string;
  graphqlSchemaError: string;
  graphqlSchemaStatus: string;
  graphqlVariables: string;
  method: Method;
  params: KVRow[];
  pathParams: KVRow[];
  oauth2Token: string;
  enableSSLVerification: boolean;
  timeoutMs: number;
  proxyUrl: string;
  openFormTypeMenuId: number | null;
  rawBodyType: RawBodyType;
  rawTypeMenuOpen: boolean;
  reqHeaders: KVRow[];
  requestTab: RequestTab;
  requestType: RequestType;
  url: string;
  applyParsedCurl: (parsed: ParsedCurl) => void;
  bodyMode: () => BodyMode;
  graphQLBodyContentForStore: () => string;
  graphQLBodyForSend: (payload?: { query: string; variables: string; operationName: string }) => string;
  graphQLPayloadHasContent: (source: string) => boolean;
  importCookieHeaderForUrl?: (url: string, cookieHeader: string) => Promise<void>;
  requestBodyForSend: () => string;
  requestBodyPlaceholder: () => string;
  rawTypeLabel: (type?: RawBodyType) => string;
  resetBodyState: () => void;
  resolveTemplate: (value: string, values?: Record<string, string>) => string;
  setResponseBodyPage?: (page: number) => void;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
  environmentValuesForRequest: (req: Pick<SavedRequest, 'collectionId'>, envValues?: Record<string, string>) => Record<string, string>;
  stripBodyComments: (source: string, type: BodyType) => string;
  webSocketMessageBodyType: () => RawBodyType | 'binary';
  webSocketMessageTypeLabel: (type?: RawBodyType | 'binary') => string;
};

export const requestBodyFeature = {
  get bodyLang(): 'json' | 'text' | 'xml' | 'html' | 'graphql' {
    const host = this as unknown as RequestBodyHost;
    if (host.requestType === 'graphql') return 'graphql';
    if (host.requestType === 'grpc') return 'json';
    if (host.requestType === 'ws' || host.requestType === 'socketio') return host.bodyType === 'binary' ? 'text' : host.rawBodyType;
    return host.bodyType === 'json' ? 'json' : host.bodyType === 'xml' ? 'xml' : host.bodyType === 'html' ? 'html' : 'text';
  },

  bodyMode(this: RequestBodyHost): BodyMode {
    if ((RAW_BODY_TYPES as string[]).includes(this.bodyType)) return 'raw';
    if (this.bodyType === 'form') return 'form';
    if (this.bodyType === 'urlencoded') return 'urlencoded';
    if (this.bodyType === 'binary') return 'binary';
    if (this.bodyType === 'graphql') return 'graphql';
    return 'none';
  },

  setBodyMode(this: RequestBodyHost, mode: BodyMode) {
    this.bodyType = mode === 'raw' ? this.rawBodyType : mode === 'none' ? 'none' : mode as BodyType;
  },

  setRawBodyType(this: RequestBodyHost, type: RawBodyType) {
    this.rawBodyType = type;
    this.bodyType = type;
    this.rawTypeMenuOpen = false;
  },

  bodyModeIs(this: RequestBodyHost, mode: BodyMode) {
    return this.bodyMode() === mode;
  },

  rawTypeLabel(this: RequestBodyHost, type: RawBodyType = this.rawBodyType) {
    const labels: Record<RawBodyType, string> = { text: 'Text', json: 'JSON', html: 'HTML', xml: 'XML' };
    return labels[type];
  },

  webSocketMessageBodyType(this: RequestBodyHost): RawBodyType | 'binary' {
    return this.bodyType === 'binary' ? 'binary' : this.rawBodyType;
  },

  webSocketMessageTypeLabel(this: RequestBodyHost, type: RawBodyType | 'binary' = this.webSocketMessageBodyType()) {
    return type === 'binary' ? 'Binary' : this.rawTypeLabel(type);
  },

  setWebSocketMessageBodyType(this: RequestBodyHost, type: RawBodyType | 'binary') {
    if (type === 'binary') {
      this.bodyType = 'binary';
      this.rawBodyType = 'text';
      return;
    }
    this.bodyType = 'text';
    this.rawBodyType = type;
  },

  requestBodyPlaceholder(this: RequestBodyHost) {
    if (this.bodyType === 'graphql') return bodyPlaceholder('json', 'body');
    if ((RAW_BODY_TYPES as string[]).includes(this.bodyType)) return bodyPlaceholder(this.bodyType as BodyEditorLang, 'body');
    return bodyPlaceholder('text', 'body');
  },

  webSocketMessagePlaceholder(this: RequestBodyHost) {
    if (this.bodyType === 'binary') return bodyPlaceholder('text', 'binary');
    return bodyPlaceholder(this.rawBodyType as BodyEditorLang, 'message');
  },

  bodyHasContent(this: RequestBodyHost) {
    if (this.requestType === 'grpc') return Boolean(this.bodyContent.trim() && this.bodyContent.trim() !== DEFAULT_GRPC_MESSAGE);
    if (this.requestType === 'graphql') return this.graphQLPayloadHasContent(this.graphQLBodyContentForStore());
    if (this.requestType === 'ws') return Boolean(this.bodyContent.trim());
    if ((RAW_BODY_TYPES as string[]).includes(this.bodyType) || this.bodyType === 'graphql') return Boolean(this.bodyContent.trim());
    if (this.bodyType === 'form' || this.bodyType === 'urlencoded') return activeCount(this.formRows) > 0;
    if (this.bodyType === 'binary') return Boolean(this.bodyFilePath);
    return false;
  },

  bodyBadgeLabel(this: RequestBodyHost) {
    if (this.requestType === 'ws') return this.webSocketMessageTypeLabel().toLowerCase();
    if (this.requestType === 'grpc') return 'json';
    if (this.requestType === 'graphql') return 'query';
    const mode = this.bodyMode();
    return mode === 'urlencoded' ? 'url' : mode;
  },

  resetBodyState(this: RequestBodyHost) {
    const bodyDefaults = requestBodyDefaultsFor('http');
    this.bodyType = bodyDefaults.bodyType;
    this.rawBodyType = bodyDefaults.rawBodyType;
    this.bodyContent = bodyDefaults.bodyContent;
    this.graphqlQuery = DEFAULT_GRAPHQL_QUERY;
    this.graphqlVariables = DEFAULT_GRAPHQL_VARIABLES;
    this.graphqlOperationName = '';
    this.graphqlSchema = '';
    this.graphqlSchemaStatus = '';
    this.graphqlSchemaError = '';
    this.bodyFilePath = bodyDefaults.bodyFilePath;
    this.bodyFileName = bodyDefaults.bodyFileName;
    this.formRows = [mkRow()];
    this.openFormTypeMenuId = null;
  },

  setFormRowKind(this: RequestBodyHost, row: KVRow, kind: 'text' | 'file', idx: number) {
    row.isFile = kind === 'file';
    row.value = '';
    row.fileName = undefined;
    this.openFormTypeMenuId = null;
    guardTrailing(this.formRows, idx);
  },

  markBodyFormatted(this: RequestBodyHost) {
    this.beautifiedBody = true;
    setTimeout(() => (this.beautifiedBody = false), 1200);
  },

  registerBodyEditorFormat(this: RequestBodyHost, fn: (() => boolean | void) | null) {
    this.bodyEditorFormat = fn;
  },

  beautifyBody(this: RequestBodyHost) {
    this.bodyEditorFormat?.();
  },

  stripBodyComments(this: RequestBodyHost, source: string, type: BodyType): string {
    if (type === 'json') return stripJsonComments(source);
    if (type === 'html' || type === 'xml' || type === 'graphql') {
      return source.replace(/<!--[\s\S]*?-->/g, '').split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n');
    }
    return source.split('\n').filter(l => !l.trimStart().startsWith('#') && !l.trimStart().startsWith('//')).join('\n');
  },

  requestBodyForSend(this: RequestBodyHost) {
    if (this.requestType === 'graphql') return this.graphQLBodyForSend();
    if (!(RAW_BODY_TYPES as string[]).includes(this.bodyType) && this.bodyType !== 'graphql') return this.bodyContent;
    return this.bodyContent;
  },

  bodyContentType(this: RequestBodyHost) {
    switch (this.bodyType) {
      case 'json': return 'application/json';
      case 'text': return 'text/plain';
      case 'xml': return 'application/xml';
      case 'html': return 'text/html';
      case 'urlencoded': return 'application/x-www-form-urlencoded';
      case 'form': return 'multipart/form-data; boundary=<generated>';
      case 'binary': return this.bodyFilePath ? 'application/octet-stream' : '';
      case 'graphql': return 'application/json';
      default: return '';
    }
  },

  bodyLengthLabel(this: RequestBodyHost): string {
    const values = this.environmentValuesForRequest(this.snapshotActiveRequest());
    switch (this.bodyType) {
      case 'graphql': {
        try {
          const s = this.graphQLBodyForSend({
            query: this.resolveTemplate(this.graphqlQuery, values),
            variables: this.resolveTemplate(this.graphqlVariables, values),
            operationName: this.resolveTemplate(this.graphqlOperationName, values),
          });
          return String(byteLength(s));
        } catch {
          return '';
        }
      }
      case 'json':
      case 'text':
      case 'xml':
      case 'html': {
        const s = this.resolveTemplate(this.stripBodyComments(this.bodyContent, this.bodyType), values);
        return s ? String(byteLength(s)) : '';
      }
      case 'urlencoded':
        return String(byteLength(new URLSearchParams(this.formRows.filter(r => r.enabled && r.key).map(r => [this.resolveTemplate(r.key, values), this.resolveTemplate(r.value, values)] as [string, string])).toString()));
      case 'form':
        return this.formRows.some(r => r.enabled && r.key) ? '<calculated when sent>' : '';
      case 'binary':
        return this.bodyFilePath ? '<calculated from file>' : '';
      default:
        return '';
    }
  },

  async pickFileForRow(this: RequestBodyHost, row: KVRow, idx?: number) {
    const path = await openFileDialog('Select file');
    if (path) {
      row.isFile = true;
      row.value = path;
      row.fileName = path.split('/').pop() ?? path;
      if (idx !== undefined) guardTrailing(this.formRows, idx);
    }
  },

  async pickBinaryFile(this: RequestBodyHost) {
    const path = await openFileDialog('Select file');
    if (path) {
      this.bodyFilePath = path;
      this.bodyFileName = path.split('/').pop() ?? path;
    }
  },

  applyParsedCurl(this: RequestBodyHost, parsed: ParsedCurl) {
    if (!parsed.url) return;
    this.requestType = 'http';
    this.url = parsed.url;
    this.params = paramsFromUrl(this.url, this.params);
    this.pathParams = pathParamsFromUrl(this.url, this.pathParams);
    if (parsed.method) this.method = parsed.method as Method;
    if (parsed.followRedirects !== undefined) this.followRedirects = parsed.followRedirects;
    this.reqHeaders = parsed.headers?.length ? [...parsed.headers.map(h => ({ ...mkRow(), enabled: true, key: h.key, value: h.value })), mkRow()] : [mkRow()];
    this.authType = 'none';
    this.bearerToken = '';
    this.basicUser = '';
    this.basicPass = '';
    this.apiKeyValue = '';
    this.oauth2Token = '';
    this.awsAccessKey = '';
    this.awsSecretKey = '';
    this.oauth1 = { ...this.oauth1, consumerSecret: '', token: '', tokenSecret: '', privateKey: '' };
    this.resetBodyState();
    if (parsed.username) {
      this.authType = 'basic';
      this.basicUser = parsed.username;
      this.basicPass = parsed.password ?? '';
    }
    if (parsed.bodyType) this.bodyType = normalizeBodyTypeForUi(parsed.bodyType);
    if (parsed.bodyType && (RAW_BODY_TYPES as string[]).includes(normalizeRawBodyTypeForUi(parsed.bodyType))) this.rawBodyType = normalizeRawBodyTypeForUi(parsed.bodyType);
    if (parsed.bodyType === 'urlencoded' && parsed.body !== undefined) {
      const rows = [...new URLSearchParams(parsed.body).entries()].map(([k, v]) => ({ ...mkRow(), key: k, value: v }));
      if (rows.length) this.formRows = [...rows, mkRow()];
      this.bodyContent = '';
    } else if (parsed.body !== undefined) {
      this.bodyContent = parsed.body;
    }
    if (parsed.bodyType === 'binary' && parsed.bodyFilePath) {
      this.bodyFilePath = parsed.bodyFilePath;
      this.bodyFileName = parsed.bodyFilePath.split('/').pop() ?? parsed.bodyFilePath;
    }
    if (parsed.formData?.length) {
      this.formRows = [
        ...parsed.formData.map(f => ({
          ...mkRow(),
          key: f.key,
          value: f.value,
          isFile: f.isFile,
          fileName: f.isFile ? f.value.split('/').pop() : undefined,
          ...(f.contentType ? { contentType: f.contentType } : {}),
        })),
        mkRow(),
      ];
    }
    if (parsed.insecure) this.enableSSLVerification = false;
    if (parsed.timeoutMs !== undefined) this.timeoutMs = parsed.timeoutMs;
    if (parsed.proxyUrl) this.proxyUrl = parsed.proxyUrl;
    this.requestTab = parsed.bodyType || parsed.formData?.length ? 'body' : parsed.headers?.length ? 'headers' : 'params';
  },

  syncUrlFromParams(this: RequestBodyHost) {
    if (this.requestType === 'grpc') return;
    this.url = urlWithParams(this.url, this.params);
  },

  syncParamsFromUrl(this: RequestBodyHost) {
    if (this.requestType === 'grpc') return;
    this.params = paramsFromUrl(this.url, this.params);
    this.pathParams = pathParamsFromUrl(this.url, this.pathParams);
  },

  async onUrlPaste(this: RequestBodyHost, e: ClipboardEvent) {
    const text = e.clipboardData?.getData('text') ?? '';
    if (/^curl(?:\.exe)?(?:\s|$)/i.test(text.trimStart())) {
      e.preventDefault();
      const { parseCurl } = await import('../../curl');
      const parsed = parseCurl(text);
      if (parsed.url) {
        this.applyParsedCurl(parsed);
        const cookieHeader = parsed.headers
          ?.filter(header => header.key.trim().toLowerCase() === 'cookie' && header.value.trim())
          .map(header => header.value.trim())
          .join('; ');
        if (cookieHeader) void this.importCookieHeaderForUrl?.(parsed.url, cookieHeader);
        this.curlPasteToast = true;
        setTimeout(() => (this.curlPasteToast = false), 2500);
      }
    }
  },
};
