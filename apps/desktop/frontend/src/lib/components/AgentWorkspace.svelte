<script lang="ts">
  import { onMount } from 'svelte';
  import AgentChatWorkspace from './AgentChatWorkspace.svelte';
  import AgentActivityView from './AgentActivityView.svelte';
  import AgentNotesEditor from './AgentNotesEditor.svelte';
  import { agentNotesEditor } from '../stores/agentNotes.svelte';
  import { agentNavigation, agentStoreFor, codexAgentStore, switchAgent } from '../stores/agent.svelte';
  import { claudeConnectionStore as claude } from '../stores/claude.svelte';
  import { codexConnectionStore } from '../stores/codex.svelte';
  import { aiConnectionsStore } from '../stores/aiConnections.svelte';

  let { workspaceBlocked = false }: { workspaceBlocked?: boolean } = $props();

  const codexReady = $derived(codexConnectionStore.status.connected);
  const codexChatArchived = $derived(codexAgentStore.chats.some(chat => chat.id === codexAgentStore.activeChatId && chat.archivedAt));
  const store = $derived(agentStoreFor(agentNavigation.mode));

  onMount(() => {
    if (!claude.loaded) void claude.refresh();
    if (!codexConnectionStore.loaded) void codexConnectionStore.refresh();
  });

  $effect(() => {
    if (!codexConnectionStore.loaded || codexConnectionStore.checking) return;
    if (agentNavigation.mode === 'external' && !codexReady && !codexAgentStore.running && !codexChatArchived) switchAgent('kurlo');
    else if (agentNavigation.mode === 'kurlo' && aiConnectionsStore.loaded && !aiConnectionsStore.list.length && !store.activeChatId) {
      if (codexReady) switchAgent('external');
      else if (claude.usable) switchAgent('claude');
    }
  });
</script>

<div class="agent-mode-workspace">
  {#if agentNavigation.activity}
    <AgentActivityView />
  {:else}
    <AgentChatWorkspace {workspaceBlocked} agentStore={store} codexReady={codexReady || claude.usable} />
  {/if}
</div>

{#if agentNotesEditor.open}<AgentNotesEditor />{/if}

<style>
  .agent-mode-workspace { display: flex; flex-direction: column; min-height: 0; height: 100%; flex: 1; }
</style>
