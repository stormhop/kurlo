<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import AiConnectionsSettings from './AiConnectionsSettings.svelte';
  import Keycaps from './Keycaps.svelte';
  import Select from './Select.svelte';
  import { openExternalURL } from '../externalLinks';
  import { KURLO_REPO_URL } from '../starPrompt';
  import { vm } from '../stores/app.svelte';
  import { untrack } from 'svelte';
  import { tabListKeyboard, trapFocus } from '../a11y';
  import type { SettingsTab } from '../stores/ui';
  import type { UpdateInfo } from '../backend';
  import type { ProxyConfig, ProxyMode, ProxyProtocol, ScriptEngine, ShortcutId } from '../types/models';
  import type { StartupView } from '../startupView';
  import {
    DARK_THEME_VARIANTS,
    LIGHT_THEME_VARIANTS,
    type AppTheme,
    type AppThemeMode,
    type ThemeVariantId,
  } from '../theme';
  import { checkForUpdate, applyUpdate, restartApp, getAppInfo, diagnosticsReport, openLogFolder } from '../backend';
  import { clipboardCopy } from '../utils';
  import { cleanReleaseNotes } from '../releaseNotes';
  import ReleaseNotes from './ReleaseNotes.svelte';
  import ThemePreview from './ThemePreview.svelte';
  import AboutNight from './AboutNight.svelte';
  import { friendlyUpdateError } from '../updateErrors';
  import { shortcutComboLabel } from '../stores/features/preferences';

  let diagnosticsCopied = $state(false);
  let diagnosticsError = $state('');
  let logFolderError = $state('');
  let diagnosticsCopyTimer: ReturnType<typeof setTimeout> | null = null;

  async function copyDiagnostics() {
    diagnosticsError = '';
    try {
      const report = await diagnosticsReport();
      await clipboardCopy(report);
      diagnosticsCopied = true;
      if (diagnosticsCopyTimer) clearTimeout(diagnosticsCopyTimer);
      diagnosticsCopyTimer = setTimeout(() => { diagnosticsCopied = false; diagnosticsCopyTimer = null; }, 2400);
    } catch (error) {
      diagnosticsError = error instanceof Error ? error.message : String(error);
    }
  }

  async function revealLogFolder() {
    logFolderError = '';
    try {
      logFolderError = await openLogFolder();
    } catch (error) {
      logFolderError = error instanceof Error ? error.message : String(error);
    }
  }

  type ShortcutGroup = {
    name: string;
    items: Array<{ id: ShortcutId; label: string }>;
  };
  type UpdateState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'installing' | 'ready' | 'error';

  type SettingsNavItem = {
    id: SettingsTab;
    label: string;
    keywords: string;
  };

  function inputValue(event: Event): string {
    return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value : '';
  }

  function inputChecked(event: Event): boolean {
    return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.checked : false;
  }

  const NAV_ITEMS: SettingsNavItem[] = [
    { id: 'general', label: 'General', keywords: 'general on launch startup start screen open request overview restore saving autosave manual save default location workspace collection folder data export import backup script engine javascript tengo' },
    { id: 'theme', label: 'Theme', keywords: 'theme appearance dark light system color scheme' },
    { id: 'proxy', label: 'Proxy', keywords: 'proxy http https socks5 system bypass network hostname port credentials' },
    { id: 'ai', label: 'AI', keywords: 'ai agent model llm openrouter anthropic claude openai gpt key api byok ollama lm studio local connection' },
    { id: 'shortcuts', label: 'Shortcuts', keywords: 'shortcuts keybindings keyboard hotkeys' },
    { id: 'support', label: 'Support', keywords: 'support report issues bug github questions telegram help' },
    { id: 'about', label: 'About', keywords: 'updates check upgrade release notes about version platform runtime auto update install' },
  ];

  let {
    settingsTab = $bindable<SettingsTab>('general'),
    shortcutCaptureMessage,
    shortcutEditingId,
    appRuntime = '',
    appTheme,
    autosave,
    startupView,
    setStartupView,
    scriptEngine,
    setScriptEngine,
    shortcutGroups,
    shortcutCombo,
    startShortcutCapture,
    resetShortcut,
    resetAllShortcuts,
    setThemeMode,
    setThemeVariant,
    proxyConfig,
    setProxyConfig,
    setAutosave,
    defaultWorkspaceLocationDraft,
    defaultWorkspaceLocationStatus,
    setDefaultWorkspaceLocationDraft,
    saveDefaultWorkspaceLocation,
    browseDefaultWorkspaceLocation,
    exportAllData,
    importAllData,
    dataTransferStatus,
    onClose,
    startupUpdateInfo = null,
    startupUpdateReady = false,
    autoUpdateInstall = false,
    autoUpdateInstalling = false,
    setAutoUpdateInstall,
    onUpdateInstalled = () => {},
    whatsNewAvailable = false,
    onShowWhatsNew = () => {},
  }: {
    settingsTab: SettingsTab;
    shortcutCaptureMessage: string;
    shortcutEditingId: string;
    appRuntime?: string;
    appTheme: AppTheme;
    autosave: boolean;
    startupView: StartupView;
    setStartupView: (value: StartupView) => void;
    scriptEngine: ScriptEngine;
    setScriptEngine: (value: ScriptEngine) => void;
    shortcutGroups: () => ShortcutGroup[];
    shortcutCombo: (id: ShortcutId) => string;
    startShortcutCapture: (id: ShortcutId) => void;
    resetShortcut: (id: ShortcutId) => void;
    resetAllShortcuts: () => void;
    setThemeMode: (mode: AppThemeMode) => void;
    setThemeVariant: (id: ThemeVariantId) => void;
    proxyConfig: ProxyConfig;
    setProxyConfig: (next: ProxyConfig) => void;
    setAutosave: (value: boolean) => void;
    defaultWorkspaceLocationDraft: string;
    defaultWorkspaceLocationStatus: string;
    setDefaultWorkspaceLocationDraft: (path: string) => void;
    saveDefaultWorkspaceLocation: () => Promise<void> | void;
    browseDefaultWorkspaceLocation: () => Promise<void> | void;
    exportAllData: () => Promise<void> | void;
    importAllData: () => Promise<void> | void;
    dataTransferStatus: string;
    onClose: () => void;
    startupUpdateInfo?: UpdateInfo | null;
    startupUpdateReady?: boolean;
    autoUpdateInstall?: boolean;
    autoUpdateInstalling?: boolean;
    setAutoUpdateInstall: (value: boolean) => void;
    onUpdateInstalled?: (info: UpdateInfo) => void;
    whatsNewAvailable?: boolean;
    onShowWhatsNew?: () => void;
  } = $props();

  const UPDATE_READY_KEY = 'kurlo:update-ready';

  const _pendingRestart = localStorage.getItem(UPDATE_READY_KEY);
  const _initialUpdate = untrack(() => startupUpdateInfo);
  const _initialUpdateReady = untrack(() => startupUpdateReady);
  const _initialAutoUpdateInstalling = untrack(() => autoUpdateInstalling);
  let updateState = $state<UpdateState>(
    _pendingRestart || _initialUpdateReady ? 'ready' : (_initialAutoUpdateInstalling ? 'installing' : (_initialUpdate ? 'available' : 'idle'))
  );
  let updateInfo = $state<UpdateInfo | null>(_initialUpdate ?? null);
  let updateError = $state('');
  let manualUpdateInstalling = $state(false);
  let currentVersion = $state('');
  let packagedInstall = $state(false);
  let isDevBuild = $derived(currentVersion === 'dev');
  let manualUpdateURL = $derived(updateInfo?.manualInstallUrl ?? '');


  let settingsQuery = $state('');
  let saveShortcut = $derived(shortcutComboLabel(shortcutCombo('save-request'), appRuntime));
  let normalizedQuery = $derived(settingsQuery.trim().toLowerCase());
  let filteredNav = $derived(
    !normalizedQuery
      ? NAV_ITEMS
      : NAV_ITEMS.filter(item =>
          item.label.toLowerCase().includes(normalizedQuery) ||
          item.keywords.toLowerCase().includes(normalizedQuery),
        ),
  );

  function matchesQuery(...needles: string[]): boolean {
    if (!normalizedQuery) return true;
    return needles.some(n => n.toLowerCase().includes(normalizedQuery));
  }


  const STARTUP_VIEW_OPTIONS: Array<{ value: StartupView; title: string; detail: string }> = [
    { value: 'request', title: 'Request editor', detail: 'Opens your tabs on the request editor, or a new request when there are none' },
    { value: 'restore', title: 'Where you left off', detail: 'Reopens the last screen: Git, the runner, a collection or the overview' },
    { value: 'overview', title: 'Workspace overview', detail: 'Starts on collections, history and storage for the workspace' },
  ];


  type AboutInfo = { version: string; platform: string; arch: string; runtime: string };
  type NavigatorWithUAData = Navigator & {
    userAgentData: {
      getHighEntropyValues: (hints: string[]) => Promise<{ architecture: string }>;
    };
  };

  let aboutInfo = $state<AboutInfo | null>(null);

  function hasUAData(nav: Navigator): nav is NavigatorWithUAData {
    return 'userAgentData' in nav;
  }

  function rememberCurrentVersion(version: string, packaged = false) {
    currentVersion = version;
    packagedInstall = packaged;
    const pendingReadyVersion = localStorage.getItem(UPDATE_READY_KEY);
    if (pendingReadyVersion && pendingReadyVersion === version) {
      localStorage.removeItem(UPDATE_READY_KEY);
      if (updateState === 'ready') updateState = 'idle';
    }
  }

  $effect(() => {
    if (settingsTab === 'about' && !currentVersion) {
      void getAppInfo().then(info => { rememberCurrentVersion(info.version, info.packaged); });
    }
    if (settingsTab === 'about' && !aboutInfo) {
      void (async () => {
        const info = await getAppInfo();
        rememberCurrentVersion(info.version, info.packaged);
        const platformKey = document.documentElement.dataset.platform ?? '';
        const platformLabel: Record<string, string> = { darwin: 'macOS', windows: 'Windows', linux: 'Linux' };
        let arch = 'unknown';
        try {
          if (hasUAData(navigator)) {
            const ua = await navigator.userAgentData.getHighEntropyValues(['architecture']);
            arch = ua.architecture || arch;
          } else {
            const ua = navigator.userAgent;
            if (/arm64|aarch64/i.test(ua)) arch = 'arm64';
            else if (/x86_64|x64|amd64|WOW64/i.test(ua)) arch = 'x86_64';
          }
        } catch {}
        aboutInfo = {
          version: info.version,
          platform: platformLabel[platformKey] ?? platformKey,
          arch,
          runtime: info.goVersion,
        };
      })();
    }
  });

  $effect(() => {
    const info = startupUpdateInfo;
    if (info) updateInfo = info;

    if (startupUpdateReady && info) {
      updateError = '';
      updateState = 'ready';
      return;
    }
    if (autoUpdateInstalling && info) {
      updateError = '';
      updateState = 'installing';
      return;
    }
    if (info && updateState === 'installing' && !manualUpdateInstalling) {
      updateState = 'available';
      return;
    }
    if (info && updateState === 'idle') {
      updateState = 'available';
    }
  });

  async function handleCheck() {
    if (isDevBuild) return;
    updateState = 'checking';
    updateError = '';
    try {
      const result = await checkForUpdate();
      if (result.error) {
        updateError = friendlyUpdateError(result.error, 'check for updates');
        updateState = 'error';
      } else if (result.info) {
        updateInfo = result.info;
        updateState = 'available';
      } else {
        updateInfo = null;
        updateState = 'up-to-date';
      }
    } catch (err) {
      updateError = friendlyUpdateError(err instanceof Error ? err.message : String(err), 'check for updates');
      updateState = 'error';
    }
  }

  function handleDownload() {
    if (manualUpdateURL) openExternalURL(manualUpdateURL);
  }

  async function handleInstall() {
    if (isDevBuild) return;
    if (!updateInfo || updateInfo.manualInstallUrl) return;
    manualUpdateInstalling = true;
    updateState = 'installing';
    updateError = '';
    try {
      const err = await applyUpdate(updateInfo);
      if (err) {
        updateError = friendlyUpdateError(err, 'install the update');
        updateState = 'error';
      } else {
        localStorage.setItem(UPDATE_READY_KEY, updateInfo.version);
        onUpdateInstalled(updateInfo);
        updateState = 'ready';
      }
    } catch (err) {
      updateError = friendlyUpdateError(err instanceof Error ? err.message : String(err), 'install the update');
      updateState = 'error';
    } finally {
      manualUpdateInstalling = false;
    }
  }

  function handleRestart() {
    localStorage.removeItem(UPDATE_READY_KEY);
    void restartApp();
  }

  function handleAutoUpdateToggle(event: Event) {
    const enabled = inputChecked(event);
    setAutoUpdateInstall(enabled);
    if (enabled && updateState === 'available' && updateInfo && !updateInfo.manualInstallUrl && !isDevBuild) {
      void handleInstall();
    }
  }

  function handleDefaultLocationKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void saveDefaultWorkspaceLocation();
  }

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return '';
    }
  }

  let proxyPasswordVisible = $state(false);
  const PROXY_MODES: { value: ProxyMode; label: string }[] = [
    { value: 'off', label: 'Off' },
    { value: 'on', label: 'On' },
    { value: 'system', label: 'System' },
  ];
  const PROXY_PROTOCOLS: ProxyProtocol[] = ['http', 'https', 'socks5'];

  function updateProxy(patch: Partial<ProxyConfig>) {
    setProxyConfig({ ...proxyConfig, ...patch });
  }
  function updateProxyAuth(patch: Partial<ProxyConfig['auth']>) {
    setProxyConfig({ ...proxyConfig, auth: { ...proxyConfig.auth, ...patch } });
  }
  function proxyPortInput(event: Event) {
    const raw = inputValue(event);
    const value = Number(raw);
    updateProxy({ port: Number.isFinite(value) && value > 0 ? Math.floor(value) : 0 });
  }

