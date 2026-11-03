<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import type { UpdateInfo } from '../backend';

  let {
    info,
    ready = false,
    installing = false,
    onDismiss,
    onOpen,
    onDownload,
    onRestart,
  }: {
    info: UpdateInfo;
    ready?: boolean;
    installing?: boolean;
    onDismiss: () => void;
    onOpen: () => void;
    onDownload: (info: UpdateInfo) => void;
    onRestart: () => void;
  } = $props();

  let manualInstall = $derived(Boolean(info.manualInstallUrl) && !ready);
  let actionLabel = $derived(installing ? 'Installing…' : (ready ? 'Restart' : (manualInstall ? 'Download' : 'View')));
  let handleAction = $derived(ready ? onRestart : (manualInstall ? () => onDownload(info) : onOpen));
  let statusLabel = $derived(installing ? 'is installing' : (ready ? 'is ready — restart to apply' : 'is available'));
</script>

<div class="update-notif" role="status" aria-live="polite">
  <svg class="update-notif-icon" class:ready width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    {#if ready}
      <circle cx="7" cy="7" r="5.8" stroke="currentColor" stroke-width="1.3"/>
      <path d="M4.6 7.1l1.7 1.7 3.2-3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    {:else}
      <path d="M7 2v7M4.2 6.4 7 9.2l2.8-2.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M2.5 11.8h9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    {/if}
  </svg>
  <span class="update-notif-text">
    Kurlo <strong>{info.version}</strong> {statusLabel}
  </span>
  <button class="btn btn-primary btn-sm update-notif-btn" type="button" onclick={handleAction} disabled={installing}>{actionLabel}</button>
  <button class="btn btn-ghost btn-icon btn-sm update-notif-close" type="button" onclick={onDismiss} aria-label="Dismiss">
    <AddCloseIcon />
  </button>
</div>

<style>
  .update-notif {
    position: fixed;
    bottom: 2.25rem;
    right: 1rem;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1-5) var(--space-1-5) var(--space-1-5) var(--space-3);
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2), 0 10px 30px rgba(0, 0, 0, 0.35);
    z-index: 300;
    animation: notif-in 0.18s ease;
  }

  @keyframes notif-in {
    from { opacity: 0; transform: translateY(0.375rem); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .update-notif {
      animation: none;
    }
  }

  .update-notif-icon {
    flex-shrink: 0;
    color: var(--text-3);
  }

  .update-notif-icon.ready {
    color: var(--s2xx);
  }

  .update-notif-text {
    font-size: var(--text-body);
    color: var(--text-2);
    white-space: nowrap;
  }

  .update-notif-text strong {
    color: var(--text);
    font-weight: var(--weight-semibold);
  }

  .update-notif-btn {
    margin-left: var(--space-1);
    white-space: nowrap;
  }

  .update-notif-close {
    display: grid;
    place-items: center;
  }
</style>
