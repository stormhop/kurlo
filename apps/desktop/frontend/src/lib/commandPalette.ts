import type { AppThemeMode } from './theme';
import type { RequestType, ShortcutId, SidebarView } from './types/models';
import type { ResponseLayout } from './stores/features/uiShell';
import type { SettingsTab } from './stores/ui';

export type PaletteGroup = 'Go to' | 'Create' | 'Request' | 'View' | 'Help';

export type PaletteCommand = {
  id: string;
  label: string;
  group: PaletteGroup;
  keywords?: string;
  shortcut?: ShortcutId;
  run: () => unknown;
};

export type PaletteContext = {
  hasActiveRequest: boolean;
  canCopyCurl: boolean;
  autosave: boolean;
  codePanelAvailable: boolean;
  codePanelOpen: boolean;
  sidebarHidden: boolean;
  responseLayout: ResponseLayout;
  themeMode: AppThemeMode;
  whatsNewAvailable: boolean;
  showSidebarView: (view: SidebarView) => void;
  openGlobals: () => unknown;
  openCollectionRunner: () => unknown;
  openMockServer: () => unknown;
  openGit: () => unknown;
  openCookies: () => unknown;
  openSettings: (tab: SettingsTab) => unknown;
  runShortcut: (id: ShortcutId) => unknown;
  createRequest: (type: RequestType) => unknown;
  createCollection: () => unknown;
  createEnvironment: () => unknown;
  importCollection: () => unknown;
  copyCurl: () => unknown;
  findReplaceInCollection?: () => unknown;
  setResponseLayout: (layout: ResponseLayout) => unknown;
  setThemeMode: (mode: AppThemeMode) => unknown;
  showWhatsNew: () => unknown;
};

const GROUP_ORDER: PaletteGroup[] = ['Request', 'Create', 'Go to', 'View', 'Help'];

