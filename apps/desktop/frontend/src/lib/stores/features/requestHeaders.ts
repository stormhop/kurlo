import type { CookieJarEntry } from '../../backend';
import { buildBrowserSecurityPreview } from '../../browserSecurityPreview';
import { cookieHeaderForUrl } from '../../cookieJar';
import { firstHeaderValidationIssue, getHeaderValues, headerValidationIssueLabel } from '../../headers';
import { mkRow } from '../../constants';
import type { KVRow, PreviewHeader, RequestType, SavedRequest } from '../../types/models';
import { activeCount } from '../../utils';

type RequestHeadersHost = {
  autoRequestHeaders: PreviewHeader[];
  cookies: CookieJarEntry[];
  headerValueSuggestions: string[];
  reqHeaders: KVRow[];
  activeEnvironmentValues: () => Record<string, string>;
  bodyContentType: () => string;
  bodyLengthLabel: () => string;
  buildAutoRequestHeaders: () => PreviewHeader[];
  environmentValuesForRequest: (req: Pick<SavedRequest, 'collectionId'>, envValues?: Record<string, string>) => Record<string, string>;
  hasEnabledHeader: (name: string, rows?: KVRow[]) => boolean;
  normalizeRequestTypeValue: (value: unknown, url?: string) => RequestType;
  normalizeRequestUrlForSend: (rawUrl: string) => string;
  normalizeWebSocketUrlForSend: (rawUrl: string) => string;
  requestWithCollectionDefaults: (req: SavedRequest) => SavedRequest;
  resolveRows: (rows: KVRow[], values?: Record<string, string>) => KVRow[];
  resolveTemplate: (value: string, values?: Record<string, string>) => string;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
};

export const requestHeadersFeature = {
  get autoRequestHeaders(): PreviewHeader[] {
    const host = this as unknown as RequestHeadersHost;
    return host.buildAutoRequestHeaders();
  },

  get requestHeaderCount(): number {
    const host = this as unknown as RequestHeadersHost;
    return activeCount(host.reqHeaders) + host.autoRequestHeaders.length;
  },

  hasEnabledHeader(this: RequestHeadersHost, name: string, rows: KVRow[] = this.reqHeaders) {
    return rows.some(h => h.enabled && h.key.trim().toLowerCase() === name.toLowerCase());
  },

  headerValidationErrorForRequest(this: RequestHeadersHost, req: SavedRequest, envValues = this.activeEnvironmentValues()) {
    const request = this.requestWithCollectionDefaults(req);
    const values = this.environmentValuesForRequest(request, envValues);
    const rows = this.resolveRows(request.headers, values);
    if (request.auth.type === 'apikey' && request.auth.apiKeyIn === 'header') {
      rows.push({
        ...mkRow(),
        key: this.resolveTemplate(request.auth.apiKeyName, values),
        value: this.resolveTemplate(request.auth.apiKeyValue, values),
      });
    }
    const issue = firstHeaderValidationIssue(rows);
    return issue ? headerValidationIssueLabel(issue) : '';
  },

  buildAutoRequestHeaders(this: RequestHeadersHost): PreviewHeader[] {
    const request = this.requestWithCollectionDefaults(this.snapshotActiveRequest());
    const requestType = this.normalizeRequestTypeValue(request.requestType, request.url);
    const auth = request.auth;
    const headers: PreviewHeader[] = [];
    const values = this.environmentValuesForRequest(request);
    const resolvedHeaders = this.resolveRows(request.headers, values);
    const add = (key: string, value: string, note: string, overridden = this.hasEnabledHeader(key, resolvedHeaders)) => { if (!value) return; headers.push({ key, value, note, overridden }); };
    let requestUrl = '';
    try {
      const rawUrl = this.resolveTemplate(request.url.trim(), values);
      const normalized = (requestType === 'ws' || requestType === 'socketio')
        ? this.normalizeWebSocketUrlForSend(rawUrl)
        : this.normalizeRequestUrlForSend(rawUrl);
      const parsed = new URL(normalized);
      requestUrl = parsed.href;
      add('Host', parsed.host, 'from request URL', false);
    } catch {}
    const browserPreview = buildBrowserSecurityPreview({
      settings: request.settings,
      requestUrl,
      headers: resolvedHeaders,
      kind: requestType === 'ws' || requestType === 'socketio' ? 'handshake' : 'fetch',
    });
    if (browserPreview.active) {
      headers.push(...browserPreview.headers);
      if (browserPreview.fetchHeadersApplied && request.method !== 'SSE' && !this.hasEnabledHeader('Accept', resolvedHeaders)) {
        add(
          'Accept',
          '*/*',
          request.settings.browserEmulation ? 'from browser request emulation' : 'from browser security checks',
          false,
        );
      }
    } else {
      add('User-Agent', 'Kurlo', 'Kurlo default');
    }
    if (!request.settings.disableCookieJar && !browserPreview.stripCookieJar && requestUrl) add('Cookie', cookieHeaderForUrl(this.cookies, requestUrl), 'from cookie jar');
    if (requestType === 'ws') {
      add('Connection', 'Upgrade', 'added automatically for WebSocket');
      add('Upgrade', 'websocket', 'added automatically for WebSocket');
      add('Sec-WebSocket-Version', '13', 'added automatically for WebSocket');
    } else if (requestType === 'socketio') {
      add('Connection', 'Upgrade', 'added automatically for Socket.IO');
      add('Upgrade', 'websocket', 'added automatically for Socket.IO');
      add('Sec-WebSocket-Version', '13', 'added automatically for Socket.IO');
    } else {
      const ct = this.bodyContentType(); if (ct) add('Content-Type', ct, 'from body type');
      const cl = this.bodyLengthLabel(); if (cl) add('Content-Length', cl, 'calculated by runtime');
    }
    if (auth.type === 'bearer' && auth.bearerToken) add('Authorization', `Bearer ${auth.bearerToken}`, 'from auth settings', false);
    if ((auth.type === 'basic' || auth.type === 'digest') && (auth.basicUser || auth.basicPass)) {
      try { add('Authorization', `Basic ${btoa(`${auth.basicUser}:${auth.basicPass}`)}`, 'from auth settings', false); }
      catch { add('Authorization', 'Basic <generated>', 'from auth settings', false); }
    }
    if (auth.type === 'ntlm' && auth.basicUser) add('Authorization', 'NTLM <negotiated>', 'from auth settings', false);
    if (auth.type === 'oauth2' && auth.oauth2Token) add('Authorization', `Bearer ${auth.oauth2Token}`, 'from OAuth token', false);
    if (auth.type === 'apikey' && auth.apiKeyIn === 'header' && auth.apiKeyName) add(auth.apiKeyName, auth.apiKeyValue, 'from API key auth', false);
    if (auth.type === 'aws') { add('Authorization', 'AWS4-HMAC-SHA256 <generated>', 'from AWS Signature v4', false); add('X-Amz-Date', '<generated>', 'from AWS Signature v4', false); add('X-Amz-Content-Sha256', '<generated>', 'from AWS Signature v4', false); }
    if (request.method === 'SSE') {
      add('Accept', 'text/event-stream', 'added automatically for SSE');
      add('Cache-Control', 'no-cache', 'added automatically for SSE');
      add('Connection', 'keep-alive', 'added automatically for SSE');
    }
    return headers;
  },

  onHeaderKeyInput(this: RequestHeadersHost, row: KVRow) {
    this.headerValueSuggestions = getHeaderValues(row.key);
  },
};
