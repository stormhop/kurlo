import { openFileDialog } from '../../backend';
import { DEFAULT_PROXY_CONFIG, DEFAULT_REQUEST_SETTINGS, SHORTCUT_DEFINITIONS } from '../../constants';
import { normalizeProxyConfig, proxyConfigForPersistence } from '../../proxy';
import { loadStartupView, saveStartupView, type StartupView } from '../../startupView';
import type { SettingsTab } from '../ui';
import {
  applyDocumentTheme,
  normalizeThemeSettings,
  syncNativeThemeBackground,
  THEME_KEY,
  withThemeVariant,
  type AppTheme,
  type AppThemeMode,
  type ThemeVariantId,
} from '../../theme';
import { applyUiScale, currentUiScale, saveUiScale, stepUiScale } from '../../uiScale';
import type { HttpVersion, ProxyConfig, RequestSettings, ScriptEngine, ShortcutId, Workspace } from '../../types/models';

type PreferencesHost = {
  autosave: boolean;
  startupView: StartupView;
  scriptEngine: ScriptEngine;
  dirtyRequestIds: Set<string>;
  httpVersion: HttpVersion;
  enableSSLVerification: boolean;
  followRedirects: boolean;
  followOriginalMethod: boolean;
  followAuthorizationHeader: boolean;
  removeRefererHeader: boolean;
  encodeUrlAutomatically: boolean;
  disableCookieJar: boolean;
  maxRedirects: number;
  timeoutMs: number;
  scriptTimeoutMs: number;
  allowSendRequest: boolean;
  proxyUrl: string;
  clientCertPath: string;
  clientKeyPath: string;
  clientKeyPassword: string;
  browserEmulation: boolean;
  browserOrigin: string;
  browserWithCredentials: boolean;
  browserEnforceCORS: boolean;
  browserEnforceCSP: boolean;
  browserCSP: string;
  wsHandshakeTimeoutMs: number;
  wsReconnectAttempts: number;
  wsReconnectIntervalMs: number;
  wsMaxMessageSizeMb: number;
  wsKeepAliveIntervalMs: number;
  sseDisableReconnect: boolean;
  sseReconnectIntervalMs: number;
  sioClientVersion: import('../../types/models').SocketIOClientVersion;
  sioPath: string;
  sioNamespace: string;
  grpcUseTls: boolean;
  grpcUseReflection: boolean;
  grpcServerName: string;
  grpcIncludeDefaultValues: boolean;
  grpcMaxResponseMessageSizeMb: number;
  settingsSaved: boolean;
  shortcutOverrides: Record<string, string>;
  shortcutEditingId: ShortcutId | '';
  shortcutCaptureMessage: string;
  shortcutsOpen: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  appRuntime: string;
  appTheme: AppTheme;
  resolvedAppTheme: 'dark' | 'light';
  proxyConfig: ProxyConfig;
  activeWorkspaceId: string;
  workspaces: Workspace[];
  activeWorkspace: Workspace | undefined;
  closeFloatingMenus: () => void;
  openConfirmDialog: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  persistRequestStore: () => Promise<boolean>;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  saveDirtyRequestsToDisk: () => Promise<void>;
  currentRequestSettings: () => RequestSettings;
  applyRequestSettings: (settings: Partial<RequestSettings>) => void;
  saveShortcutSettings: () => void;
  markRequestSettingOverride?: (key: keyof RequestSettings) => void;
  clearRequestSettingOverrides?: () => void;
  shortcutCombo: (id: ShortcutId) => string;
  shortcutKeyLabel: (key: string) => string;
  normalizeShortcutKey: (key: string) => string;
  eventToCombo: (event: KeyboardEvent) => string;
  applyTheme: (theme?: AppTheme) => void;
  setTheme: (theme: AppTheme) => void;
  setUiScale: (scale: number) => void;
};

const SETTINGS_STORAGE_KEY = 'kurlo.request.settings.v1';

export function storableRequestSettings<T extends Partial<RequestSettings>>(settings: T): Omit<T, 'clientKeyPassword'> {
  const copy = { ...settings };
  delete copy.clientKeyPassword;
  return copy;
}
const SHORTCUT_STORAGE_KEY = 'kurlo.shortcuts.v1';
const AUTOSAVE_STORAGE_KEY = 'kurlo.autosave.v1';
const PROXY_STORAGE_KEY = 'kurlo.proxy.v1';
const SCRIPT_ENGINE_STORAGE_KEY = 'kurlo.scriptEngine.v1';

