<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import { vm } from '../stores/app.svelte';

  function inputValue(event: Event): string {
    const target = event.currentTarget;
    return target instanceof HTMLInputElement ? target.value : '';
  }
</script>

<div class="sio-events-wrap">
  <div class="sio-events-header">
    <span class="sio-col-event">Event name</span>
    <span class="sio-col-listen">Listen</span>
    <span class="sio-col-desc">Description</span>
    <span class="sio-col-del"></span>
  </div>
  <div class="sio-events-body">
    {#each vm.sioEventsWithTrailing() as row (row.id)}
      <div class="sio-event-row" class:sio-row-disabled={!row.enabled}>
        <div class="sio-col-event">
          <input
            class="field field-bare sio-input"
            type="text"
            value={row.key}
            placeholder="Add event…"
            spellcheck="false"
            oninput={(event) => vm.updateSioEventRow(row.id, { key: inputValue(event) })}
          />
        </div>
        <div class="sio-col-listen">
          <button
            class="btn btn-secondary btn-sm sio-listen-btn"
            class:active={row.enabled}
            type="button"
            onclick={() => vm.updateSioEventRow(row.id, { enabled: !row.enabled })}
          >
            <span class="sio-listen-dot"></span>
            {row.enabled ? 'On' : 'Off'}
          </button>
        </div>
        <div class="sio-col-desc">
          <input
            class="field field-bare sio-input"
            type="text"
            value={row.description}
            placeholder="Description"
            spellcheck="false"
            oninput={(event) => vm.updateSioEventRow(row.id, { description: inputValue(event) })}
          />
        </div>
        <div class="sio-col-del">
          {#if row.key !== ''}
            <button
              class="btn btn-ghost btn-icon btn-xs sio-del-btn"
              type="button"
              onclick={() => vm.removeSioEventRow(row.id)}
              aria-label="Remove event"
            ><AddCloseIcon /></button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .sio-events-wrap {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: auto;
    font-size: var(--text-body);
  }

  .sio-events-header {
    display: flex;
    align-items: center;
    padding: 0 var(--space-1-5);
    height: 1.875rem;
    border-bottom: 1px solid var(--border);
    font-size: var(--text-caption);
    font-weight: var(--weight-medium);
    color: var(--text-2);
    flex-shrink: 0;
  }

  .sio-events-body {
    flex: 1;
    overflow-y: auto;
  }

  .sio-event-row {
    display: flex;
    align-items: center;
    padding: 0 var(--space-1-5);
    min-height: 2.125rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .sio-event-row:hover { background: var(--hover); }

  .sio-col-event { flex: 0 0 38%; min-width: 0; padding-right: var(--space-1); }
  .sio-col-listen { flex: 0 0 5rem; display: flex; justify-content: center; }
  .sio-col-desc { flex: 1; min-width: 0; padding-left: var(--space-1); padding-right: var(--space-1); }
  .sio-col-del { flex: 0 0 1.75rem; display: flex; justify-content: center; }

  .sio-input {
    width: 100%;
    font-family: inherit;
  }
  .sio-input:focus {
    border-radius: var(--radius-xs);
  }
  .sio-row-disabled .sio-input { opacity: 0.4; }

  .sio-listen-btn {
    display: inline-flex;
  }
  .sio-listen-btn.active {
    background: var(--success-bg);
    border-color: var(--success-border);
    color: var(--success);
  }

  .sio-listen-dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.8;
  }
</style>
