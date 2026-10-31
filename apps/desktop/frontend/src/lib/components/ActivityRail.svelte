<script lang="ts">
  import type { SidebarView } from '../types/models';
  import type { SettingsTab, TopView } from '../stores/ui';

  let {
    sidebarView = $bindable<SidebarView>('collections'),
    sidebarHidden = $bindable(false),
    topView,
    mockRunning = false,
    cookieCount = 0,
    settingsShortcut = '',
    workspaceBlocked = false,
    openCollectionRunner,
    openMockTab,
    openCookieJar,
    openSettings,
  }: {
    sidebarView: SidebarView;
    sidebarHidden: boolean;
    topView: TopView;
    mockRunning?: boolean;
    cookieCount?: number;
    settingsShortcut?: string;
    workspaceBlocked?: boolean;
    openCollectionRunner: () => void;
    openMockTab: () => void;
    openCookieJar: () => void;
    openSettings: (tab?: SettingsTab) => void;
  } = $props();

  function showSidebarView(view: SidebarView) {
    sidebarView = view;
    sidebarHidden = false;
  }

  let sidebarActive = (view: SidebarView) => !sidebarHidden && sidebarView === view;
</script>

<nav class="activity-rail" aria-label="Kurlo">
  <div class="activity-rail-titlebar titlebar-drag-region"></div>

  <div class="activity-rail-group">
    <button class="activity-rail-btn" class:active={sidebarActive('collections')} type="button" aria-label="Collections" title="Collections" aria-pressed={sidebarActive('collections')} onclick={() => showSidebarView('collections')} disabled={workspaceBlocked}>
      <svg width="1.125rem" height="1.125rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5"/>
      </svg>
    </button>
    <button class="activity-rail-btn" class:active={sidebarActive('environments')} type="button" aria-label="Environments" title="Environments" aria-pressed={sidebarActive('environments')} onclick={() => showSidebarView('environments')} disabled={workspaceBlocked}>
      <svg width="1.125rem" height="1.125rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>
      </svg>
    </button>
    <button class="activity-rail-btn" class:active={sidebarActive('history')} type="button" aria-label="History" title="History" aria-pressed={sidebarActive('history')} onclick={() => showSidebarView('history')} disabled={workspaceBlocked}>
      <svg width="1.125rem" height="1.125rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
      </svg>
    </button>
  </div>

  <div class="activity-rail-separator" aria-hidden="true"></div>

  <div class="activity-rail-group">
    <button class="activity-rail-btn" class:active={topView === 'runner'} type="button" aria-label="Collection runner" title="Collection runner" onclick={openCollectionRunner} disabled={workspaceBlocked}>
      <svg width="1.125rem" height="1.125rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M7 5v14l11-7z"/>
      </svg>
    </button>
    <button class="activity-rail-btn" class:active={topView === 'mock'} type="button" aria-label="Mock server" title={mockRunning ? 'Mock server (running)' : 'Mock server'} onclick={openMockTab} disabled={workspaceBlocked}>
      <svg width="1.125rem" height="1.125rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>
      </svg>
      {#if mockRunning}<span class="activity-rail-dot" aria-hidden="true"></span>{/if}
    </button>
  </div>

  <div class="activity-rail-spacer"></div>

  <div class="activity-rail-group">
    <button class="activity-rail-btn" type="button" aria-label="Cookies" title="Cookies" onclick={openCookieJar} disabled={workspaceBlocked}>
      <svg width="1.125rem" height="1.125rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20.6 13.1A8.5 8.5 0 1 1 10.9 3.4a3 3 0 0 0 3.9 3.9 3 3 0 0 0 3.9 3.9 3 3 0 0 0 1.9 1.9z"/><path d="M8.2 9h.01M11.5 14.2h.01M7.4 16.2h.01M14.8 11.7h.01" stroke-width="2.6"/>
      </svg>
      {#if cookieCount > 0}<span class="activity-rail-count" aria-hidden="true">{cookieCount > 99 ? '99+' : cookieCount}</span>{/if}
    </button>
    <button class="activity-rail-btn" type="button" aria-label="Settings" title={settingsShortcut ? `Settings (${settingsShortcut})` : 'Settings'} onclick={() => openSettings('general')}>
      <svg width="1.125rem" height="1.125rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z"/>
        <path d="M19.6 13.5a7.8 7.8 0 0 0 0-3l2-1.45-2-3.46-2.42 1a8 8 0 0 0-2.6-1.5L14.25 2h-4.5l-.33 3.08a8 8 0 0 0-2.6 1.5l-2.42-1-2 3.46 2 1.45a7.8 7.8 0 0 0 0 3l-2 1.45 2 3.46 2.42-1a8 8 0 0 0 2.6 1.5l.33 3.08h4.5l.33-3.08a8 8 0 0 0 2.6-1.5l2.42 1 2-3.46-2-1.45z"/>
      </svg>
    </button>
  </div>
</nav>

<style>
  .activity-rail {
    grid-column: 1;
    grid-row: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    width: var(--rail-w);
    padding: var(--space-2-5) 0;
    position: relative;
    background: var(--surface);
    overflow: hidden;
  }

  .activity-rail::after {
    content: '';
    position: absolute;
    top: var(--rail-divider-top, 0px);
    right: 0;
    bottom: 0;
    width: 1px;
    background: var(--border-subtle);
    pointer-events: none;
  }
  :global(:root[data-platform="darwin"]) .activity-rail {
    --rail-divider-top: 2.8125rem;
  }
  :global(:root[data-platform="darwin"] .shell:not(.sidebar-hidden)) .activity-rail::after {
    display: none;
  }

  .activity-rail-titlebar {
    flex: 0 0 auto;
    align-self: stretch;
    height: var(--titlebar-h, 0px);
  }

  .activity-rail-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
  }

  .activity-rail-separator {
    width: 1.25rem;
    height: 1px;
    margin: var(--space-1-5) 0;
    background: var(--border-subtle);
  }

  .activity-rail-spacer {
    flex: 1 1 auto;
  }

  .activity-rail-btn {
    position: relative;
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    border: none;
    border-radius: var(--radius-lg);
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    transition: box-shadow var(--dur-fast);
  }
  .activity-rail-btn:hover:not(:disabled) {
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .activity-rail-btn.active {
    background: var(--elevated);
    color: var(--text);
  }
  .activity-rail-btn.active::before {
    content: '';
    position: absolute;
    left: -0.5rem;
    top: 0.5625rem;
    bottom: 0.5625rem;
    width: 0.125rem;
    border-radius: 0 var(--radius-xs) var(--radius-xs) 0;
    background: var(--accent);
  }
  .activity-rail-btn:focus-visible {
    outline: var(--focus-outline);
    outline-offset: 1px;
  }
  .activity-rail-btn:disabled {
    cursor: default;
    opacity: var(--opacity-disabled);
  }

  .activity-rail-dot {
    position: absolute;
    top: 0.4375rem;
    right: 0.4375rem;
    width: 0.4375rem;
    height: 0.4375rem;
    border: 1.5px solid var(--surface);
    border-radius: 50%;
    background: var(--s2xx);
  }

  .activity-rail-count {
    position: absolute;
    top: 0.1875rem;
    right: 1px;
    min-width: 0.9375rem;
    height: 0.9375rem;
    padding: 0 var(--space-1);
    border: 1.5px solid var(--surface);
    border-radius: var(--radius-lg);
    background: var(--accent);
    color: var(--on-accent);
    font-size: var(--text-micro);
    font-weight: var(--weight-semibold);
    line-height: 0.75rem;
    text-align: center;
  }
</style>
