<script lang="ts">
  import type { KVRow } from '../types/models';

  let {
    rows,
    autosave,
    saveState,
    updateRow,
    removeRow,
    clearAll,
    save,
  }: {
    rows: KVRow[];
    autosave: boolean;
    saveState: 'idle' | 'dirty' | 'saving' | 'saved';
    updateRow: (index: number, patch: Partial<KVRow>) => void;
    removeRow: (index: number) => void;
    clearAll: () => void;
    save: () => void;
  } = $props();

  let filled = $derived(rows.filter(row => row.key.trim() !== '').length);
  let saveLabel = $derived(
    saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'dirty' ? 'Unsaved changes' : '',
  );
</script>

<div class="globals-workspace">
  <header class="globals-header">
    <div class="globals-heading">
      <h2>Global variables</h2>
      <p>
        Available to every request in every workspace, and the scope
        <code>pm.globals.set()</code> writes to. An environment value with the same name wins.
      </p>
    </div>
    <div class="globals-actions">
      {#if saveLabel}<span class="globals-save-state" class:dirty={saveState === 'dirty'}>{saveLabel}</span>{/if}
      {#if !autosave}
        <button class="btn btn-primary" type="button" onclick={save} disabled={saveState === 'saving'}>Save</button>
      {/if}
      <button class="btn btn-ghost" type="button" onclick={clearAll} disabled={!filled}>Clear all</button>
    </div>
  </header>

  <div class="globals-table" role="table" aria-label="Global variables">
    <div class="globals-row globals-row-head" role="row">
      <span role="columnheader" class="globals-col-toggle"><span class="sr-only">Enabled</span></span>
      <span role="columnheader">Variable</span>
      <span role="columnheader">Value</span>
      <span role="columnheader" class="globals-col-actions"><span class="sr-only">Actions</span></span>
    </div>
    {#each rows as row, index (row.id)}
      <div class="globals-row" role="row">
        <span role="cell" class="globals-col-toggle">
          <input
            class="check"
            type="checkbox"
            checked={row.enabled}
            aria-label={`Enable ${row.key || 'variable'}`}
            onchange={event => updateRow(index, { enabled: event.currentTarget.checked })}
          />
        </span>
        <span role="cell">
          <input
            class="field field-bare globals-input"
            value={row.key}
            placeholder="name"
            spellcheck="false"
            aria-label="Variable name"
            oninput={event => updateRow(index, { key: event.currentTarget.value })}
          />
        </span>
        <span role="cell">
          <input
            class="field field-bare globals-input globals-input-mono"
            value={row.value}
            type={row.secret ? 'password' : 'text'}
            placeholder="value"
            spellcheck="false"
            aria-label="Variable value"
            oninput={event => updateRow(index, { value: event.currentTarget.value })}
          />
        </span>
        <span role="cell" class="globals-col-actions">
          <button
            class="btn btn-ghost btn-sm globals-secret-toggle"
            class:active={row.secret}
            type="button"
            aria-pressed={Boolean(row.secret)}
            title={row.secret ? 'Shown as a secret' : 'Mark as secret'}
            onclick={() => updateRow(index, { secret: !row.secret })}
          >Secret</button>
          <button
            class="btn btn-ghost btn-icon btn-xs globals-remove"
            type="button"
            aria-label={`Remove ${row.key || 'variable'}`}
            onclick={() => removeRow(index)}
          >×</button>
        </span>
      </div>
    {/each}
  </div>
</div>

<style>
  .globals-workspace {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .globals-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-5);
    padding: var(--space-8) var(--space-12) 0;
  }

  .globals-heading h2 {
    margin: 0;
    color: var(--text);
    font-size: var(--text-display);
    font-weight: var(--weight-semibold);
    letter-spacing: -0.02em;
    line-height: var(--leading-tight);
  }

  .globals-heading p {
    margin: var(--space-1-5) 0 0;
    max-width: 70ch;
    color: var(--text-2);
    font-size: var(--text-body);
    line-height: var(--leading-normal);
  }

  .globals-heading code {
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }

  .globals-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2-5);
    flex-shrink: 0;
  }

  .globals-save-state {
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .globals-save-state.dirty { color: var(--accent); }

  .globals-table {
    display: flex;
    flex-direction: column;
    margin: var(--space-6) var(--space-12) var(--space-12);
    border-top: 1px solid var(--border-subtle);
  }

  .globals-row {
    display: grid;
    grid-template-columns: 2.125rem minmax(8.75rem, 1fr) minmax(11.25rem, 2fr) 6.875rem;
    align-items: center;
    gap: var(--space-2);
    min-height: 2.125rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .globals-row-head {
    color: var(--text-3);
    font-size: var(--text-label);
    font-weight: var(--weight-medium);
  }

  .globals-col-toggle { display: grid; place-items: center; }

  .globals-col-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-1);
  }

  .globals-input {
    width: 100%;
  }
  .globals-input-mono { font-family: var(--font-mono); font-size: var(--text-code); }
  .globals-secret-toggle.active {
    color: var(--accent-hover);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
