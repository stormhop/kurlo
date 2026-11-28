<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import Chevron from './Chevron.svelte';
  import CheckIcon from './CheckIcon.svelte';
  import { tick } from 'svelte';
  import { tabListKeyboard } from '../a11y';
  import { appLazyComponents } from '../stores/lazyComponents.svelte';
  import type { RequestSection as RequestTab } from '../stores/requestFiles.svelte';
  import type { RequestType } from '../types/models';

  type BadgeKind = 'default' | 'on';
  type TabItem = {
    id: RequestTab;
    label: string;
    short?: string;
    badge?: string;
    badgeKind?: BadgeKind;
  };

  let {
    requestTab,
    onselect,
    requestType = 'http',
    method = 'GET',
    paramsCount,
    authConfigured,
    headerCount,
    bodyHasContent,
    bodyBadgeLabel,
    scriptLineCount,
    assertionCount = 0,
    listenEventCount = 0,
    metadataCount = 0,
    grpcMethodSelected = false,
    mcpArgumentsHaveContent = false,
    aiPromptHasContent = false,
    aiToolCount = 0,
    exampleCount = 0,
    varCount = 0,
  }: {
    requestTab: RequestTab;
    onselect: (tab: RequestTab) => void;
    requestType?: RequestType;
    method?: string;
    paramsCount: number;
    authConfigured: boolean;
    headerCount: number;
    bodyHasContent: boolean;
    bodyBadgeLabel: string;
    scriptLineCount: number;
    assertionCount?: number;
    listenEventCount?: number;
    metadataCount?: number;
    grpcMethodSelected?: boolean;
    mcpArgumentsHaveContent?: boolean;
    aiPromptHasContent?: boolean;
    aiToolCount?: number;
    exampleCount?: number;
    varCount?: number;
  } = $props();

  let compactMenuOpen = $state(false);
  let compact = $state(false);
  let tabsShellEl = $state<HTMLDivElement>();
  let tabsEl = $state<HTMLDivElement>();

  function buildTabItems(): TabItem[] {
    const docs: TabItem = { id: 'docs', label: 'Docs' };
    const params: TabItem = { id: 'params', label: 'Params', badge: paramsCount > 0 ? String(paramsCount) : undefined };
    const auth: TabItem = { id: 'auth', label: 'Authorization', short: 'Auth', badge: authConfigured ? 'On' : undefined, badgeKind: 'on' };
    const headers: TabItem = { id: 'headers', label: 'Headers', badge: headerCount > 0 ? String(headerCount) : undefined };
    const scripts: TabItem = { id: 'scripts', label: 'Scripts', badge: scriptLineCount > 0 ? `${scriptLineCount} lines` : assertionCount > 0 ? `${assertionCount} ${assertionCount === 1 ? 'assertion' : 'assertions'}` : undefined, badgeKind: 'on' };
    const settings: TabItem = { id: 'settings', label: 'Settings' };
    const vars: TabItem = { id: 'vars', label: 'Vars', badge: varCount > 0 ? String(varCount) : undefined };
    const examples: TabItem = {
      id: 'examples',
      label: 'Examples',
      badge: exampleCount > 0 ? String(exampleCount) : undefined,
    };

    if (requestType === 'graphql') {
      return [
        docs,
        { id: 'query', label: 'Query', badge: bodyHasContent ? bodyBadgeLabel : undefined, badgeKind: 'on' },
        auth,
        headers,
        vars,
        { id: 'schema', label: 'Schema' },
        scripts,
        examples,
      ];
    }

    if (requestType === 'mqtt') {
      const subscribed = vm.mqtt.topics.filter(topic => topic.enabled && topic.name.trim()).length;
      return [docs, { id: 'body', label: 'Message', badge: bodyHasContent ? 'On' : undefined, badgeKind: 'on' }, { id: 'events', label: 'Topics', badge: subscribed ? String(subscribed) : undefined }, { ...auth, badge: vm.authType === 'basic' ? 'On' : undefined }, vars, { id: 'properties', label: 'Properties' }, { id: 'will', label: 'Last Will', badge: vm.mqtt.will.enabled ? 'On' : undefined, badgeKind: 'on' }, settings];
    }
    if (requestType === 'kafka') {
      return [docs, { id: 'body', label: vm.kafka.mode === 'consume' ? 'Topics' : 'Message' }, auth, ...(vm.kafka.mode === 'consume' ? [] : [headers]), vars, scripts, settings];
    }
    if (requestType === 'mcp') {
      return [
        docs,
        { id: 'body', label: 'Arguments', badge: mcpArgumentsHaveContent ? 'On' : undefined, badgeKind: 'on' },
        auth,
        headers,
        vars,
        scripts,
        examples,
        settings,
      ];
    }

    if (requestType === 'ai') {
      return [
        docs,
        { id: 'body', label: 'Prompt', badge: aiPromptHasContent ? 'On' : undefined, badgeKind: 'on' },
        auth,
        headers,
        vars,
        { id: 'tools', label: 'Tools', badge: aiToolCount > 0 ? String(aiToolCount) : undefined },
        scripts,
        settings,
      ];
    }

    if (requestType === 'grpc') {
      return [
        docs,
        { id: 'body', label: 'Message', badge: bodyHasContent ? bodyBadgeLabel : undefined, badgeKind: 'on' },
        auth,
        { id: 'metadata', label: 'Metadata', badge: metadataCount > 0 ? String(metadataCount) : undefined },
        vars,
        { id: 'service', label: 'Service definition', badge: grpcMethodSelected ? 'On' : undefined, badgeKind: 'on' },
        scripts,
        settings,
      ];
    }

    if (requestType === 'socketio') {
      return [
        docs,
        { id: 'body', label: 'Message', badge: bodyHasContent ? bodyBadgeLabel : undefined, badgeKind: 'on' },
        { id: 'events', label: 'Events', badge: listenEventCount > 0 ? String(listenEventCount) : undefined, badgeKind: 'on' },
        params,
        auth,
        headers,
        vars,
        settings,
      ];
    }

    if (requestType === 'ws') {
      return [
        docs,
        { id: 'body', label: 'Message', badge: bodyHasContent ? bodyBadgeLabel : undefined, badgeKind: 'on' },
        params,
        auth,
        headers,
        vars,
        settings,
      ];
    }

    if (method === 'SSE') {
      return [
        docs,
        params,
        auth,
        headers,
        vars,
        { id: 'body', label: 'Body', badge: bodyHasContent ? bodyBadgeLabel : undefined, badgeKind: 'on' },
        settings,
      ];
    }

    return [
      docs,
      params,
      auth,
      headers,
      vars,
      { id: 'body', label: 'Body', badge: bodyHasContent ? bodyBadgeLabel : undefined, badgeKind: 'on' },
      scripts,
      examples,
      settings,
    ];
  }

  function addFileTabBeforeSettings(items: TabItem[]): TabItem[] {
    const fileTab: TabItem = { id: 'file', label: 'File' };
    const settingsIndex = items.findIndex(item => item.id === 'settings');
    return settingsIndex < 0
      ? [...items, fileTab]
      : [...items.slice(0, settingsIndex), fileTab, ...items.slice(settingsIndex)];
  }

  let tabItems: TabItem[] = $derived(addFileTabBeforeSettings(buildTabItems()));
  let activeTabItem = $derived(tabItems.find((item) => item.id === requestTab) ?? tabItems[0]);

  function updateCompactMode() {
    if (!tabsShellEl || !tabsEl) return;

    const availableWidth = tabsShellEl.clientWidth;
    const requiredWidth = tabsEl.scrollWidth;
    if (availableWidth <= 0 || requiredWidth <= 0) return;

    const nextCompact = requiredWidth > availableWidth + 1;

    if (nextCompact === compact) return;
    compact = nextCompact;
    if (!compact) compactMenuOpen = false;
  }

  function observeTabsWidth(node: HTMLDivElement) {
    const observer = new ResizeObserver(updateCompactMode);
    observer.observe(node);
    queueMicrotask(updateCompactMode);

    return {
      destroy() {
        observer.disconnect();
      },
    };
  }

  $effect(() => {
    const tabSignature = tabItems.map((item) => `${item.id}:${item.label}:${item.badge ?? ''}`).join('|');
    void tabSignature;
    void tick().then(updateCompactMode);
  });

  function selectTab(tab: RequestTab) {
    onselect(tab);
    compactMenuOpen = false;
  }

  function closeCompactMenuOnFocusOut(event: FocusEvent) {
    const current = event.currentTarget;
    const next = event.relatedTarget;

    if (!(current instanceof HTMLElement)) return;
    if (!(next instanceof Node) || !current.contains(next)) compactMenuOpen = false;
  }
