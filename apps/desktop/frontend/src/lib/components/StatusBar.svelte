<script lang="ts">
  import { kurloChangedFiles } from '../gitFiles';
  import { vm } from '../stores/app.svelte';
  import { openExternalURL } from '../externalLinks';
  import { KURLO_REPO_URL } from '../starPrompt';
  import type { GitWorkspaceStatus } from '../backend';
  import type { TopView } from '../stores/ui';
  import { shortcutComboLabel } from '../stores/features/preferences';
  import {
    DARK_THEME_VARIANTS,
    LIGHT_THEME_VARIANTS,
    type AppTheme,
    type AppThemeMode,
    type ResolvedAppTheme,
    type ThemeVariantId,
  } from '../theme';

  let {
    sidebarHidden,
    codePanelOpen,
    codePanelAvailable = true,
    topView,
    gitStatus,
    appVersion = '',
    appRuntime = '',
    appTheme,
    resolvedAppTheme,
    setThemeMode,
    setThemeVariant,
    onOpenGit,
    onOpenAbout,
    onToggleSidebar,
    onToggleCodePanel,
  }: {
    sidebarHidden: boolean;
    codePanelOpen: boolean;
    codePanelAvailable?: boolean;
    topView: TopView;
    gitStatus: GitWorkspaceStatus;
    appVersion?: string;
    appRuntime?: string;
    appTheme: AppTheme;
    resolvedAppTheme: ResolvedAppTheme;
    setThemeMode: (mode: AppThemeMode) => void;
    setThemeVariant: (id: ThemeVariantId) => void;
    onOpenGit: () => void;
    onOpenAbout?: () => void;
    onToggleSidebar: () => void;
    onToggleCodePanel: () => void;
  } = $props();

  let themeMenuOpen = $state(false);
  const THEME_MODE_OPTIONS: { value: AppThemeMode; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];
  const KURLO_UPDATES_URL = 'https://github.com/stormhop/kurlo/releases';
  let themeVariantList = $derived(resolvedAppTheme === 'light' ? LIGHT_THEME_VARIANTS : DARK_THEME_VARIANTS);
  let activeVariantId = $derived(resolvedAppTheme === 'light' ? appTheme.light : appTheme.dark);
  let toggleSidebarShortcut = $derived(shortcutComboLabel(vm.shortcutCombo('toggle-left-sidebar'), appRuntime));

  function starKurlo() {
    openExternalURL(KURLO_REPO_URL);
    vm.closeStarPrompt();
  }

  function branchNameOnly(value: string) {
    const branch = (value || '').trim();
    if (!branch) return '';
    const trackingIndex = branch.indexOf('...');
    const withoutTracking = trackingIndex >= 0 ? branch.slice(0, trackingIndex) : branch;
    const bracketIndex = withoutTracking.indexOf(' [');
    return (bracketIndex >= 0 ? withoutTracking.slice(0, bracketIndex) : withoutTracking).trim();
  }

  function upstreamFromRawBranch(value: string) {
    const branch = (value || '').trim();
    const trackingIndex = branch.indexOf('...');
    if (trackingIndex < 0) return '';
    const upstream = branch.slice(trackingIndex + 3);
    const bracketIndex = upstream.indexOf(' [');
    return (bracketIndex >= 0 ? upstream.slice(0, bracketIndex) : upstream).trim();
  }

  function rawBranchHasGoneUpstream(value: string) {
    return /\[\s*gone\s*\]/.test(value || '');
  }

  let changeCount = $derived(kurloChangedFiles(gitStatus).length);
  let branchLabel = $derived(branchNameOnly(gitStatus.branch) || (gitStatus.isRepo ? 'HEAD' : 'Local'));
  let upstreamLabel = $derived(gitStatus.upstream || upstreamFromRawBranch(gitStatus.branch));
  let upstreamGone = $derived(Boolean(gitStatus.upstreamGone || rawBranchHasGoneUpstream(gitStatus.branch)));
  let workspaceMissing = $derived(!gitStatus.isRepo && Boolean(gitStatus.missingRoot));
  let storageMode = $derived(gitStatus.isRepo ? 'Git' : (workspaceMissing ? 'Missing' : 'Local'));
  let storageLabel = $derived(gitStatus.isRepo ? branchLabel : (workspaceMissing ? 'Missing folder' : 'Local storage'));
  let storageTitle = $derived(gitStatus.isRepo
    ? `Workspace storage: Git repository (${gitStatus.root || gitStatus.workspaceRoot})${upstreamLabel ? ` · tracks ${upstreamLabel}${upstreamGone ? ' (remote branch gone)' : ''}` : ''}`
    : (workspaceMissing
      ? `Workspace folder is missing (${gitStatus.workspaceRoot})`
      : `Workspace storage: local filesystem (${gitStatus.workspaceRoot || 'Kurlo app data'})`));
