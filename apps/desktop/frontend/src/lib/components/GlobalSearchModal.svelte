<script lang="ts">
  import AgentGlyph from './AgentGlyph.svelte';
  import Keycaps from './Keycaps.svelte';
  import KurloGlyph from './KurloGlyph.svelte';
  import { onMount, tick } from 'svelte';
  import { trapFocus } from '../a11y';
  import RequestTypeBadge from './RequestTypeBadge.svelte';
  import { filterPaletteCommands, parsePaletteQuery, type PaletteCommand } from '../commandPalette';
  import type { SavedRequest, ShortcutId } from '../types/models';
  import type { AgentChatSummary } from '../backend';
  import { agentFilterChats } from '../agent';

  const EMPTY_QUERY_REQUESTS = 6;
  const MAX_REQUESTS = 50;

  let {
    query = $bindable(''),
    results,
    commands,
    chats = [],
    onOpenChat = () => {},
    activeRequestId,
    requestTabLabel,
    collectionLabel,
    shortcutCombo,
    appRuntime = '',
    onSwitchRequest,
    onClose,
  }: {
    query: string;
    results: SavedRequest[];
    commands: PaletteCommand[];
    chats?: AgentChatSummary[];
    onOpenChat?: (chat: AgentChatSummary) => void;
    activeRequestId: string;
    requestTabLabel: (request: SavedRequest) => string;
    collectionLabel: (request: SavedRequest) => string;
    shortcutCombo: (id: ShortcutId) => string;
    appRuntime?: string;
    onSwitchRequest: (id: string) => void;
    onClose: () => void;
  } = $props();

  type Item =
    | { kind: 'request'; key: string; heading: string; request: SavedRequest }
    | { kind: 'chat'; key: string; heading: string; chat: AgentChatSummary }
    | { kind: 'command'; key: string; heading: string; command: PaletteCommand };

  let input: HTMLInputElement;
  let list: HTMLDivElement;
  let selectedIndex = $state(0);
  let parsed = $derived(parsePaletteQuery(query));
  let requestItems = $derived<Item[]>(parsed.commandsOnly
    ? []
    : results
      .slice(0, parsed.text ? MAX_REQUESTS : EMPTY_QUERY_REQUESTS)
      .map((request, index) => ({ kind: 'request', key: `request:${request.id}`, heading: index === 0 ? 'Requests' : '', request })));
  let commandItems = $derived.by<Item[]>(() => {
    const matched = filterPaletteCommands(commands, parsed.text);
    const grouped = parsed.text ? matched : [...matched].sort((a, b) => groupOrder(a) - groupOrder(b));
    return grouped.map((command, index) => ({
      kind: 'command',
      key: `command:${command.id}`,
      heading: parsed.text ? (index === 0 ? 'Commands' : '') : (index === 0 || grouped[index - 1].group !== command.group ? command.group : ''),
      command,
    }));
  });
  let chatItems = $derived<Item[]>(parsed.commandsOnly ? [] : agentFilterChats(chats, parsed.text)
    .slice(0, parsed.text ? MAX_REQUESTS : EMPTY_QUERY_REQUESTS)
    .map((chat, index) => ({ kind: 'chat', key: `chat:${chat.id}`, heading: index === 0 ? 'Chats in this workspace' : '', chat })));
  let items = $derived([...requestItems, ...chatItems, ...commandItems]);

  $effect(() => {
    void query;
    selectedIndex = 0;
  });

  onMount(() => {
    setTimeout(() => input?.focus(), 0);
  });

  function run(item: Item | undefined) {
    if (!item) return;
    onClose();
    if (item.kind === 'request') onSwitchRequest(item.request.id);
    else if (item.kind === 'chat') onOpenChat(item.chat);
    else void item.command.run();
  }

  async function select(index: number) {
    if (!items.length) return;
    selectedIndex = (index + items.length) % items.length;
    await tick();
    list?.querySelector<HTMLElement>(`[data-palette-index="${selectedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function onInputKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      void select(selectedIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      void select(selectedIndex - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(items[selectedIndex]);
    }
  }

  function groupOrder(command: PaletteCommand) {
    return commands.findIndex(candidate => candidate.group === command.group);
  }

  function optionId(index: number) {
    return `palette-option-${index}`;
  }
</script>

<div class="global-search-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onClose()}>
  <div class="modal global-search-modal" role="dialog" aria-modal="true" aria-label="Search requests, chats and commands" tabindex="-1" use:trapFocus>
    <div class="global-search-input-wrap">
      <svg width="1rem" height="1rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
        <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.4"/>
        <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      <input
        bind:value={query}
        bind:this={input}
        placeholder="Search requests, chats and commands…"
        spellcheck="false"
        role="combobox"
        aria-label="Search requests, chats and commands"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={items.length ? optionId(selectedIndex) : undefined}
        onkeydown={onInputKeydown}
        data-autofocus
      />
      <kbd>Esc</kbd>
    </div>
    <div class="global-search-results" id="palette-list" role="listbox" aria-label="Results" bind:this={list}>
      {#each items as item, index (item.key)}
        {#if item.heading}
          <div class="palette-section" role="presentation">{item.heading}</div>
        {/if}
        {#if item.kind === 'request'}
          <button
            id={optionId(index)}
            class="global-search-item"
            class:selected={index === selectedIndex}
            class:current={item.request.id === activeRequestId}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            data-palette-index={index}
            tabindex="-1"
            onmousemove={() => (selectedIndex = index)}
            onclick={() => run(item)}
          >
            <RequestTypeBadge request={item.request} variant="search" />
            <div class="gsr-info">
              <span class="gsr-name">{requestTabLabel(item.request)}</span>
              {#if item.request.url}<span class="gsr-url">{item.request.url}</span>{/if}
            </div>
            <span class="gsr-collection">{collectionLabel(item.request)}</span>
          </button>
        {:else if item.kind === 'chat'}
          <button
            id={optionId(index)}
            class="global-search-item"
            class:selected={index === selectedIndex}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            data-palette-index={index}
            data-chat-id={item.chat.id}
            tabindex="-1"
            onmousemove={() => (selectedIndex = index)}
            onclick={() => run(item)}
          >
            <span class="global-search-chat-icon" aria-hidden="true">{#if item.chat.driver}<AgentGlyph driver={item.chat.driver} size="0.875rem" />{:else}<KurloGlyph size="0.875rem" />{/if}</span>
            <div class="gsr-info"><span class="gsr-name">{item.chat.title || 'Untitled chat'}</span></div>
            <span class="gsr-collection">{item.chat.driver === 'codex' ? 'Codex' : item.chat.driver === 'claude-code' ? 'Claude Code' : 'Kurlo agent'}</span>
          </button>
        {:else}
          <button
            id={optionId(index)}
            class="palette-command"
            class:selected={index === selectedIndex}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            data-palette-index={index}
            data-command-id={item.command.id}
            tabindex="-1"
            onmousemove={() => (selectedIndex = index)}
            onclick={() => run(item)}
          >
            <span class="palette-command-label">{item.command.label}</span>
            {#if item.command.shortcut && shortcutCombo(item.command.shortcut)}
              <Keycaps combo={shortcutCombo(item.command.shortcut)} runtime={appRuntime} />
            {/if}
          </button>
        {/if}
      {/each}
      {#if !items.length}
        <div class="global-search-empty">{parsed.commandsOnly ? 'No matching commands' : 'No requests, chats or commands found'}</div>
      {/if}
    </div>
    <div class="global-search-footer">
      <span><Keycaps combo="ArrowUp" runtime={appRuntime} /><Keycaps combo="ArrowDown" runtime={appRuntime} /> move</span>
      <span><Keycaps combo="Enter" runtime={appRuntime} /> open</span>
      <span><kbd class="keycap-literal">&gt;</kbd> commands only</span>
      {#if shortcutCombo('search')}<span class="palette-footer-end"><Keycaps combo={shortcutCombo('search')} runtime={appRuntime} /> palette</span>{/if}
    </div>
  </div>
</div>

<style>
  .global-search-chat-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-label);
  }
</style>