export function shortcutPlatform(runtime = ''): string {
  const fromRuntime = runtime.split('/')[0];
  if (fromRuntime) return fromRuntime;
  if (typeof document !== 'undefined') return document.documentElement.dataset.platform ?? 'browser';
  return 'browser';
}

export function usesMacShortcutGlyphs(runtime = ''): boolean {
  return shortcutPlatform(runtime) === 'darwin';
}

const SHORTCUT_MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

export function canonicalShortcutCombo(combo: string): string {
  if (!combo) return combo;
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  const modifiers = SHORTCUT_MODIFIER_ORDER.filter(modifier => parts.includes(modifier));
  return [...modifiers, key].join('+');
}

export function platformShortcutCombo(combo: string, runtime = ''): string {
  if (!combo) return combo;
  if (usesMacShortcutGlyphs(runtime)) return canonicalShortcutCombo(combo);
  return canonicalShortcutCombo(combo.split('+').map(part => (part === 'Meta' ? 'Ctrl' : part)).join('+'));
}

const SHORTCUT_CODE_KEYS: Record<string, string> = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', IntlBackslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
};

export function shortcutKeyFromEvent(event: Pick<KeyboardEvent, 'key' | 'code'>): string {
  const key = event.key;
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (key === '+') return '=';
  if (key === 'Esc') return 'Escape';
  if (key.length === 1 && key >= '!' && key <= '~') return key.toUpperCase();
  const code = event.code ?? '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (SHORTCUT_CODE_KEYS[code]) return SHORTCUT_CODE_KEYS[code];
  return key.length === 1 ? key.toUpperCase() : key;
}

export type ShortcutKeycap = { key: string; label: string; title: string; icon?: 'windows' };

const MAC_KEY_LABELS: Record<string, string> = {
  Meta: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃', Enter: '↵', Backspace: '⌫', Delete: '⌦', Escape: 'esc', Tab: '⇥',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', ' ': 'Space',
};
const PC_KEY_LABELS: Record<string, string> = {
  Shift: '⇧ Shift', Alt: 'Alt', Ctrl: 'Ctrl', Enter: '↵ Enter', Backspace: '⌫', Delete: 'Del', Escape: 'Esc', Tab: '⇥ Tab',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', ' ': 'Space',
};
const KEY_TITLES: Record<string, string> = {
  Meta: 'Command', Shift: 'Shift', Alt: 'Option', Ctrl: 'Control', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete',
  Escape: 'Escape', Tab: 'Tab', ArrowUp: 'Up arrow', ArrowDown: 'Down arrow', ArrowLeft: 'Left arrow', ArrowRight: 'Right arrow', Space: 'Space',
};

export function shortcutKeycap(key: string, runtime = ''): ShortcutKeycap {
  const platform = shortcutPlatform(runtime);
  if (platform === 'darwin') {
    return { key, label: MAC_KEY_LABELS[key] ?? key.toUpperCase(), title: KEY_TITLES[key] ?? key.toUpperCase() };
  }
  if (key === 'Meta') {
    return platform === 'windows'
      ? { key, label: 'Win', title: 'Windows key', icon: 'windows' }
      : { key, label: 'Super', title: 'Super key' };
  }
  const title = key === 'Alt' ? 'Alt' : key === 'Ctrl' ? 'Ctrl' : KEY_TITLES[key] ?? key.toUpperCase();
  return { key, label: PC_KEY_LABELS[key] ?? key.toUpperCase(), title };
}

export function shortcutKeycaps(combo: string, runtime = ''): ShortcutKeycap[] {
  const canonical = canonicalShortcutCombo(combo);
  return canonical ? canonical.split('+').map(key => shortcutKeycap(key, runtime)) : [];
}

export function shortcutKeyLabelForPlatform(key: string, runtime = ''): string {
  if (usesMacShortcutGlyphs(runtime)) return shortcutKeycap(key, runtime).label;
  const keycap = shortcutKeycap(key, runtime);
  return keycap.label.replace(/^[⇧↵⇥] /, '');
}

export function shortcutComboLabel(combo: string, runtime = ''): string {
  const canonical = canonicalShortcutCombo(combo);
  if (!canonical) return 'Unassigned';
  const labels = canonical.split('+').map(key => shortcutKeyLabelForPlatform(key, runtime));
  return usesMacShortcutGlyphs(runtime) ? labels.join('') : labels.join('+');
}

