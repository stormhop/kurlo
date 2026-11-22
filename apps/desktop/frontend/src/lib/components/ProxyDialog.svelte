<script lang="ts">
  import type { Snippet } from 'svelte';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import { trapFocus } from '../a11y';
  import { portal } from '../portal';

  let {
    title,
    subtitle = '',
    submitLabel,
    busy,
    wide = false,
    onSubmit,
    onDismiss,
    children,
  }: {
    title: string;
    subtitle?: string;
    submitLabel: string;
    busy: boolean;
    wide?: boolean;
    onSubmit: () => void;
    onDismiss: () => void;
    children: Snippet;
  } = $props();

  const id = `capture-dialog-${Math.random().toString(36).slice(2)}`;

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
    }
  }
</script>

<div class="dialog-backdrop" role="presentation" use:portal onmousedown={event => event.target === event.currentTarget && onDismiss()} onkeydown={onKeydown}>
  <div class="modal capture-dialog" class:wide role="dialog" aria-modal="true" aria-labelledby={id} tabindex="-1" use:trapFocus>
  <form class="capture-dialog-form" onsubmit={event => { event.preventDefault(); onSubmit(); }}>
    <div class="modal-head dialog-head">
      <div>
        <h2 class="modal-title" id={id}>{title}</h2>
        {#if subtitle}<p class="capture-dialog-sub">{subtitle}</p>{/if}
      </div>
      <button type="button" class="btn btn-ghost btn-icon dialog-close" onclick={onDismiss} aria-label="Close dialog"><AddCloseIcon /></button>
    </div>
    <div class="capture-dialog-body">
      {@render children()}
    </div>
    <div class="modal-foot dialog-actions">
      <button class="btn btn-secondary btn-lg" type="button" onclick={onDismiss}>Cancel</button>
      <button class="btn btn-primary btn-lg" type="submit" disabled={busy}>{submitLabel}</button>
    </div>
  </form>
  </div>
</div>