</script>

<div class="status-bar">
  <div class="status-bar-left">
    <button
      class="btn btn-ghost btn-xs storage-status-btn"
      class:active={topView === 'git'}
      class:git={gitStatus.isRepo}
      class:missing={workspaceMissing}
      type="button"
      onclick={onOpenGit}
      title={storageTitle}
      aria-label="Open Git and storage status"
    >
      <svg width="0.875rem" height="0.875rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
        <path d="M4 12.2V4.8a2 2 0 114 0v5.4a2 2 0 104 0V3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
      </svg>
      <span class="storage-status-main">{storageLabel}</span>
      {#if gitStatus.isRepo && upstreamGone}
        <span class="storage-upstream-gone" title={upstreamLabel ? `${upstreamLabel} no longer exists on the remote` : 'Tracked remote branch no longer exists'}>gone</span>
      {/if}
      <span class="storage-status-mode">{storageMode}</span>
      {#if gitStatus.isRepo && changeCount > 0}
        <span class="storage-change-count">· {changeCount} changed</span>
      {/if}
    </button>
  </div>
  <div class="status-bar-right">
    {#if vm.starPromptVisible}
      <span class="star-prompt">
        <button class="btn btn-ghost btn-xs star-prompt-btn" type="button" onclick={starKurlo} title="Kurlo is free and open source; a star helps other people find it">
          <svg width="0.75rem" height="0.75rem" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 1.6l1.95 3.95 4.35.63-3.15 3.07.74 4.33L8 11.53l-3.89 2.05.74-4.33L1.7 6.18l4.35-.63L8 1.6z" fill="currentColor"/>
          </svg>
          <span>Star on GitHub</span>
        </button>
        <button class="btn btn-ghost btn-icon btn-xs star-prompt-close" type="button" onclick={() => vm.closeStarPrompt()} title="Don't show again" aria-label="Hide the GitHub star prompt">
          <svg width="0.5625rem" height="0.5625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
        </button>
      </span>
    {/if}
    <button
      class="btn btn-ghost btn-icon btn-xs layout-btn github-link-btn"
      type="button"
      onclick={() => openExternalURL(KURLO_UPDATES_URL)}
      title="Kurlo updates and releases"
      aria-label="Open Kurlo updates on GitHub"
    >
      <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M8 .9a7.1 7.1 0 00-2.25 13.84c.36.07.49-.16.49-.35v-1.25c-2 .43-2.42-.86-2.42-.86-.33-.82-.79-1.04-.79-1.04-.64-.44.05-.43.05-.43.71.05 1.09.73 1.09.73.63 1.08 1.65.77 2.05.59.06-.46.25-.77.45-.95-1.6-.18-3.28-.8-3.28-3.55 0-.78.28-1.42.73-1.92-.07-.18-.32-.91.07-1.9 0 0 .6-.19 1.96.73A6.8 6.8 0 018 4.3c.61 0 1.22.08 1.79.24 1.36-.92 1.95-.73 1.95-.73.39.99.14 1.72.07 1.9.46.5.73 1.14.73 1.92 0 2.76-1.68 3.36-3.28 3.54.26.22.49.66.49 1.34v1.88c0 .19.13.42.5.35A7.1 7.1 0 008 .9z"/>
      </svg>
    </button>
    <div class="theme-switcher">
      {#if themeMenuOpen}
        <button class="theme-menu-scrim" type="button" aria-label="Close theme menu" onclick={() => (themeMenuOpen = false)}></button>
        <div class="theme-menu" role="menu" aria-label="Appearance">
          <div class="theme-menu-modes">
            {#each THEME_MODE_OPTIONS as option, eachIndex (eachIndex)}
              <button
                class="theme-menu-mode"
                class:active={appTheme.mode === option.value}
                type="button"
                role="menuitemradio"
                aria-checked={appTheme.mode === option.value}
                onclick={() => setThemeMode(option.value)}
              >
                {option.label}
              </button>
            {/each}
          </div>
          <div class="theme-menu-list">
            {#each themeVariantList as variant, eachIndex (eachIndex)}
              <button
                class="theme-menu-item"
                class:active={activeVariantId === variant.id}
                type="button"
                role="menuitemradio"
                aria-checked={activeVariantId === variant.id}
                onclick={() => setThemeVariant(variant.id)}
              >
                <span class="theme-menu-swatch" style={`background:${variant.preview.accent}`}></span>
                <span class="theme-menu-name">{variant.name}</span>
                {#if activeVariantId === variant.id}
                  <svg class="theme-menu-check" width="0.75rem" height="0.75rem" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M2.5 6.3l2.4 2.4 4.6-4.9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {/if}
              </button>
            {/each}
          </div>
        </div>
      {/if}
      <button
        class="btn btn-ghost btn-icon btn-xs layout-btn"
        class:active={themeMenuOpen}
        type="button"
        onclick={() => (themeMenuOpen = !themeMenuOpen)}
        title="Switch theme"
        aria-label="Switch theme"
        aria-haspopup="menu"
        aria-expanded={themeMenuOpen}
      >
        <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 1.5a6.5 6.5 0 100 13 1.6 1.6 0 001.2-2.7 1.4 1.4 0 011-2.3h1A3.3 3.3 0 0014.5 6 6.6 6.6 0 008 1.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
          <circle cx="5.3" cy="6.2" r="0.9" fill="currentColor"/>
          <circle cx="8" cy="4.6" r="0.9" fill="currentColor"/>
          <circle cx="10.8" cy="6.2" r="0.9" fill="currentColor"/>
        </svg>
      </button>
    </div>
    {#if appVersion}
      <button
        class="version-pill"
        type="button"
        onclick={() => onOpenAbout?.()}
        title="Open About"
        aria-label={`Kurlo version ${appVersion} — click to open About`}
      >
        v{appVersion}
      </button>
    {/if}
    <button
      class="btn btn-ghost btn-icon btn-xs layout-btn"
      class:active={!sidebarHidden}
      type="button"
      onclick={onToggleSidebar}
      title={`Toggle sidebar (${toggleSidebarShortcut})`}
      aria-label="Toggle sidebar"
    >
      <svg width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/>
        <line x1="5" y1="1" x2="5" y2="13" stroke="currentColor" stroke-width="1.2"/>
      </svg>
    </button>
    {#if codePanelAvailable}
      <button
        class="btn btn-ghost btn-icon btn-xs layout-btn"
        class:active={codePanelOpen}
        type="button"
        onclick={onToggleCodePanel}
        title="Toggle code snippet panel"
        aria-label="Toggle code snippet panel"
      >
        <svg width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/>
          <line x1="9" y1="1" x2="9" y2="13" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </button>
    {/if}
  </div>
</div>

<style>
  .theme-switcher {
    position: relative;
    display: inline-flex;
  }

  .theme-menu-scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    border: 0;
    padding: 0;
    background: transparent;
    cursor: default;
  }

  .theme-menu {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    right: 0;
    z-index: 41;
    width: 13.75rem;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--elevated, var(--surface));
    box-shadow: var(--shadow-popover);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .theme-menu-modes {
    display: flex;
    gap: var(--space-1);
    padding: var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
  }

  .theme-menu-mode {
    flex: 1;
    min-height: 1.625rem;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-2);
    font-size: var(--text-label);
    font-weight: var(--weight-semibold);
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast);
  }

  .theme-menu-mode:hover {
    color: var(--text);
    background: var(--hover);
  }

  .theme-menu-mode.active {
    color: var(--accent-hover, var(--accent));
    background: color-mix(in srgb, var(--accent) 16%, var(--surface));
  }

  .theme-menu-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: 15rem;
    overflow-y: auto;
  }

  .theme-menu-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-2);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-2);
    font-size: var(--text-body);
    text-align: left;
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast);
  }

  .theme-menu-item:hover {
    background: var(--hover);
    color: var(--text);
  }

  .theme-menu-item.active {
    color: var(--text);
  }

  .theme-menu-swatch {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18);
  }

  .theme-menu-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .theme-menu-check {
    flex-shrink: 0;
    color: var(--accent);
  }
</style>