</script>

{#snippet pageHead(title: string, desc: string)}
  <header class="settings-page-head">
    <div class="settings-page-head-text">
      <h3 class="settings-page-title">{title}</h3>
      <p class="settings-page-desc">{desc}</p>
    </div>
  </header>
{/snippet}

<div class="settings-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onClose()}>
  <div class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" tabindex="-1" use:trapFocus>
    <button class="btn btn-ghost btn-icon settings-close" type="button" onclick={onClose} aria-label="Close settings">
      <AddCloseIcon />
    </button>

    <div class="settings-layout">
      <nav class="settings-sidebar" aria-label="Settings navigation">
        <h2 class="settings-sidebar-title" id="settings-modal-title">Settings</h2>
        <div class="field field-wrap settings-search">
          <svg width="0.75rem" height="0.75rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
            <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          </svg>
          <input
            bind:value={settingsQuery}
            placeholder="Search…"
            spellcheck="false"
            aria-label="Search settings"
            type="search"
            data-autofocus
          />
        </div>
        <div class="settings-nav-list" role="tablist" aria-orientation="vertical" tabindex="-1" use:tabListKeyboard>
          {#each filteredNav as item (item.id)}
            <button
              class="settings-nav-item"
              class:active={settingsTab === item.id}
              class:settings-nav-about={item.id === 'about'}
              type="button"
              role="tab"
              aria-selected={settingsTab === item.id}
              aria-controls={`settings-panel-${item.id}`}
              tabindex={settingsTab === item.id ? 0 : -1}
              onclick={() => (settingsTab = item.id)}
            >
              {#if item.id === 'general'}
                <svg width="0.9375rem" height="0.9375rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                  <path d="M2 4.5h5.2M10.8 4.5H13M2 10.5h2.2M7.8 10.5H13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                  <circle cx="9" cy="4.5" r="1.8" stroke="currentColor" stroke-width="1.3"/>
                  <circle cx="6" cy="10.5" r="1.8" stroke="currentColor" stroke-width="1.3"/>
                </svg>
              {:else if item.id === 'theme'}
                <svg width="0.9375rem" height="0.9375rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                  <circle cx="7.5" cy="7.5" r="5.8" stroke="currentColor" stroke-width="1.3"/>
                  <path d="M7.5 1.7a5.8 5.8 0 010 11.6V1.7z" fill="currentColor"/>
                </svg>
              {:else if item.id === 'proxy'}
                <svg width="0.9375rem" height="0.9375rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                  <circle cx="7.5" cy="7.5" r="6" stroke="currentColor" stroke-width="1.3"/>
                  <path d="M1.5 7.5h12M7.5 1.5c2 2 2 10 0 12M7.5 1.5c-2 2-2 10 0 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                </svg>
              {:else if item.id === 'ai'}
                <svg width="0.9375rem" height="0.9375rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                  <path d="M6.5 2l1.2 3.3L11 6.5 7.7 7.7 6.5 11 5.3 7.7 2 6.5l3.3-1.2L6.5 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
                  <path d="M11.5 9.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5z" fill="currentColor"/>
                </svg>
              {:else if item.id === 'shortcuts'}
                <svg width="0.9375rem" height="0.9375rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                  <rect x="1.5" y="3.5" width="12" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
                  <rect x="3.5" y="5.5" width="1.5" height="1.5" rx="0.3" fill="currentColor"/>
                  <rect x="7" y="5.5" width="1.5" height="1.5" rx="0.3" fill="currentColor"/>
                  <rect x="10" y="5.5" width="1.5" height="1.5" rx="0.3" fill="currentColor"/>
                  <rect x="3.5" y="8" width="1.5" height="1.5" rx="0.3" fill="currentColor"/>
                  <rect x="6.25" y="8" width="3" height="1.5" rx="0.3" fill="currentColor"/>
                  <rect x="10" y="8" width="1.5" height="1.5" rx="0.3" fill="currentColor"/>
                </svg>
              {:else if item.id === 'support'}
                <svg width="0.9375rem" height="0.9375rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                  <path d="M2.2 6.8c0-2.8 2.2-4.8 5.3-4.8s5.3 2 5.3 4.8-2.2 4.8-5.3 4.8c-.7 0-1.4-.1-2-.3l-2.4 1 .7-2.1c-1-.9-1.6-2-1.6-3.4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
                  <path d="M5.4 6h4.2M5.4 8.3h2.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                </svg>
              {:else if item.id === 'about'}
                <svg width="0.9375rem" height="0.9375rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                  <circle cx="7.5" cy="7.5" r="6.5" stroke="currentColor" stroke-width="1.3"/>
                  <path d="M7.5 6.5v5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                  <circle cx="7.5" cy="4.5" r="0.8" fill="currentColor"/>
                </svg>
              {/if}
              {item.label}
            </button>
          {/each}
          {#if filteredNav.length === 0}
            <p class="settings-nav-empty">No settings match "{settingsQuery}"</p>
          {/if}
        </div>
      </nav>

      {#if settingsTab === 'shortcuts'}
        <div class="settings-body" id="settings-panel-shortcuts" role="tabpanel">
          <header class="settings-page-head">
            <div class="settings-page-head-text">
              <h3 class="settings-page-title">Shortcuts</h3>
              <p class="settings-page-desc" aria-live="polite">{shortcutCaptureMessage || 'Click a shortcut to record a new combination.'}</p>
            </div>
            <button class="btn btn-secondary" type="button" onclick={resetAllShortcuts}>Reset all</button>
          </header>
          <div class="shortcut-list">
            {#each shortcutGroups() as group, eachIndex (eachIndex)}
              <section class="settings-block shortcut-group">
                <h3 class="settings-group-label">{group.name}</h3>
                <div class="settings-group">
                  {#each group.items as shortcut, eachIndex (eachIndex)}
                    <div class="settings-row shortcut-row" class:editing={shortcutEditingId === shortcut.id}>
                      <span class="settings-row-title">{shortcut.label}</span>
                      <div class="shortcut-controls">
                        <button class="shortcut-combo" type="button" onclick={() => startShortcutCapture(shortcut.id)}>
                          {#if shortcutEditingId === shortcut.id}
                            <span class="shortcut-recording">Recording...</span>
                          {:else}
                            {#if shortcutCombo(shortcut.id)}
                              <Keycaps combo={shortcutCombo(shortcut.id)} runtime={appRuntime} size="md" />
                            {:else}
                              <span class="shortcut-unassigned">Unassigned</span>
                            {/if}
                          {/if}
                        </button>
                        <button class="btn btn-ghost btn-icon btn-sm shortcut-reset" type="button" onclick={() => resetShortcut(shortcut.id)} aria-label="Reset shortcut">↺</button>
                      </div>
                    </div>
                  {/each}
                </div>
              </section>
            {/each}
          </div>
        </div>
      {/if}

      {#if settingsTab === 'theme'}
        <div class="settings-body settings-theme" id="settings-panel-theme" role="tabpanel">
          {@render pageHead('Theme', 'Light, dark or following the system, with a palette for each.')}
          <section class="settings-block">
            <div class="settings-group">
              <div class="settings-row">
                <div class="settings-row-text">
                  <span class="settings-row-title">Mode</span>
                  <span class="settings-row-desc">{appTheme.mode === 'system' ? 'Switches between your light and dark theme with the system.' : appTheme.mode === 'dark' ? 'Always uses your dark theme.' : 'Always uses your light theme.'}</span>
                </div>
                <div class="settings-row-control">
                  <div class="segmented theme-mode-options" role="group" aria-label="Theme mode">
                  <button class="segmented-item theme-mode-option" class:active={appTheme.mode === 'light'} type="button" aria-pressed={appTheme.mode === 'light'} onclick={() => setThemeMode('light')}>
                    <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
                    <span>Light</span>
                  </button>
                  <button class="segmented-item theme-mode-option" class:active={appTheme.mode === 'dark'} type="button" aria-pressed={appTheme.mode === 'dark'} onclick={() => setThemeMode('dark')}>
                    <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.2 10.5A5.8 5.8 0 015.5 2.8 6.2 6.2 0 1013.2 10.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
                    <span>Dark</span>
                  </button>
                  <button class="segmented-item theme-mode-option" class:active={appTheme.mode === 'system'} type="button" aria-pressed={appTheme.mode === 'system'} onclick={() => setThemeMode('system')}>
                    <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.2" y="3" width="11.6" height="8" rx="1.2" stroke="currentColor" stroke-width="1.4"/><path d="M6 14h4M8 11v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
                    <span>System</span>
                  </button>
                  </div>
                </div>
              </div>
            </div>
          </section>
            <section class="settings-block theme-section">
              <h4 class="settings-group-label">Light theme</h4>
              <div class="theme-variant-grid">
                {#each LIGHT_THEME_VARIANTS as variant, eachIndex (eachIndex)}
                  <button
                    class="option-card theme-variant-card"
                    class:active={appTheme.light === variant.id}
                    type="button"
                    aria-pressed={appTheme.light === variant.id}
                    onclick={() => setThemeVariant(variant.id)}
                  >
                    <div class="theme-card-preview" aria-hidden="true">
                      <ThemePreview variant={variant.id} />
                    </div>
                    <span class="theme-variant-name">{variant.name}</span>
                    <span class="theme-card-check" aria-hidden="true">
                    <svg width="0.6875rem" height="0.6875rem" viewBox="0 0 12 12" fill="none">
                      <path d="M2.5 6.3l2.4 2.4 4.6-4.9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </span>
                  </button>
                {/each}
              </div>
            </section>
            <section class="settings-block theme-section">
              <h4 class="settings-group-label">Dark theme</h4>
              <div class="theme-variant-grid">
                {#each DARK_THEME_VARIANTS as variant, eachIndex (eachIndex)}
                  <button
                    class="option-card theme-variant-card"
                    class:active={appTheme.dark === variant.id}
                    type="button"
                    aria-pressed={appTheme.dark === variant.id}
                    onclick={() => setThemeVariant(variant.id)}
                  >
                    <div class="theme-card-preview" aria-hidden="true">
                      <ThemePreview variant={variant.id} />
                    </div>
                    <span class="theme-variant-name">{variant.name}</span>
                    <span class="theme-card-check" aria-hidden="true">
                    <svg width="0.6875rem" height="0.6875rem" viewBox="0 0 12 12" fill="none">
                      <path d="M2.5 6.3l2.4 2.4 4.6-4.9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </span>
                  </button>
                {/each}
              </div>
            </section>
        </div>
      {/if}

      {#if settingsTab === 'proxy'}
        <div class="settings-body settings-proxy" id="settings-panel-proxy" role="tabpanel">
          {@render pageHead('Proxy', 'Applied to every request Kurlo sends. A request or collection proxy URL overrides it.')}
          <section class="settings-block">
            <div class="settings-group">
              <div class="settings-row">
                <div class="settings-row-text">
                  <span class="settings-row-title" id="proxy-mode-title">Proxy</span>
                  <span class="settings-row-desc">{proxyConfig.mode === 'on' ? 'Requests go through the server below.' : proxyConfig.mode === 'system' ? 'Requests use the proxy set in your system settings.' : 'Requests connect directly.'}</span>
                </div>
                <div class="settings-row-control">
                  <div class="segmented proxy-radio-group" role="radiogroup" aria-label="Proxy mode">
                    {#each PROXY_MODES as option, eachIndex (eachIndex)}
                      <label class="segmented-item proxy-radio">
                        <input type="radio" name="proxy-mode" value={option.value} checked={proxyConfig.mode === option.value} onchange={() => updateProxy({ mode: option.value })} />
                        <span>{option.label}</span>
                      </label>
                    {/each}
                  </div>
                </div>
              </div>
            </div>
          </section>

          {#if proxyConfig.mode === 'on'}
            <section class="settings-block">
              <h4 class="settings-group-label">Server</h4>
              <div class="settings-group">
                <div class="settings-row">
                  <div class="settings-row-text"><span class="settings-row-title">Protocol</span></div>
                  <div class="settings-row-control">
                    <div class="segmented proxy-radio-group" role="radiogroup" aria-label="Proxy protocol">
                      {#each PROXY_PROTOCOLS as protocol, eachIndex (eachIndex)}
                        <label class="segmented-item proxy-radio">
                          <input type="radio" name="proxy-protocol" value={protocol} checked={proxyConfig.protocol === protocol} onchange={() => updateProxy({ protocol })} />
                          <span>{protocol.toUpperCase()}</span>
                        </label>
                      {/each}
                    </div>
                  </div>
                </div>
                <div class="settings-row">
                  <div class="settings-row-text">
                    <label class="settings-row-title" for="proxy-hostname">Address</label>
                    <span class="settings-row-desc">Host name and port of the proxy.</span>
                  </div>
                  <div class="settings-row-control">
                    <input id="proxy-hostname" class="field proxy-input" type="text" spellcheck="false" autocomplete="off" placeholder="proxy.example.com" aria-label="Hostname" value={proxyConfig.hostname} oninput={(event) => updateProxy({ hostname: inputValue(event) })} />
                    <input id="proxy-port" class="field proxy-input proxy-input-sm" type="number" min="0" max="65535" step="1" placeholder="Port" aria-label="Port" value={proxyConfig.port || ''} oninput={proxyPortInput} />
                  </div>
                </div>
                <div class="settings-row">
                  <div class="settings-row-text">
                    <label class="settings-row-title" for="proxy-bypass">Bypass</label>
                    <span class="settings-row-desc">Hosts that connect directly, separated by commas.</span>
                  </div>
                  <div class="settings-row-control">
                    <input id="proxy-bypass" class="field proxy-input" type="text" spellcheck="false" autocomplete="off" placeholder="localhost, 127.0.0.1, .internal" value={proxyConfig.bypass} oninput={(event) => updateProxy({ bypass: inputValue(event) })} />
                  </div>
                </div>
              </div>
              {#if !proxyConfig.hostname.trim()}
                <p class="settings-group-note error" role="alert">Add a host name: requests fail until there is one, and traffic is never sent directly.</p>
              {/if}
            </section>

            <section class="settings-block">
              <h4 class="settings-group-label">Authentication</h4>
              <div class="settings-group">
                <div class="settings-row">
                  <div class="settings-row-text">
                    <span class="settings-row-title">Requires sign-in</span>
                    <span class="settings-row-desc">Send a username and password to the proxy.</span>
                  </div>
                  <label class="switch-control" aria-label="Proxy requires sign-in">
                    <input type="checkbox" checked={proxyConfig.auth.enabled} onchange={(event) => updateProxyAuth({ enabled: inputChecked(event) })} />
                    <span class="switch-track"></span>
                    <span class="switch-state">{proxyConfig.auth.enabled ? 'ON' : 'OFF'}</span>
                  </label>
                </div>
                {#if proxyConfig.auth.enabled}
                  <div class="settings-row">
                    <div class="settings-row-text"><label class="settings-row-title" for="proxy-username">Username</label></div>
                    <div class="settings-row-control">
                      <input id="proxy-username" class="field proxy-input" type="text" spellcheck="false" autocomplete="off" value={proxyConfig.auth.username} oninput={(event) => updateProxyAuth({ username: inputValue(event) })} />
                    </div>
                  </div>
                  <div class="settings-row">
                    <div class="settings-row-text"><label class="settings-row-title" for="proxy-password">Password</label></div>
                    <div class="settings-row-control">
                      <span class="proxy-password">
                        <input id="proxy-password" class="field proxy-input" type={proxyPasswordVisible ? 'text' : 'password'} autocomplete="off" value={proxyConfig.auth.password} oninput={(event) => updateProxyAuth({ password: inputValue(event) })} />
                        <button type="button" class="btn btn-ghost btn-icon btn-xs proxy-eye" aria-label={proxyPasswordVisible ? 'Hide password' : 'Show password'} onclick={() => (proxyPasswordVisible = !proxyPasswordVisible)}>
                          {#if proxyPasswordVisible}
                            <svg width="0.9375rem" height="0.9375rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 8s2.5-4.5 6-4.5S14 8 14 8s-2.5 4.5-6 4.5S2 8 2 8z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.8" stroke="currentColor" stroke-width="1.3"/><path d="M3 13L13 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
                          {:else}
                            <svg width="0.9375rem" height="0.9375rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 8s2.5-4.5 6-4.5S14 8 14 8s-2.5 4.5-6 4.5S2 8 2 8z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.8" stroke="currentColor" stroke-width="1.3"/></svg>
                          {/if}
                        </button>
                      </span>
                    </div>
                  </div>
                {/if}
              </div>
            </section>
          {/if}
        </div>
      {/if}

      {#if settingsTab === 'ai'}
        <AiConnectionsSettings />
      {/if}

      {#if settingsTab === 'general'}
        <div class="settings-body general-tab" id="settings-panel-general" role="tabpanel">
          {@render pageHead('General', 'How Kurlo saves your work, what it opens first and how scripts run.')}

          {#if matchesQuery('Saving', 'autosave', 'manual save', 'On launch', 'startup start screen open request overview restore')}
            <section class="settings-block">
              <h4 class="settings-group-label">Editing</h4>
              <div class="settings-group">
                {#if matchesQuery('Saving', 'autosave', 'manual save')}
                  <div class="settings-row">
                    <div class="settings-row-text">
                      <span class="settings-row-title" id="settings-saving-title">Saving</span>
                      <span class="settings-row-desc">
                        {#if autosave}
                          Changes save as you type.
                        {:else}
                          Changes wait until you press <Keycaps combo={shortcutCombo('save-request')} runtime={appRuntime} /> or Save; the tab shows a dot meanwhile.
                        {/if}
                      </span>
                    </div>
                    <div class="settings-row-control">
                      <div class="segmented" role="radiogroup" aria-labelledby="settings-saving-title">
                        <button class="segmented-item" type="button" role="radio" aria-checked={autosave} onclick={() => setAutosave(true)}>Autosave</button>
                        <button class="segmented-item" type="button" role="radio" aria-checked={!autosave} onclick={() => setAutosave(false)}>Manual save</button>
                      </div>
                    </div>
                  </div>
                {/if}
                {#if matchesQuery('On launch', 'startup start screen open request overview restore')}
                  <div class="settings-row">
                    <div class="settings-row-text">
                      <span class="settings-row-title">On launch</span>
                      <span class="settings-row-desc">{STARTUP_VIEW_OPTIONS.find(option => option.value === startupView)?.detail}. A workspace that needs attention opens where you can fix it.</span>
                    </div>
                    <div class="settings-row-control">
                      <Select value={startupView} options={STARTUP_VIEW_OPTIONS.map(option => ({ value: option.value, label: option.title }))} ariaLabel="On launch" className="settings-select" onChange={(value) => setStartupView(value as StartupView)} />
                    </div>
                  </div>
                {/if}
              </div>
            </section>
          {/if}

          {#if matchesQuery('Scripts', 'script engine javascript tengo pre-request tests')}
            <section class="settings-block">
              <h4 class="settings-group-label">Scripts</h4>
              <div class="settings-group">
                <div class="settings-row">
                  <div class="settings-row-text">
                    <span class="settings-row-title" id="settings-engine-title">Script engine</span>
                    <span class="settings-row-desc">{scriptEngine === 'js' ? 'Postman-style JavaScript: pm.test(), pm.expect().to.eql().' : 'Tengo: lightweight sandboxed scripting with pm.test(name, cond).'}</span>
                  </div>
                  <div class="settings-row-control">
                    <div class="segmented" role="radiogroup" aria-labelledby="settings-engine-title">
                      <button class="segmented-item" type="button" role="radio" aria-checked={scriptEngine === 'js'} onclick={() => setScriptEngine('js')}>JavaScript</button>
                      <button class="segmented-item" type="button" role="radio" aria-checked={scriptEngine === 'tengo'} onclick={() => setScriptEngine('tengo')}>Tengo</button>
                    </div>
                  </div>
                </div>
              </div>
              <p class="settings-group-note">Applies to all pre-request and test scripts. Each request keeps a script per engine, so switching never loses work.</p>
            </section>
          {/if}

          {#if matchesQuery('Default Location', 'workspace collection folder path documents kurlo')}
            <section class="settings-block">
              <h4 class="settings-group-label">Files</h4>
              <div class="settings-group">
                <div class="settings-row">
                  <div class="settings-row-text">
                    <label class="settings-row-title" for="settings-default-location">Default location</label>
                    <span class="settings-row-desc">New folder workspaces and exported collections go here.</span>
                  </div>
                  <div class="settings-row-block default-location-row">
                    <input class="field"
                      id="settings-default-location"
                      value={defaultWorkspaceLocationDraft}
                      spellcheck="false"
                      oninput={(event) => setDefaultWorkspaceLocationDraft(inputValue(event))}
                      onblur={() => saveDefaultWorkspaceLocation()}
                      onkeydown={handleDefaultLocationKeydown}
                      aria-describedby="settings-default-location-help"
                    />
                    <button class="btn btn-secondary" type="button" onclick={browseDefaultWorkspaceLocation}>Browse</button>
                    <button class="btn btn-secondary" type="button" onclick={() => saveDefaultWorkspaceLocation()}>Save</button>
                  </div>
                </div>
              </div>
              <p
                id="settings-default-location-help"
                class="settings-group-note"
                class:error={defaultWorkspaceLocationStatus && defaultWorkspaceLocationStatus !== 'Default location saved'}
                hidden={!defaultWorkspaceLocationStatus}
              >{defaultWorkspaceLocationStatus}</p>
            </section>
          {/if}

          {#if matchesQuery('Data', 'export', 'import', 'backup')}
            <section class="settings-block">
              <h4 class="settings-group-label">Data</h4>
              <div class="settings-group">
                <div class="settings-row">
                  <div class="settings-row-text">
                    <span class="settings-row-title">Export all data</span>
                    <span class="settings-row-desc">Every workspace, collection, environment and request in one file. Safe to run any time.</span>
                  </div>
                  <div class="settings-row-control">
                    <button class="btn btn-secondary" type="button" onclick={exportAllData}>Export all data</button>
                  </div>
                </div>
                <div class="settings-row">
                  <div class="settings-row-text">
                    <span class="settings-row-title">Import all data</span>
                    <span class="settings-row-desc">Replaces every workspace, collection, environment and request in this profile.</span>
                  </div>
                  <div class="settings-row-control">
                    <button class="btn btn-secondary btn-danger" type="button" onclick={importAllData}>Import all data</button>
                  </div>
                </div>
              </div>
              {#if dataTransferStatus}
                <p class="settings-group-note">{dataTransferStatus}</p>
              {/if}
            </section>
          {/if}
        </div>
      {/if}

      {#if settingsTab === 'support'}
        <div class="settings-body support-tab" id="settings-panel-support" role="tabpanel">
          {@render pageHead('Support', 'Report bugs, ask questions and collect what helps us fix them.')}

          <div class="settings-group support-actions">
            <button class="settings-row support-link-card" type="button" onclick={() => { openExternalURL(KURLO_REPO_URL); vm.closeStarPrompt(); }}>
              <span class="support-link-icon" aria-hidden="true">
                <svg width="1.0625rem" height="1.0625rem" viewBox="0 0 16 16" fill="none">
                  <path d="M8 1.9l1.85 3.75 4.15.6-3 2.92.71 4.13L8 11.35l-3.71 1.95.71-4.13-3-2.92 4.15-.6L8 1.9z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
                </svg>
              </span>
              <span class="support-link-copy">
                <span class="support-link-title">Star Kurlo on GitHub</span>
                <span class="support-link-meta">Free and open source; a star helps other people find it</span>
              </span>
              <svg width="0.6875rem" height="0.6875rem" viewBox="0 0 10 10" fill="none" aria-hidden="true" class="support-link-arrow">
                <path d="M2 8L8 2M8 2H4M8 2v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>

            <button class="settings-row support-link-card" type="button" onclick={() => openExternalURL('https://github.com/stormhop/kurlo/issues')}>
              <span class="support-link-icon" aria-hidden="true">
                <svg width="1.0625rem" height="1.0625rem" viewBox="0 0 18 18" fill="none">
                  <circle cx="9" cy="9" r="6.5" stroke="currentColor" stroke-width="1.4"/>
                  <path d="M9 5.4v4.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                  <circle cx="9" cy="12.2" r="0.8" fill="currentColor"/>
                </svg>
              </span>
              <span class="support-link-copy">
                <span class="support-link-title">Report issues</span>
                <span class="support-link-meta">github.com/stormhop/kurlo/issues</span>
              </span>
              <svg width="0.6875rem" height="0.6875rem" viewBox="0 0 10 10" fill="none" aria-hidden="true" class="support-link-arrow">
                <path d="M2 8L8 2M8 2H4M8 2v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>

            <button class="settings-row support-link-card" type="button" onclick={() => openExternalURL('https://github.com/stormhop/kurlo/issues/new')}>
              <span class="support-link-icon" aria-hidden="true">
                <svg width="1.0625rem" height="1.0625rem" viewBox="0 0 24 24" fill="none">
                  <path d="M21.8 2.2L1.2 10.1c-1.4.6-1.3 1.5-.2 1.9l5.2 1.6 2 6.3c.3.8.6.9 1 .6l2.7-2.6 5.2 3.9c1 .5 1.6.3 1.9-.9L22.9 3.6c.4-1.5-.5-2.1-1.1-1.4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                </svg>
              </span>
              <span class="support-link-copy">
                <span class="support-link-title">Questions</span>
                <span class="support-link-meta">github.com/stormhop/kurlo/issues/new</span>
              </span>
              <svg width="0.6875rem" height="0.6875rem" viewBox="0 0 10 10" fill="none" aria-hidden="true" class="support-link-arrow">
                <path d="M2 8L8 2M8 2H4M8 2v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>

            <button class="settings-row support-link-card" type="button" onclick={copyDiagnostics}>
              <span class="support-link-icon" aria-hidden="true">
                <svg width="1.0625rem" height="1.0625rem" viewBox="0 0 18 18" fill="none">
                  <rect x="6" y="2.5" width="9.5" height="12" rx="2" stroke="currentColor" stroke-width="1.4"/>
                  <path d="M12 15.5H4.5a2 2 0 0 1-2-2V5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                </svg>
              </span>
              <span class="support-link-copy">
                <span class="support-link-title">{diagnosticsCopied ? 'Diagnostics copied' : 'Copy diagnostics'}</span>
                <span class="support-link-meta">
                  {#if diagnosticsError}
                    {diagnosticsError}
                  {:else}
                    Version, platform, Git and storage — paste into an issue
                  {/if}
                </span>
              </span>
            </button>

            <button class="settings-row support-link-card" type="button" onclick={revealLogFolder}>
              <span class="support-link-icon" aria-hidden="true">
                <svg width="1.0625rem" height="1.0625rem" viewBox="0 0 18 18" fill="none">
                  <path d="M2.5 5.2c0-.9.7-1.6 1.6-1.6h2.6l1.5 1.7h5.7c.9 0 1.6.7 1.6 1.6v6.3c0 .9-.7 1.6-1.6 1.6H4.1a1.6 1.6 0 0 1-1.6-1.6V5.2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
                </svg>
              </span>
              <span class="support-link-copy">
                <span class="support-link-title">Open log folder</span>
                <span class="support-link-meta">
                  {#if logFolderError}
                    {logFolderError}
                  {:else}
                    Attach kurlo.log when something went wrong
                  {/if}
                </span>
              </span>
            </button>
          </div>
        </div>
      {/if}

      {#if settingsTab === 'about'}
        <div class="settings-body about-tab" id="settings-panel-about" role="tabpanel">
          <div class="about-hero">
            <AboutNight />
            <h3 class="about-name">Kurlo</h3>
            {#if aboutInfo}
              <p class="about-meta">Version {aboutInfo.version} · {aboutInfo.platform}</p>
            {:else}
              <span class="updates-spinner about-loading" aria-hidden="true"></span>
            {/if}
          </div>

          <div class="settings-group about-list">
            <div class="settings-row about-item about-update-row" aria-live="polite">
              <span class="about-item-copy">
                {#if isDevBuild}
                  <strong>Development build</strong>
                  <span>Updates come with release builds.</span>
                {:else if updateState === 'checking'}
                  <strong>Checking for updates…</strong>
                  <span>This takes a few seconds.</span>
                {:else if updateState === 'up-to-date'}
                  <strong class="updates-inline">
                    <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 15 15" fill="none" aria-hidden="true" class="updates-ok-icon">
                      <circle cx="7.5" cy="7.5" r="6.5" stroke="currentColor" stroke-width="1.3"/>
                      <path d="M4.5 7.5l2 2 4-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    You're up to date
                  </strong>
                  <span>Kurlo {currentVersion} is the latest version.</span>
                {:else if updateState === 'available' && updateInfo}
                  <strong>Kurlo {updateInfo.version} is available</strong>
                  <span>{updateInfo.publishedAt ? `Released ${formatDate(updateInfo.publishedAt)}` : 'A new version is ready to install.'}</span>
                {:else if updateState === 'installing'}
                  <strong>Installing update…</strong>
                  <span>Downloading{updateInfo ? ` Kurlo ${updateInfo.version}` : ''} in the background.</span>
                {:else if updateState === 'ready'}
                  <strong class="updates-inline">
                    <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 15 15" fill="none" aria-hidden="true" class="updates-ok-icon">
                      <circle cx="7.5" cy="7.5" r="6.5" stroke="currentColor" stroke-width="1.3"/>
                      <path d="M4.5 7.5l2 2 4-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    Update installed
                  </strong>
                  <span>Restart Kurlo to apply it.</span>
                {:else if updateState === 'error'}
                  <strong>Couldn't update</strong>
                  <span class="updates-error-text">{updateError}</span>
                {:else}
                  <strong>Updates</strong>
                  <span>Kurlo also checks in the background.</span>
                {/if}
              </span>
              {#if !isDevBuild}
                {#if updateState === 'idle'}
                  <button class="btn btn-secondary" type="button" onclick={handleCheck}>Check for updates</button>
                {:else if updateState === 'up-to-date'}
                  <button class="btn btn-secondary" type="button" onclick={handleCheck}>Check again</button>
                {:else if updateState === 'available' && updateInfo && manualUpdateURL}
                  <button class="btn btn-primary" type="button" onclick={handleDownload}>Download</button>
                {:else if updateState === 'available' && updateInfo}
                  <button class="btn btn-primary" type="button" onclick={handleInstall}>Install</button>
                {:else if updateState === 'ready'}
                  <button class="btn btn-primary" type="button" onclick={handleRestart}>Restart now</button>
                {:else if updateState === 'error'}
                  <button class="btn btn-secondary" type="button" onclick={handleCheck}>Try again</button>
                {:else}
                  <span class="updates-spinner" aria-hidden="true"></span>
                {/if}
              {/if}
            </div>
            <div class="settings-row about-item">
              <span class="about-item-copy">
                <strong>Install updates automatically</strong>
                <span>{packagedInstall ? 'Not available for the Windows app package.' : 'New builds install in the background, then Kurlo asks for a restart.'}</span>
              </span>
              <label class="switch-control" aria-label="Install updates automatically">
                <input
                  type="checkbox"
                  checked={autoUpdateInstall && !packagedInstall}
                  disabled={isDevBuild || packagedInstall || updateState === 'installing'}
                  onchange={handleAutoUpdateToggle}
                />
                <span class="switch-track"></span>
                <span class="switch-state">{autoUpdateInstall && !packagedInstall ? 'ON' : 'OFF'}</span>
              </label>
            </div>
            {#if whatsNewAvailable}
              <button class="settings-row about-item about-item-link" type="button" onclick={onShowWhatsNew}>
                <span class="about-item-copy">
                  <strong>What's new</strong>
                  <span>Release notes for this build</span>
                </span>
                <svg width="0.75rem" height="0.75rem" viewBox="0 0 14 14" fill="none" aria-hidden="true" class="about-item-chevron">
                  <path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            {/if}
          </div>
          {#if isDevBuild}
            <p class="about-update-note">
              Local <code>make dev</code> or <code>go run</code> builds don't update. Install a release from the <a href="https://github.com/stormhop/kurlo/releases/latest" onclick={(e) => { e.preventDefault(); openExternalURL('https://github.com/stormhop/kurlo/releases/latest'); }}>releases page</a>.
            </p>
          {:else if updateState === 'available' && updateInfo}
            {#if manualUpdateURL}
              <p class="about-update-note">Windows keeps the app package read-only, so Kurlo can't update itself. Download the new <code>.msix</code> and open it to upgrade in place.</p>
            {/if}
            {#if cleanReleaseNotes(updateInfo.releaseNotes)}
              <div class="updates-notes">
                <p class="settings-group-label">What's new in {updateInfo.version}</p>
                <ReleaseNotes body={cleanReleaseNotes(updateInfo.releaseNotes)} />
              </div>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .updates-inline {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }





  .updates-ok-icon {
    color: var(--s2xx);
    flex-shrink: 0;
  }

  .updates-spinner {
    width: 0.75rem;
    height: 0.75rem;
    border: 1.5px solid var(--border);
    border-top-color: var(--text-2);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .updates-spinner {
      animation-duration: 2s;
    }
  }

  .updates-notes {
    display: flex;
    flex-direction: column;
    gap: var(--space-2-5);
    box-sizing: border-box;
    width: 100%;
    max-width: 26.25rem;
    margin-top: var(--space-5);
  }

  .about-item-copy .updates-error-text {
    color: var(--delete);
  }

  .settings-search {
    margin: 0 var(--space-1-5) var(--space-2);
    color: var(--text-3);
  }

  .settings-search input {
    flex: 1;
    min-width: 0;
    width: 100%;
    text-overflow: ellipsis;
  }

  .settings-search input::placeholder {
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
  }

  .settings-search input::-webkit-search-cancel-button {
    -webkit-appearance: none;
    height: 0.75rem;
    width: 0.75rem;
    background: var(--text-3);
    -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M3 3l6 6M9 3l-6 6' stroke='black' stroke-width='1.5' stroke-linecap='round'/></svg>") no-repeat center / contain;
    cursor: pointer;
  }

  .settings-nav-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-0-5);
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .settings-nav-empty {
    margin: var(--space-2) var(--space-2-5);
    font-size: var(--text-label);
    color: var(--text-3);
    line-height: var(--leading-normal);
  }

  .theme-mode-option {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .theme-mode-option svg {
    flex-shrink: 0;
    opacity: 0.8;
  }

  .theme-mode-option.active svg {
    opacity: 1;
  }

  .theme-variant-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9.75rem, 1fr));
    gap: var(--space-3);
  }

  .theme-variant-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-2-5);
    padding: var(--space-2-5);
  }



  .theme-card-preview {
    position: relative;
    display: block;
    width: 100%;
    flex: 0 0 auto;
    container-type: inline-size;
    aspect-ratio: 16 / 10;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    overflow: hidden;
    isolation: isolate;
  }

  .theme-variant-name {
    display: flex;
    align-items: center;
    min-height: 1rem;
    padding: 0 var(--space-5) 0 var(--space-0-5);
    font-size: var(--text-body);
    font-weight: var(--weight-medium);
    color: var(--text-2);
    line-height: var(--leading-tight);
    transition: color var(--dur-fast) ease;
  }

  .theme-variant-card:hover .theme-variant-name,
  .theme-variant-card.active .theme-variant-name {
    color: var(--text);
  }

  .theme-card-check {
    position: absolute;
    right: 0.625rem;
    bottom: 0.625rem;
    display: grid;
    place-items: center;
    width: 1rem;
    height: 1rem;
    border-radius: var(--radius-full);
    background: var(--accent);
    color: var(--on-accent);
    opacity: 0;
    transform: scale(0.6);
    transition: opacity var(--dur-fast) ease, transform var(--dur-fast) ease;
  }

  .theme-variant-card.active .theme-card-check {
    opacity: 1;
    transform: scale(1);
  }

  @media (prefers-reduced-motion: reduce) {
    .theme-variant-card,
    .theme-variant-card:hover,
    .theme-card-check {
      transition: none;
      transform: none;
    }
  }

  .proxy-input {
    box-sizing: border-box;
    width: 100%;
    font: 0.8125rem var(--font-ui);
  }

  .proxy-input-sm {
    max-width: 7.5rem;
  }

  .proxy-password {
    position: relative;
    display: block;
  }

  .proxy-eye {
    position: absolute;
    top: 50%;
    right: 0.5rem;
    transform: translateY(-50%);
    display: grid;
    place-items: center;
  }

  .about-tab > * {
    flex-shrink: 0;
  }

  .about-hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    max-width: 30rem;
    margin-bottom: var(--space-2);
  }

  .about-name {
    margin: 0;
    color: var(--text);
    font-size: var(--text-heading);
    font-weight: var(--weight-semibold);
  }

  .about-meta {
    margin: var(--space-1-5) 0 0;
    color: var(--text-3);
    font-size: var(--text-body);
    -webkit-user-select: text;
    user-select: text;
  }

  .about-loading {
    margin-top: var(--space-2);
  }

  .about-item-copy {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: var(--space-1);
  }

  .about-item-copy strong {
    color: var(--text);
    font-size: var(--text-body);
    font-weight: var(--weight-medium);
  }

  .about-item-copy span {
    color: var(--text-3);
    font-size: var(--text-label);
    line-height: var(--leading-normal);
  }

  .about-item-chevron {
    flex-shrink: 0;
    color: var(--text-3);
  }

  .about-item .switch-control,
  .about-item .btn,
  .about-item .updates-spinner {
    flex-shrink: 0;
  }

  .about-update-row {
    min-height: 3.5rem;
  }

  .about-item-copy .updates-inline {
    display: inline-flex;
  }

  .about-update-note code {
    font-family: var(--font-mono);
  }

  .about-update-note a {
    color: var(--accent);
  }

  .about-update-note {
    max-width: 30rem;
    margin: var(--space-2-5) 0 0;
    color: var(--text-3);
    font-size: var(--text-label);
    line-height: var(--leading-normal);
    text-align: center;
  }

  .settings-nav-about {
    margin-top: auto;
  }

  .default-location-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .default-location-row input {
    box-sizing: border-box;
    flex: 1;
    min-width: 0;
    font: 0.75rem var(--font-mono, monospace);
  }

  .settings-nav-list {
    margin-top: var(--space-1);
  }

  .default-location-row {
    display: flex;
    gap: var(--space-1-5);
  }

  .default-location-row input {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--text-label);
  }

  .proxy-input {
    width: 15rem;
    max-width: 100%;
  }

  .proxy-input-sm {
    width: 5rem;
  }

  .theme-mode-option {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
  }

  .theme-section {
    gap: var(--space-2);
  }

  .support-link-card {
    gap: var(--space-3);
  }

  .support-link-icon {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: var(--radius-lg);
    background: var(--elevated);
    color: var(--text-2);
  }

  .support-link-copy {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-0-5);
    min-width: 0;
  }

  .support-link-title {
    color: var(--text);
    font-size: var(--text-body);
    font-weight: var(--weight-medium);
  }

  .support-link-meta {
    color: var(--text-3);
    font-size: var(--text-label);
    overflow-wrap: anywhere;
  }

  .support-link-arrow {
    flex: 0 0 auto;
    color: var(--text-3);
  }

  .about-tab {
    align-items: center;
  }

  .about-tab > :first-child {
    margin-top: auto;
  }

  .about-tab > :last-child {
    margin-bottom: auto;
  }

  .about-list {
    box-sizing: border-box;
    width: 100%;
    max-width: 30rem;
  }

  .about-item {
    flex-wrap: nowrap;
  }

</style>
