<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import AgentGlyph from './AgentGlyph.svelte';
  import { onMount, tick } from 'svelte';
  import { focusFirstMenuItem, handleMenuKeydown } from '../menuKeyboard';
  import MenuIcon from './MenuIcon.svelte';
  import KurloGlyph from './KurloGlyph.svelte';
  import { claudeConnectionStore as claude } from '../stores/claude.svelte';
  import { codexConnectionStore } from '../stores/codex.svelte';
  import { aiConnectionsStore } from '../stores/aiConnections.svelte';
  import { agentStore as kurloAgentStore, codexAgentStore, claudeAgentStore, agentNavigation, agentModeFor, agentStoreFor } from '../stores/agent.svelte';
  import { agentChatGroups, agentFilterChats } from '../agent';
  import { exportAgentChat, type AgentChatSummary } from '../backend';
  import { vm } from '../stores/app.svelte';
  import AgentActivityList from './AgentActivityList.svelte';
  import { agentActivityStore } from '../stores/agentActivity.svelte';

  let { workspaceBlocked = false }: { workspaceBlocked?: boolean } = $props();

  let menuChatId = $state('');
  let chatMenu = $state<HTMLDivElement>();
  let chatMenuTrigger: HTMLElement | null = null;
  let renamingId = $state('');
  let renameValue = $state('');
  let renameError = $state('');
  let actionError = $state('');
  let archived = $state(false);
  let actionPending = $state(false);
  let chatLists: HTMLDivElement;
  let query = $state('');
  let renameInput = $state<HTMLInputElement>();
  const agentStore = $derived(agentStoreFor(agentNavigation.mode));
  const agentReady = $derived(aiConnectionsStore.list.length > 0 || claude.usable || !claude.loaded || (codexConnectionStore.status.connected && codexConnectionStore.status.authenticated) || !aiConnectionsStore.loaded || !codexConnectionStore.loaded);
  const allChats = $derived([...kurloAgentStore.chats, ...codexAgentStore.chats, ...claudeAgentStore.chats]);
  const loaded = $derived(kurloAgentStore.chatsLoaded && codexAgentStore.chatsLoaded && claudeAgentStore.chatsLoaded);
  const visibleChats = $derived(allChats.filter(chat => Boolean(chat.archivedAt) === archived));
  const groups = $derived(agentChatGroups(agentFilterChats(visibleChats, query)));

  function storeOf(chat: AgentChatSummary) {
    return agentStoreFor(agentModeFor(chat.driver));
  }

  function isActive(chat: AgentChatSummary) {
    return agentModeFor(chat.driver) === agentNavigation.mode && chat.id === agentStore.activeChatId;
  }

  $effect(() => {
    const workspaceId = vm.activeWorkspaceId;
    if (agentNavigation.activity && workspaceId !== agentActivityStore.workspaceId) {
      agentActivityStore.deselect();
      void agentActivityStore.refresh(workspaceId);
    }
  });

  onMount(() => {
    kurloAgentStore.init();
    codexAgentStore.init();
    claudeAgentStore.init();
    void kurloAgentStore.refreshChats();
    void codexAgentStore.refreshChats();
    void claudeAgentStore.refreshChats();
  });

  function chatTime(time: number, label: string) {
    const date = new Date(time);
    if (label === 'Today') return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function showList(view: 'chats' | 'archived' | 'activity') {
    menuChatId = '';
    archived = view === 'archived';
    agentNavigation.activity = view === 'activity';
    if (view === 'activity') {
      vm.openAgentTab();
      void agentActivityStore.refresh(vm.activeWorkspaceId);
    }
  }

  function openChat(chat: AgentChatSummary) {
    menuChatId = '';
    agentNavigation.activity = false;
    vm.openAgentTab();
    agentNavigation.mode = agentModeFor(chat.driver);
    void storeOf(chat).openChat(chat.id);
  }

  function newChat() {
    archived = false;
    agentNavigation.activity = false;
    vm.openAgentTab();
    agentStore.newChat();
    setTimeout(() => document.querySelector<HTMLTextAreaElement>('.agent-composer textarea')?.focus(), 0);
  }

  async function toggleMenu(id: string, event: MouseEvent) {
    event.stopPropagation();
    chatMenuTrigger = event.currentTarget as HTMLElement;
    menuChatId = menuChatId === id ? '' : id;
    if (!menuChatId) return;
    await tick();
    if (menuChatId === id) focusFirstMenuItem(chatMenu);
  }

  function closeChatMenu() {
    menuChatId = '';
    chatMenuTrigger?.focus();
  }

  async function startRename(id: string, title: string) {
    menuChatId = '';
    renamingId = id;
    renameValue = title;
    renameError = '';
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }

  async function commitRename() {
    const id = renamingId;
    if (!id) return;
    const chat = allChats.find(item => item.id === id);
    const current = chat?.title ?? '';
    if (!chat || renameValue.trim() === current.trim()) {
      renamingId = '';
      return;
    }
    const error = await storeOf(chat).rename(id, renameValue);
    if (error) {
      renameError = error;
      renameInput?.focus();
      return;
    }
    renamingId = '';
  }

  async function removeChat(chat: AgentChatSummary) {
    menuChatId = '';
    actionError = '';
    try {
      await storeOf(chat).remove(chat.id);
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
  }

  async function toggleArchived(chat: AgentChatSummary) {
    closeChatMenu();
    actionError = '';
    actionPending = true;
    try {
      await storeOf(chat).setArchived(chat.id, !chat.archivedAt);
      if (chat.archivedAt) archived = false;
      await tick();
      chatLists?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      actionPending = false;
    }
  }

  async function exportChat(chat: AgentChatSummary) {
    closeChatMenu();
    actionError = '';
    actionPending = true;
    try {
      if (await vm.openConfirmDialog('Export chat as Markdown', 'The Markdown file is unencrypted and may contain sensitive information from messages and tool results.', 'Export')) {
        await exportAgentChat(chat.id, chat.workspaceId);
      }
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      actionPending = false;
    }
  }

  function onRenameKeydown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      renamingId = '';
    }
  }

  function onRowKeydown(event: KeyboardEvent, id: string, title: string) {
    if (event.key === 'F2') {
      event.preventDefault();
      void startRename(id, title);
    }
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (!menuChatId) return;
    const target = event.target;
    if (target instanceof Element && target.closest('.agent-chat-menu, .agent-chat-menu-btn')) return;
    closeChatMenu();
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="history-panel agent-sidebar">
  <div class="agent-sidebar-head">
    <div class="agent-chat-lists" bind:this={chatLists} role="group" aria-label="Chat lists">
      <button class="btn btn-xs {!archived && !agentNavigation.activity ? 'btn-secondary' : 'btn-ghost'}" type="button" aria-pressed={!archived && !agentNavigation.activity} onclick={() => showList('chats')}>Chats</button>
      <button class="btn btn-xs {archived && !agentNavigation.activity ? 'btn-secondary' : 'btn-ghost'}" type="button" aria-pressed={archived && !agentNavigation.activity} onclick={() => showList('archived')}>Archived</button>
      <button class="btn btn-xs {agentNavigation.activity ? 'btn-secondary' : 'btn-ghost'}" type="button" aria-pressed={agentNavigation.activity} onclick={() => showList('activity')}>Activity</button>
    </div>
    <button class="btn btn-secondary btn-xs agent-new-chat" type="button" onclick={newChat} disabled={workspaceBlocked || !agentReady} aria-label="New chat">
      <AddCloseIcon add />
      New
    </button>
  </div>

  {#if actionError}<div class="agent-delete-error" role="alert">{actionError}</div>{/if}

  {#if agentNavigation.activity}
    <AgentActivityList />
  {:else}
  {#if visibleChats.length > 0}
    <div class="field field-md field-wrap sidebar-search">
      <svg width="0.75rem" height="0.75rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
        <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
        <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
      </svg>
      <input bind:value={query} placeholder="Search chats" aria-label="Filter chats" spellcheck="false" />
    </div>
  {/if}


  {#if groups.length}
    <div class="history-list agent-chat-list">
      {#each groups as group (group.label)}
        <div class="agent-chat-group" role="presentation">{group.label}</div>
        {#each group.chats as chat (chat.id)}
          {@const chatStore = storeOf(chat)}
          <div class="history-entry agent-chat" class:active={isActive(chat) && vm.topView === 'agent'}>
            {#if renamingId === chat.id}
              <div class="agent-rename">
                <input
                  class="field field-sm agent-rename-input"
                  bind:this={renameInput}
                  bind:value={renameValue}
                  aria-label="Rename chat"
                  aria-invalid={renameError ? 'true' : undefined}
                  maxlength="120"
                  spellcheck="false"
                  onkeydown={onRenameKeydown}
                  onblur={() => void commitRename()}
                />
                {#if renameError}<span class="agent-rename-error" role="alert">{renameError}</span>{/if}
              </div>
            {:else}
              <button
                class="history-entry-main agent-chat-main"
                type="button"
                onclick={() => openChat(chat)}
                ondblclick={() => { if (!archived) void startRename(chat.id, chat.title); }}
                onkeydown={(event) => { if (!archived) onRowKeydown(event, chat.id, chat.title); }}
               
                aria-current={isActive(chat) ? 'page' : undefined}
                disabled={workspaceBlocked}
              >
                {#if chat.driver}
                  <span class="agent-chat-glyph agent-chat-glyph-codex" class:agent-chat-glyph-claude={chat.driver === 'claude-code'} role="img" aria-label={chat.driver === 'codex' ? 'Codex' : 'Claude Code'}><AgentGlyph driver={chat.driver} size="0.75rem" /></span>
                {:else}
                  <span class="agent-chat-glyph agent-chat-glyph-kurlo" role="img" aria-label="Kurlo agent"><KurloGlyph size="0.75rem" /></span>
                {/if}
                <span class="agent-chat-title">{chat.title || 'Untitled chat'}</span>
                {#if chatStore.isWaiting(chat.id)}
                  <span class="agent-chat-waiting" role="img" aria-label="Waiting for you"></span>
                {:else if chatStore.isRunning(chat.id)}
                  <span class="agent-chat-live" role="img" aria-label="Working"></span>
                {:else}
                  <span class="agent-chat-time">{chatTime(chat.updatedAt, group.label)}</span>
                {/if}
              </button>
              <button class="btn btn-ghost btn-icon btn-xs history-entry-menu-btn agent-chat-menu-btn" type="button" onclick={(event) => void toggleMenu(chat.id, event)} aria-label="Chat menu" aria-haspopup="menu" aria-expanded={menuChatId === chat.id} disabled={workspaceBlocked}>
                <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="13" cy="8" r="1.25"/></svg>
              </button>
              {#if menuChatId === chat.id}
                <div class="menu request-menu history-entry-menu agent-chat-menu" role="menu" aria-label="Chat menu" tabindex="-1" bind:this={chatMenu} onkeydown={(event) => handleMenuKeydown(event, closeChatMenu)}>
                  {#if !archived}
                      <button class="menu-item" type="button" role="menuitem" onclick={() => void startRename(chat.id, chat.title)}><MenuIcon name="rename" />Rename</button>
                  {/if}
                  <button class="menu-item" type="button" role="menuitem" onclick={() => void toggleArchived(chat)} disabled={actionPending || chatStore.isRunning(chat.id)}><MenuIcon name={archived ? 'restore' : 'archive'} />{archived ? 'Restore' : 'Archive'}</button>
                  <button class="menu-item" type="button" role="menuitem" onclick={() => void exportChat(chat)} disabled={actionPending}><MenuIcon name="export" />Export as Markdown…</button>
                  <div class="menu-separator" role="separator"></div>
                  <button class="menu-item danger" type="button" role="menuitem" onclick={() => void removeChat(chat)} disabled={chatStore.isRunning(chat.id)}><MenuIcon name="trash" />Delete</button>
                </div>
              {/if}
            {/if}
          </div>
        {/each}
      {/each}
    </div>
  {:else if visibleChats.length > 0}
    <div class="empty-state history-empty">
      <span class="empty-state-title">No chat matches this filter.</span>
      <button class="btn btn-secondary" type="button" onclick={() => (query = '')}>Clear filter</button>
    </div>
  {:else if loaded}
    <div class="empty-state history-empty">
      <span class="empty-state-title">{archived ? 'No archived chats.' : 'No chats yet.'}</span>
      {#if !archived}<small class="empty-state-text">Ask the agent to run requests, explain failures or add tests. Chats stay on this computer.</small>{/if}
    </div>
  {/if}
  {/if}
</div>

<style>
  .agent-sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    min-height: 1.75rem;
    padding: 0 var(--space-0-5) 0 var(--space-1-5);
  }
  .agent-chat-lists {
    display: flex;
    gap: var(--space-1);
  }
  .agent-new-chat {
    gap: var(--space-1);
  }
  .agent-chat-group {
    padding: var(--space-3) var(--space-2) var(--space-1);
    color: var(--text-3);
    font-size: var(--text-caption);
    font-weight: var(--weight-medium);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .agent-chat-group:first-child {
    padding-top: var(--space-1);
  }
  .agent-chat {
    grid-template-columns: minmax(0, 1fr) auto;
    min-height: 2.125rem;
    padding-right: var(--space-1);
  }
  .agent-chat.active {
    background: var(--bg);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .agent-chat:focus-within .agent-chat-menu-btn,
  .agent-chat-menu-btn[aria-expanded="true"] {
    opacity: 1;
  }
  .agent-chat-main {
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--space-2-5);
    min-height: 2.125rem;
    padding: 0 var(--space-2);
    font-size: var(--text-body);
  }
  .agent-chat-glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 0.5625rem;
    font-weight: var(--weight-semibold);
    line-height: 1;
  }
  .agent-chat-glyph-codex {
    background: var(--text);
    color: var(--bg);
  }
  .agent-chat-glyph-claude {
    background: var(--claude-tile);
  }
  .agent-chat-glyph-kurlo {
    background: var(--accent-dim);
    color: var(--accent);
  }
  .agent-chat-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-chat-time {
    color: var(--text-3);
    font-size: var(--text-caption);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .agent-chat-live,
  .agent-chat-waiting {
    width: 0.4375rem;
    height: 0.4375rem;
    margin-right: var(--space-1);
    border-radius: var(--radius-full);
    background: var(--accent);
  }
  .agent-chat-waiting {
    background: var(--s4xx);
  }
  .agent-rename {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-0-5) 0;
  }
  .agent-rename-input {
    width: 100%;
  }
  .agent-delete-error {
    padding: 0 var(--space-1-5);
  }
  .agent-rename-error, .agent-delete-error {
    color: var(--danger);
    font-size: var(--text-caption);
  }
</style>
