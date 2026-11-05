<script lang="ts">
  import { onMount } from 'svelte';
  import { trapFocus } from '../a11y';
  import { agentAttachmentData, type AgentAttachment } from '../backend';
  import AddCloseIcon from './AddCloseIcon.svelte';

  let { file, chatId, workspaceId, onClose }: {
    file: AgentAttachment;
    chatId: string;
    workspaceId: string;
    onClose: () => void;
  } = $props();

  let content = $state<string>();
  let error = $state('');
  let width = $state(0);
  let height = $state(0);
  let naturalWidth = $state(0);
  let naturalHeight = $state(0);
  let zoom = $state<number>();
  const image = $derived(Boolean(file.preview || file.mediaType?.startsWith('image/')));
  const source = $derived(content ?? (file.mediaType && !error ? undefined : file.preview));
  const fit = $derived(naturalWidth && naturalHeight ? Math.min(1, width / naturalWidth, height / naturalHeight) : 0);
  const scale = $derived(zoom ?? fit);
  const maxZoom = $derived(Math.max(2, fit * 8));

  onMount(() => {
    if (!file.id || !file.mediaType) return;
    let open = true;
    void agentAttachmentData(chatId, workspaceId, file.id).then(data => {
      if (open) content = data;
    }).catch(reason => {
      if (open) error = reason instanceof Error ? reason.message : String(reason);
    });
    return () => { open = false; };
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }

  function imageLoaded(event: Event) {
    if (event.currentTarget instanceof HTMLImageElement) {
      naturalWidth = event.currentTarget.naturalWidth;
      naturalHeight = event.currentTarget.naturalHeight;
    }
  }
</script>

<div class="dialog-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onClose()}>
  <div class="modal attachment-viewer" role="dialog" aria-modal="true" aria-labelledby="agent-attachment-title" tabindex="-1" use:trapFocus onkeydown={onKeydown}>
    <div class="modal-head attachment-head">
      <h2 class="modal-title" id="agent-attachment-title">{file.name}</h2>
      <div class="attachment-controls">
        {#if image && fit}
          <button class="btn btn-ghost btn-sm" type="button" disabled={zoom === undefined} onclick={() => (zoom = undefined)}>Fit</button>
          <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Zoom out" disabled={scale <= fit} onclick={() => (zoom = Math.max(fit, scale / 1.25))}>−</button>
          <span class="attachment-scale">{Math.round(scale * 100)}%</span>
          <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Zoom in" disabled={scale >= maxZoom} onclick={() => (zoom = Math.min(maxZoom, scale * 1.25))}>+</button>
        {/if}
        <button class="btn btn-ghost btn-icon dialog-close" type="button" aria-label="Close attachment" data-autofocus onclick={onClose}><AddCloseIcon /></button>
      </div>
    </div>
    {#if error}<p class="attachment-status" role="alert">{error}</p>{/if}
    {#if source === undefined && !error}
      <p class="attachment-status" role="status">Opening attachment…</p>
    {:else if source !== undefined && image}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="attachment-canvas" role="region" aria-label="Image preview" tabindex="0" bind:clientWidth={width} bind:clientHeight={height}>
        <img src={source} alt={file.name} draggable="false" onload={imageLoaded} onerror={() => (error = 'Could not display this image.')} style:width={scale ? `${Math.floor(naturalWidth * scale)}px` : undefined} />
      </div>
    {:else if source !== undefined}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre class="attachment-text" role="region" aria-label="File contents" tabindex="0">{source}</pre>
    {/if}
  </div>
</div>

<style>
  .attachment-viewer {
    display: flex;
    flex-direction: column;
    width: min(68rem, 92vw);
    max-width: none;
    max-height: 88vh;
    min-width: 0;
    overflow: hidden;
    padding: 0;
    border: 1px solid var(--modal-border);
    border-radius: var(--radius-xl);
    background: var(--modal-bg);
  }
  .attachment-head {
    flex: 0 0 auto;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
  }
  .attachment-head .modal-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .attachment-controls {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--space-1);
  }
  .attachment-scale {
    min-width: 2.5rem;
    color: var(--text-2);
    font-size: var(--text-label);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .attachment-canvas, .attachment-text {
    min-height: 0;
    height: min(70vh, 48rem);
    overflow: auto;
    background: var(--bg);
  }
  .attachment-canvas {
    display: flex;
  }
  .attachment-canvas img {
    display: block;
    flex: 0 0 auto;
    align-self: flex-start;
    margin: auto;
  }
  .attachment-text {
    padding: var(--space-4);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    -webkit-user-select: text;
    user-select: text;
  }
  .attachment-status {
    padding: var(--space-3);
    color: var(--text-2);
  }
</style>