</script>

<div
  class="request-editor-tabs-shell"
  class:compact
  bind:this={tabsShellEl}
  use:observeTabsWidth
>
  <div class="tab-bar tabs" role="tablist" use:tabListKeyboard bind:this={tabsEl}>
    {#each tabItems as item (item.id)}
      <button class="tab"
        role="tab"
        class:active={requestTab === item.id}
        aria-selected={requestTab === item.id}
        tabindex={requestTab === item.id ? 0 : -1}
        onclick={() => selectTab(item.id)}
        onpointerenter={() => void appLazyComponents.warmRequestTabs()}
        onfocus={() => void appLazyComponents.warmRequestTabs()}
        type="button"
        aria-label={item.short ? `${item.label}${item.badge ? ` ${item.badge}` : ''}` : undefined}
      >
        {item.short ?? item.label}
        {#if item.badge}
          <span class="badge" class:badge-on={item.badgeKind === 'on'}>{item.badge}</span>
        {/if}
      </button>
    {/each}
  </div>

  <div class="request-tab-compact-menu" onfocusout={closeCompactMenuOnFocusOut}>
    <button
      class="field select-trigger request-tab-compact-trigger"
      class:open={compactMenuOpen}
      type="button"
      aria-label="Request section"
      aria-haspopup="listbox"
      aria-expanded={compactMenuOpen}
      onclick={() => (compactMenuOpen = !compactMenuOpen)}
    >
      <span class="request-tab-compact-label">{activeTabItem.label}</span>
      {#if activeTabItem.badge}
        <span class="badge" class:badge-on={activeTabItem.badgeKind === 'on'}>{activeTabItem.badge}</span>
      {/if}
      <Chevron />
    </button>

    {#if compactMenuOpen}
      <div class="menu request-tab-compact-list" role="listbox" aria-label="Request sections">
        {#each tabItems as item (item.id)}
          <button class="menu-item"
            class:active={requestTab === item.id}
            role="option"
            aria-selected={requestTab === item.id}
            type="button"
            onclick={() => selectTab(item.id)}
          >
            <span class="request-tab-compact-check">{#if requestTab === item.id}<CheckIcon />{/if}</span>
            <span>{item.label}</span>
            {#if item.badge}
              <span class="badge" class:badge-on={item.badgeKind === 'on'}>{item.badge}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>
