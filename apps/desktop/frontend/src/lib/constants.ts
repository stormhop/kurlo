import type { Method, RequestType, RawBodyType, ShortcutDefinition, AuthType, RequestSettings, KVRow, ProxyConfig } from './types/models';

export const REQUEST_TYPES: RequestType[] = ['http', 'graphql', 'ws', 'socketio', 'grpc', 'mcp', 'ai'];

export const BROWSER_LIKE_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
export const METHODS: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'SSE'];
export const RAW_BODY_TYPES: RawBodyType[] = ['text', 'json', 'html', 'xml'];

export const RAW_BODY_CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  text: 'text/plain',
  javascript: 'application/javascript',
  xml: 'application/xml',
  html: 'text/html',
  graphql: 'application/json',
};

export function methodConventionallyHasNoBody(method: string): boolean {
  const normalized = method.trim().toUpperCase();
  return normalized === '' || normalized === 'GET' || normalized === 'HEAD';
}

export const DEFAULT_WORKSPACE = 'My Workspace';
export const DEFAULT_COLLECTION = 'Requests';
export const MAX_WORKSPACES = 15;
export const MAX_FOLDER_DEPTH = 4;
export const MAX_FOLDER_REQUESTS = 50;

export const DEFAULT_REQUEST_SETTINGS: RequestSettings = {
  httpVersion: 'auto',
  enableSSLVerification: true,
  followRedirects: true,
  followOriginalMethod: false,
  followAuthorizationHeader: false,
  removeRefererHeader: false,
  encodeUrlAutomatically: true,
  disableCookieJar: false,
  maxRedirects: 10,
  timeoutMs: 30000,
  scriptTimeoutMs: 0,
  allowSendRequest: false,
  proxyUrl: '',
  clientCertPath: '',
  clientKeyPath: '',
  clientKeyPassword: '',
  browserEmulation: false,
  browserOrigin: '',
  browserWithCredentials: false,
  browserEnforceCORS: false,
  browserEnforceCSP: false,
  browserCSP: '',
  wsHandshakeTimeoutMs: 0,
  wsReconnectAttempts: 0,
  wsReconnectIntervalMs: 5000,
  wsMaxMessageSizeMb: 10,
  wsKeepAliveIntervalMs: 0,
  sseDisableReconnect: false,
  sseReconnectIntervalMs: 0,
  sioClientVersion: 'v3',
  sioPath: '/socket.io',
  sioNamespace: '/',
  grpcUseTls: false,
  grpcUseReflection: true,
  grpcServerName: '',
  grpcIncludeDefaultValues: true,
  grpcMaxResponseMessageSizeMb: 10,
};

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  mode: 'off',
  protocol: 'http',
  hostname: '',
  port: 0,
  auth: { enabled: false, username: '', password: '' },
  bypass: '',
};

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  { id: 'close-tab', group: 'Tabs', label: 'Close tab', defaultCombo: 'Meta+W' },
  { id: 'force-close-tab', group: 'Tabs', label: 'Force close tab', defaultCombo: 'Alt+Meta+W' },
  { id: 'next-tab', group: 'Tabs', label: 'Switch to next tab', defaultCombo: 'Shift+Meta+]' },
  { id: 'previous-tab', group: 'Tabs', label: 'Switch to previous tab', defaultCombo: 'Shift+Meta+[' },
  { id: 'tab-1', group: 'Tabs', label: 'Switch to tab 1', defaultCombo: 'Meta+1' },
  { id: 'tab-2', group: 'Tabs', label: 'Switch to tab 2', defaultCombo: 'Meta+2' },
  { id: 'tab-3', group: 'Tabs', label: 'Switch to tab 3', defaultCombo: 'Meta+3' },
  { id: 'tab-4', group: 'Tabs', label: 'Switch to tab 4', defaultCombo: 'Meta+4' },
  { id: 'tab-5', group: 'Tabs', label: 'Switch to tab 5', defaultCombo: 'Meta+5' },
  { id: 'tab-6', group: 'Tabs', label: 'Switch to tab 6', defaultCombo: 'Meta+6' },
  { id: 'tab-7', group: 'Tabs', label: 'Switch to tab 7', defaultCombo: 'Meta+7' },
  { id: 'tab-8', group: 'Tabs', label: 'Switch to tab 8', defaultCombo: 'Meta+8' },
  { id: 'last-tab', group: 'Tabs', label: 'Switch to last tab', defaultCombo: 'Meta+9' },
  { id: 'reopen-tab', group: 'Tabs', label: 'Reopen last closed tab', defaultCombo: 'Shift+Meta+T' },
  { id: 'search-sidebar', group: 'Sidebar', label: 'Search sidebar', defaultCombo: 'Meta+F' },
  { id: 'next-item', group: 'Sidebar', label: 'Next item', defaultCombo: 'ArrowDown' },
  { id: 'previous-item', group: 'Sidebar', label: 'Previous item', defaultCombo: 'ArrowUp' },
  { id: 'expand-item', group: 'Sidebar', label: 'Expand item', defaultCombo: 'ArrowRight' },
  { id: 'collapse-item', group: 'Sidebar', label: 'Collapse item', defaultCombo: 'ArrowLeft' },
  { id: 'expand-all', group: 'Sidebar', label: 'Expand all', defaultCombo: 'Alt+ArrowRight' },
  { id: 'collapse-all', group: 'Sidebar', label: 'Collapse all', defaultCombo: 'Alt+ArrowLeft' },
  { id: 'rename-item', group: 'Sidebar', label: 'Rename item', defaultCombo: 'Meta+E' },
  { id: 'copy-item', group: 'Sidebar', label: 'Copy item', defaultCombo: 'Meta+C' },
  { id: 'paste-item', group: 'Sidebar', label: 'Paste item', defaultCombo: 'Meta+V' },
  { id: 'duplicate-item', group: 'Sidebar', label: 'Duplicate item', defaultCombo: 'Meta+D' },
  { id: 'delete-item', group: 'Sidebar', label: 'Delete item', defaultCombo: 'Backspace' },
  { id: 'request-url', group: 'Request', label: 'Request URL', defaultCombo: 'Meta+L' },
  { id: 'send-request', group: 'Request', label: 'Send request', defaultCombo: 'Meta+Enter' },
  { id: 'save-request', group: 'Request', label: 'Save request', defaultCombo: 'Meta+S' },
  { id: 'new-request', group: 'Window and modals', label: 'New request', defaultCombo: 'Meta+N' },
  { id: 'settings', group: 'Window and modals', label: 'Settings', defaultCombo: 'Meta+,' },
  { id: 'shortcut-help', group: 'Window and modals', label: 'Open shortcut help', defaultCombo: 'Meta+/' },
  { id: 'search', group: 'Window and modals', label: 'Search', defaultCombo: 'Meta+K' },
  { id: 'toggle-left-sidebar', group: 'Interface', label: 'Toggle left sidebar', defaultCombo: 'Meta+\\' },
  { id: 'toggle-right-sidebar', group: 'Interface', label: 'Toggle right sidebar', defaultCombo: 'Alt+Meta+\\' },
  { id: 'zoom-in', group: 'Interface', label: 'Zoom in', defaultCombo: 'Meta+=' },
  { id: 'zoom-out', group: 'Interface', label: 'Zoom out', defaultCombo: 'Meta+-' },
  { id: 'zoom-reset', group: 'Interface', label: 'Reset zoom', defaultCombo: 'Meta+0' },
];

export const AUTH_OPTIONS: { value: AuthType; label: string }[] = [
  { value: 'inherit', label: 'Inherit auth' },
  { value: 'none', label: 'No auth' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'basic', label: 'Basic auth' },
  { value: 'digest', label: 'Digest auth' },
  { value: 'apikey', label: 'API key' },
  { value: 'oauth1', label: 'OAuth 1.0' },
  { value: 'oauth2', label: 'OAuth 2.0' },
  { value: 'aws', label: 'AWS Signature v4' },
];

export const OAUTH1_SIGNATURE_OPTIONS = (['HMAC-SHA1', 'HMAC-SHA256', 'HMAC-SHA512', 'RSA-SHA1', 'RSA-SHA256', 'RSA-SHA512', 'PLAINTEXT'] as const)
  .map(value => ({ value, label: value }));

export const COLLECTION_AUTH_OPTIONS = AUTH_OPTIONS
  .filter(option => option.value !== 'inherit')
  .map(option => option.value === 'oauth2' ? { ...option, label: 'OAuth 2.0 (client credentials)' } : option);

let _rowCounter = 0;
export function mkRow(): KVRow {
  return { id: _rowCounter++, enabled: true, key: '', value: '', description: '', secret: false };
}