function persistProxyConfigSansPassword(config: ProxyConfig): void {
  try {
    localStorage.setItem(PROXY_STORAGE_KEY, JSON.stringify(proxyConfigForPersistence(config)));
  } catch {}
}

export const preferencesFeature = {
  currentRequestSettings(this: PreferencesHost): RequestSettings {
    return {
      httpVersion: this.httpVersion,
      enableSSLVerification: this.enableSSLVerification,
      followRedirects: this.followRedirects,
      followOriginalMethod: this.followOriginalMethod,
      followAuthorizationHeader: this.followAuthorizationHeader,
      removeRefererHeader: this.removeRefererHeader,
      encodeUrlAutomatically: this.encodeUrlAutomatically,
      disableCookieJar: this.disableCookieJar,
      maxRedirects: this.maxRedirects,
      timeoutMs: this.timeoutMs,
      scriptTimeoutMs: this.scriptTimeoutMs,
      allowSendRequest: this.allowSendRequest,
      proxyUrl: this.proxyUrl,
      clientCertPath: this.clientCertPath,
      clientKeyPath: this.clientKeyPath,
      clientKeyPassword: this.clientKeyPassword,
      browserEmulation: this.browserEmulation,
      browserOrigin: this.browserOrigin,
      browserWithCredentials: this.browserWithCredentials,
      browserEnforceCORS: this.browserEnforceCORS,
      browserEnforceCSP: this.browserEnforceCSP,
      browserCSP: this.browserCSP,
      wsHandshakeTimeoutMs: this.wsHandshakeTimeoutMs,
      wsReconnectAttempts: this.wsReconnectAttempts,
      wsReconnectIntervalMs: this.wsReconnectIntervalMs,
      wsMaxMessageSizeMb: this.wsMaxMessageSizeMb,
      wsKeepAliveIntervalMs: this.wsKeepAliveIntervalMs,
      sseDisableReconnect: this.sseDisableReconnect,
      sseReconnectIntervalMs: this.sseReconnectIntervalMs,
      sioClientVersion: this.sioClientVersion,
      sioPath: this.sioPath,
      sioNamespace: this.sioNamespace,
      grpcUseTls: this.grpcUseTls,
      grpcUseReflection: this.grpcUseReflection,
      grpcServerName: this.grpcServerName,
      grpcIncludeDefaultValues: this.grpcIncludeDefaultValues,
      grpcMaxResponseMessageSizeMb: this.grpcMaxResponseMessageSizeMb,
    };
  },
  applyRequestSettings(this: PreferencesHost, settings: Partial<RequestSettings>) {
    this.httpVersion = settings.httpVersion ?? DEFAULT_REQUEST_SETTINGS.httpVersion;
    this.enableSSLVerification = settings.enableSSLVerification ?? DEFAULT_REQUEST_SETTINGS.enableSSLVerification;
    this.followRedirects = settings.followRedirects ?? DEFAULT_REQUEST_SETTINGS.followRedirects;
    this.followOriginalMethod = settings.followOriginalMethod ?? DEFAULT_REQUEST_SETTINGS.followOriginalMethod;
    this.followAuthorizationHeader = settings.followAuthorizationHeader ?? DEFAULT_REQUEST_SETTINGS.followAuthorizationHeader;
    this.removeRefererHeader = settings.removeRefererHeader ?? DEFAULT_REQUEST_SETTINGS.removeRefererHeader;
    this.encodeUrlAutomatically = settings.encodeUrlAutomatically ?? DEFAULT_REQUEST_SETTINGS.encodeUrlAutomatically;
    this.disableCookieJar = settings.disableCookieJar ?? DEFAULT_REQUEST_SETTINGS.disableCookieJar;
    this.maxRedirects = settings.maxRedirects ?? DEFAULT_REQUEST_SETTINGS.maxRedirects;
    this.timeoutMs = settings.timeoutMs ?? DEFAULT_REQUEST_SETTINGS.timeoutMs;
    this.scriptTimeoutMs = settings.scriptTimeoutMs ?? DEFAULT_REQUEST_SETTINGS.scriptTimeoutMs;
    this.allowSendRequest = settings.allowSendRequest ?? DEFAULT_REQUEST_SETTINGS.allowSendRequest;
    this.proxyUrl = settings.proxyUrl ?? DEFAULT_REQUEST_SETTINGS.proxyUrl;
    this.clientCertPath = settings.clientCertPath ?? DEFAULT_REQUEST_SETTINGS.clientCertPath;
    this.clientKeyPath = settings.clientKeyPath ?? DEFAULT_REQUEST_SETTINGS.clientKeyPath;
    this.clientKeyPassword = settings.clientKeyPassword ?? DEFAULT_REQUEST_SETTINGS.clientKeyPassword;
    this.browserEmulation = settings.browserEmulation ?? DEFAULT_REQUEST_SETTINGS.browserEmulation;
    this.browserOrigin = settings.browserOrigin ?? DEFAULT_REQUEST_SETTINGS.browserOrigin;
    this.browserWithCredentials = settings.browserWithCredentials ?? DEFAULT_REQUEST_SETTINGS.browserWithCredentials;
    this.browserEnforceCORS = settings.browserEnforceCORS ?? DEFAULT_REQUEST_SETTINGS.browserEnforceCORS;
    this.browserEnforceCSP = settings.browserEnforceCSP ?? DEFAULT_REQUEST_SETTINGS.browserEnforceCSP;
    this.browserCSP = settings.browserCSP ?? DEFAULT_REQUEST_SETTINGS.browserCSP;
    this.wsHandshakeTimeoutMs = settings.wsHandshakeTimeoutMs ?? DEFAULT_REQUEST_SETTINGS.wsHandshakeTimeoutMs;
    this.wsReconnectAttempts = settings.wsReconnectAttempts ?? DEFAULT_REQUEST_SETTINGS.wsReconnectAttempts;
    this.wsReconnectIntervalMs = settings.wsReconnectIntervalMs ?? DEFAULT_REQUEST_SETTINGS.wsReconnectIntervalMs;
    this.wsMaxMessageSizeMb = settings.wsMaxMessageSizeMb ?? DEFAULT_REQUEST_SETTINGS.wsMaxMessageSizeMb;
    this.wsKeepAliveIntervalMs = settings.wsKeepAliveIntervalMs ?? DEFAULT_REQUEST_SETTINGS.wsKeepAliveIntervalMs;
    this.sseDisableReconnect = settings.sseDisableReconnect ?? DEFAULT_REQUEST_SETTINGS.sseDisableReconnect;
    this.sseReconnectIntervalMs = settings.sseReconnectIntervalMs ?? DEFAULT_REQUEST_SETTINGS.sseReconnectIntervalMs;
    this.sioClientVersion = settings.sioClientVersion ?? DEFAULT_REQUEST_SETTINGS.sioClientVersion;
    this.sioPath = settings.sioPath ?? DEFAULT_REQUEST_SETTINGS.sioPath;
    this.sioNamespace = settings.sioNamespace ?? DEFAULT_REQUEST_SETTINGS.sioNamespace;
    this.grpcUseTls = settings.grpcUseTls ?? DEFAULT_REQUEST_SETTINGS.grpcUseTls;
    this.grpcUseReflection = settings.grpcUseReflection ?? DEFAULT_REQUEST_SETTINGS.grpcUseReflection;
    this.grpcServerName = settings.grpcServerName ?? DEFAULT_REQUEST_SETTINGS.grpcServerName;
    this.grpcIncludeDefaultValues = settings.grpcIncludeDefaultValues ?? DEFAULT_REQUEST_SETTINGS.grpcIncludeDefaultValues;
    this.grpcMaxResponseMessageSizeMb = settings.grpcMaxResponseMessageSizeMb ?? DEFAULT_REQUEST_SETTINGS.grpcMaxResponseMessageSizeMb;
  },
  loadRequestSettings(this: PreferencesHost) {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as Partial<RequestSettings>;
      if ('clientKeyPassword' in stored) localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(storableRequestSettings(stored)));
      this.applyRequestSettings(storableRequestSettings(stored));
    } catch {
      this.applyRequestSettings(DEFAULT_REQUEST_SETTINGS);
    }
  },
  saveRequestSettings(this: PreferencesHost) {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(storableRequestSettings(this.currentRequestSettings())));
    this.settingsSaved = true;
    setTimeout(() => (this.settingsSaved = false), 1600);
  },
  resetRequestSettings(this: PreferencesHost) {
    this.applyRequestSettings(DEFAULT_REQUEST_SETTINGS);
    localStorage.removeItem(SETTINGS_STORAGE_KEY);
    this.clearRequestSettingOverrides?.();
  },
  async toggleSSLVerification(this: PreferencesHost) {
    if (this.enableSSLVerification) {
      const confirmed = await this.openConfirmDialog(
        'Disable SSL verification',
        'Disabling SSL verification exposes this request to man-in-the-middle attacks. Only use this against trusted hosts in a controlled environment.',
        'Disable'
      );
      if (confirmed) {
        this.enableSSLVerification = false;
        this.markRequestSettingOverride?.('enableSSLVerification');
      }
    } else {
      this.enableSSLVerification = true;
      this.markRequestSettingOverride?.('enableSSLVerification');
    }
  },
  async pickClientCertFile(this: PreferencesHost, field: 'clientCertPath' | 'clientKeyPath') {
    const path = await openFileDialog(field === 'clientCertPath' ? 'Select client certificate' : 'Select client key');
    if (path) {
      this[field] = path;
      this.markRequestSettingOverride?.(field);
    }
  },
  clearClientCertField(this: PreferencesHost, field: 'clientCertPath' | 'clientKeyPath' | 'clientKeyPassword') {
    this[field] = '';
    this.markRequestSettingOverride?.(field);
  },
  loadShortcutSettings(this: PreferencesHost) {
    try {
      const raw = localStorage.getItem(SHORTCUT_STORAGE_KEY);
      this.shortcutOverrides = raw ? JSON.parse(raw) : {};
    } catch {
      this.shortcutOverrides = {};
    }
  },
  saveShortcutSettings(this: PreferencesHost) {
    localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(this.shortcutOverrides));
  },
  shortcutCombo(this: PreferencesHost, id: ShortcutId) {
    const override = this.shortcutOverrides[id];
    if (override !== undefined) return canonicalShortcutCombo(override);
    const defaultCombo = SHORTCUT_DEFINITIONS.find(definition => definition.id === id)?.defaultCombo ?? '';
    return platformShortcutCombo(defaultCombo, this.appRuntime);
  },
  shortcutGroups() {
    const groups: { name: string; items: typeof SHORTCUT_DEFINITIONS }[] = [];
    for (const item of SHORTCUT_DEFINITIONS) {
      let group = groups.find(candidate => candidate.name === item.group);
      if (!group) {
        group = { name: item.group, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }
    return groups;
  },
  shortcutKeyLabel(this: PreferencesHost, key: string) {
    return shortcutKeyLabelForPlatform(key, this.appRuntime);
  },
  normalizeShortcutKey(this: PreferencesHost, key: string) {
    return shortcutKeyFromEvent({ key, code: '' });
  },
  eventToCombo(this: PreferencesHost, event: KeyboardEvent) {
    if (['Meta', 'Control', 'Shift', 'Alt', 'AltGraph', 'OS'].includes(event.key)) return '';
    const key = shortcutKeyFromEvent(event);
    const parts: string[] = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    parts.push(key);
    return parts.join('+');
  },
  shortcutForEvent(this: PreferencesHost, event: KeyboardEvent) {
    const combo = this.eventToCombo(event);
    if (!combo) return null;
    const match = SHORTCUT_DEFINITIONS.find(definition => this.shortcutCombo(definition.id) === combo)?.id ?? null;
    if (match || !event.shiftKey || !combo.endsWith('+=')) return match;
    return this.shortcutCombo('zoom-in') === combo.replace('Shift+', '') ? 'zoom-in' : null;
  },
  setShortcut(this: PreferencesHost, id: ShortcutId, combo: string) {
    const defaultCombo = platformShortcutCombo(SHORTCUT_DEFINITIONS.find(definition => definition.id === id)?.defaultCombo ?? '', this.appRuntime);
    const next = { ...this.shortcutOverrides };
    for (const definition of SHORTCUT_DEFINITIONS) {
      if (definition.id !== id && this.shortcutCombo(definition.id) === combo) next[definition.id] = '';
    }
    if (combo === defaultCombo) delete next[id];
    else next[id] = combo;
    this.shortcutOverrides = next;
    this.saveShortcutSettings();
  },
  resetShortcut(this: PreferencesHost, id: ShortcutId) {
    const next = { ...this.shortcutOverrides };
    delete next[id];
    this.shortcutOverrides = next;
    this.saveShortcutSettings();
  },
  resetAllShortcuts(this: PreferencesHost) {
    this.shortcutOverrides = {};
    this.shortcutEditingId = '';
    this.shortcutCaptureMessage = '';
    this.saveShortcutSettings();
  },
  startShortcutCapture(this: PreferencesHost, id: ShortcutId) {
    this.shortcutEditingId = id;
    this.shortcutCaptureMessage = 'Press a new shortcut';
  },
  openShortcutHelp(this: PreferencesHost) {
    this.closeFloatingMenus();
    this.shortcutsOpen = true;
    this.shortcutEditingId = '';
    this.shortcutCaptureMessage = '';
  },
  closeShortcutHelp(this: PreferencesHost) {
    this.shortcutsOpen = false;
    this.shortcutEditingId = '';
    this.shortcutCaptureMessage = '';
  },
  loadTheme(this: PreferencesHost) {
    const { appTheme, resolvedAppTheme, themeVariant } = applyDocumentTheme();
    this.appTheme = appTheme;
    this.resolvedAppTheme = resolvedAppTheme;
    syncNativeThemeBackground(resolvedAppTheme, themeVariant);
  },
  applyTheme(this: PreferencesHost, theme: AppTheme = this.appTheme) {
    const { appTheme, resolvedAppTheme, themeVariant } = applyDocumentTheme(theme);
    this.appTheme = appTheme;
    this.resolvedAppTheme = resolvedAppTheme;
    syncNativeThemeBackground(resolvedAppTheme, themeVariant);
  },
  setTheme(this: PreferencesHost, theme: AppTheme) {
    this.appTheme = normalizeThemeSettings(theme);
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(this.appTheme));
    } catch {}
    this.applyTheme(this.appTheme);
  },
  setThemeMode(this: PreferencesHost, mode: AppThemeMode) {
    this.setTheme({ ...this.appTheme, mode });
  },
  setThemeVariant(this: PreferencesHost, id: ThemeVariantId) {
    this.setTheme(withThemeVariant(this.appTheme, id));
  },
  get uiScale(): number {
    return currentUiScale();
  },
  setUiScale(this: PreferencesHost, scale: number) {
    saveUiScale(applyUiScale(scale));
  },
  zoomIn(this: PreferencesHost) {
    this.setUiScale(stepUiScale(currentUiScale(), 1));
  },
  zoomOut(this: PreferencesHost) {
    this.setUiScale(stepUiScale(currentUiScale(), -1));
  },
  resetZoom(this: PreferencesHost) {
    this.setUiScale(1);
  },
  loadAutosaveSettings(this: PreferencesHost) {
    try {
      const raw = localStorage.getItem(AUTOSAVE_STORAGE_KEY);
      if (raw !== null) this.autosave = raw !== 'false';
    } catch {}
  },
  setAutosave(this: PreferencesHost, value: boolean) {
    this.autosave = value;
    localStorage.setItem(AUTOSAVE_STORAGE_KEY, String(value));
    if (value) {
      void this.saveDirtyRequestsToDisk();
    } else {
      void this.persistActiveRequestNow(true);
    }
  },
  loadStartupViewPreference(this: PreferencesHost) {
    this.startupView = loadStartupView();
  },
  setStartupView(this: PreferencesHost, view: StartupView) {
    this.startupView = view;
    saveStartupView(view);
  },
  loadScriptEngine(this: PreferencesHost) {
    try {
      const raw = localStorage.getItem(SCRIPT_ENGINE_STORAGE_KEY);
      if (raw === 'js' || raw === 'tengo') this.scriptEngine = raw;
    } catch {}
  },
  setScriptEngine(this: PreferencesHost, value: ScriptEngine) {
    this.scriptEngine = value;
    try {
      localStorage.setItem(SCRIPT_ENGINE_STORAGE_KEY, value);
    } catch {}
  },
  loadProxyConfig(this: PreferencesHost) {
    try {
      const raw = localStorage.getItem(PROXY_STORAGE_KEY);
      this.proxyConfig = normalizeProxyConfig(raw ? JSON.parse(raw) : DEFAULT_PROXY_CONFIG);
    } catch {
      this.proxyConfig = normalizeProxyConfig(DEFAULT_PROXY_CONFIG);
    }

    if (this.proxyConfig.auth.password) persistProxyConfigSansPassword(this.proxyConfig);
  },
  setProxyConfig(this: PreferencesHost, next: ProxyConfig) {
    this.proxyConfig = normalizeProxyConfig(next);
    persistProxyConfigSansPassword(this.proxyConfig);
  },
};