export function buildPaletteCommands(ctx: PaletteContext): PaletteCommand[] {
  const commands: PaletteCommand[] = [
    { id: 'go-collections', group: 'Go to', label: 'Collections', keywords: 'sidebar requests tree', shortcut: 'go-collections', run: () => ctx.showSidebarView('collections') },
    { id: 'go-environments', group: 'Go to', label: 'Environments', keywords: 'variables env matrix', shortcut: 'go-environments', run: () => ctx.showSidebarView('environments') },
    { id: 'go-history', group: 'Go to', label: 'History', keywords: 'recent sent', shortcut: 'go-history', run: () => ctx.showSidebarView('history') },
    { id: 'go-globals', group: 'Go to', label: 'Globals', keywords: 'global variables', run: ctx.openGlobals },
    { id: 'go-runner', group: 'Go to', label: 'Collection runner', keywords: 'run tests iterations', shortcut: 'collection-runner', run: ctx.openCollectionRunner },
    { id: 'go-mock', group: 'Go to', label: 'Mock server', keywords: 'examples serve', run: ctx.openMockServer },
    { id: 'go-git', group: 'Go to', label: 'Git', keywords: 'commit branch pull push changes', run: ctx.openGit },
    { id: 'go-cookies', group: 'Go to', label: 'Cookies', keywords: 'cookie jar sync', run: ctx.openCookies },
    { id: 'go-settings', group: 'Go to', label: 'Settings', keywords: 'preferences options', shortcut: 'settings', run: () => ctx.runShortcut('settings') },
    { id: 'go-shortcuts', group: 'Go to', label: 'Keyboard shortcuts', keywords: 'keys bindings hotkeys', shortcut: 'shortcut-help', run: () => ctx.runShortcut('shortcut-help') },
    { id: 'go-proxy', group: 'Go to', label: 'Proxy settings', keywords: 'network http socks', run: () => ctx.openSettings('proxy') },
    { id: 'create-request', group: 'Create', label: 'New request', keywords: 'http rest sse', shortcut: 'new-request', run: () => ctx.runShortcut('new-request') },
    { id: 'create-request-graphql', group: 'Create', label: 'New GraphQL request', keywords: 'gql query', run: () => ctx.createRequest('graphql') },
    { id: 'create-request-ws', group: 'Create', label: 'New WebSocket request', keywords: 'ws realtime socket', run: () => ctx.createRequest('ws') },
    { id: 'create-request-socketio', group: 'Create', label: 'New Socket.IO request', keywords: 'sio realtime socket', run: () => ctx.createRequest('socketio') },
    { id: 'create-request-grpc', group: 'Create', label: 'New gRPC request', keywords: 'protobuf rpc', run: () => ctx.createRequest('grpc') },
    { id: 'create-request-mcp', group: 'Create', label: 'New MCP request', keywords: 'model context protocol tools', run: () => ctx.createRequest('mcp') },
    { id: 'create-request-ai', group: 'Create', label: 'New AI request', keywords: 'llm openai anthropic claude gpt chat model prompt', run: () => ctx.createRequest('ai') },
    { id: 'create-collection', group: 'Create', label: 'New collection', shortcut: 'new-collection', run: ctx.createCollection },
    { id: 'create-environment', group: 'Create', label: 'New environment', keywords: 'variables', run: ctx.createEnvironment },
    { id: 'import-collection', group: 'Create', label: 'Import collection…', keywords: 'postman insomnia bruno openapi har curl opencollection', shortcut: 'import-collection', run: ctx.importCollection },
  ];

  if (ctx.hasActiveRequest) {
    commands.push(
      { id: 'request-send', group: 'Request', label: 'Send request', keywords: 'run execute', shortcut: 'send-request', run: () => ctx.runShortcut('send-request') },
    );
    if (!ctx.autosave) {
      commands.push({ id: 'request-save', group: 'Request', label: 'Save request', shortcut: 'save-request', run: () => ctx.runShortcut('save-request') });
    }
    commands.push(
      { id: 'request-url', group: 'Request', label: 'Edit URL', keywords: 'focus address', shortcut: 'request-url', run: () => ctx.runShortcut('request-url') },
      { id: 'request-duplicate', group: 'Request', label: 'Duplicate request', keywords: 'copy clone', shortcut: 'duplicate-item', run: () => ctx.runShortcut('duplicate-item') },
      { id: 'request-rename', group: 'Request', label: 'Rename request', shortcut: 'rename-item', run: () => ctx.runShortcut('rename-item') },
    );
    if (ctx.canCopyCurl) {
      commands.push({ id: 'request-curl', group: 'Request', label: 'Copy as cURL', keywords: 'clipboard command line', shortcut: 'copy-curl', run: ctx.copyCurl });
    }
    if (ctx.findReplaceInCollection) {
      commands.push({ id: 'request-find-replace', group: 'Request', label: 'Find and replace in collection…', keywords: 'search rename rewrite bulk edit url host', shortcut: 'find-replace', run: ctx.findReplaceInCollection });
    }
    commands.push({ id: 'request-close', group: 'Request', label: 'Close tab', shortcut: 'close-tab', run: () => ctx.runShortcut('close-tab') });
  }
  commands.push({ id: 'request-reopen', group: 'Request', label: 'Reopen closed tab', keywords: 'restore undo', shortcut: 'reopen-tab', run: () => ctx.runShortcut('reopen-tab') });

  commands.push({
    id: 'view-sidebar',
    group: 'View',
    label: ctx.sidebarHidden ? 'Show sidebar' : 'Hide sidebar',
    keywords: 'toggle left panel',
    shortcut: 'toggle-left-sidebar',
    run: () => ctx.runShortcut('toggle-left-sidebar'),
  });
  if (ctx.codePanelAvailable) {
    commands.push({
      id: 'view-code',
      group: 'View',
      label: ctx.codePanelOpen ? 'Hide code snippet' : 'Show code snippet',
      keywords: 'toggle right panel curl generate',
      shortcut: 'toggle-right-sidebar',
      run: () => ctx.runShortcut('toggle-right-sidebar'),
    });
  }
  commands.push(
    { id: 'view-zoom-in', group: 'View', label: 'Zoom in', keywords: 'interface size scale bigger larger font text', shortcut: 'zoom-in', run: () => ctx.runShortcut('zoom-in') },
    { id: 'view-zoom-out', group: 'View', label: 'Zoom out', keywords: 'interface size scale smaller font text', shortcut: 'zoom-out', run: () => ctx.runShortcut('zoom-out') },
    { id: 'view-zoom-reset', group: 'View', label: 'Reset zoom', keywords: 'interface size scale actual default 100', shortcut: 'zoom-reset', run: () => ctx.runShortcut('zoom-reset') },
  );
  commands.push(ctx.responseLayout === 'right'
    ? { id: 'view-response-below', group: 'View', label: 'Show response below the request', keywords: 'layout split vertical bottom', shortcut: 'toggle-response-layout', run: () => ctx.setResponseLayout('below') }
    : { id: 'view-response-right', group: 'View', label: 'Show response beside the request', keywords: 'layout split horizontal right side', shortcut: 'toggle-response-layout', run: () => ctx.setResponseLayout('right') });

  const themes: { mode: AppThemeMode; label: string }[] = [
    { mode: 'light', label: 'Use light theme' },
    { mode: 'dark', label: 'Use dark theme' },
    { mode: 'system', label: 'Match system theme' },
  ];
  for (const theme of themes) {
    if (theme.mode === ctx.themeMode) continue;
    commands.push({ id: `theme-${theme.mode}`, group: 'View', label: theme.label, keywords: 'appearance colour color mode', run: () => ctx.setThemeMode(theme.mode) });
  }

  if (ctx.whatsNewAvailable) {
    commands.push({ id: 'help-whats-new', group: 'Help', label: "What's new", keywords: 'release notes changelog', run: ctx.showWhatsNew });
  }
  commands.push(
    { id: 'help-support', group: 'Help', label: 'Report an issue', keywords: 'support bug diagnostics logs', run: () => ctx.openSettings('support') },
    { id: 'help-about', group: 'Help', label: 'About Kurlo', keywords: 'version', run: () => ctx.openSettings('about') },
  );
  return GROUP_ORDER.flatMap(group => commands.filter(command => command.group === group));
}

export type PaletteQuery = { commandsOnly: boolean; text: string };

export function parsePaletteQuery(query: string): PaletteQuery {
  const trimmed = query.trimStart();
  if (trimmed.startsWith('>')) return { commandsOnly: true, text: trimmed.slice(1).trim().toLowerCase() };
  return { commandsOnly: false, text: query.trim().toLowerCase() };
}

function commandScore(command: PaletteCommand, text: string): number {
  const label = command.label.toLowerCase();
  if (label.startsWith(text)) return 0;
  if (label.split(/[\s./…-]+/).some(word => word.startsWith(text))) return 1;
  if (label.includes(text)) return 2;
  const haystack = `${label} ${command.group} ${command.keywords ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length && words.every(word => haystack.some(candidate => candidate.startsWith(word)))) return 3;
  return -1;
}

export function filterPaletteCommands(commands: PaletteCommand[], text: string): PaletteCommand[] {
  if (!text) return commands;
  return commands
    .map((command, index) => ({ command, index, score: commandScore(command, text) }))
    .filter(entry => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(entry => entry.command);
}
