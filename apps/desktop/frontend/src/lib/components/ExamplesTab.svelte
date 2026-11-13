<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import { statusClass } from '../utils';
  import ExampleDetail from './ExampleDetail.svelte';

  let selected = $derived(vm.selectedExample());
</script>

<div class="examples-tab">
  {#if !vm.requestExamplesLoaded}
    <div class="empty-state examples-empty" role="status">
      <p class="empty-state-text examples-empty-hint">Loading examples…</p>
    </div>
  {:else if vm.requestExamples.length === 0}
    <div class="empty-state examples-empty">
      <p class="empty-state-title examples-empty-title">No saved examples</p>
      <p class="empty-state-text examples-empty-hint">
        Send the request, then use <strong>Save as example</strong> in the response panel to keep what
        came back. Examples travel with the workspace, so a saved response is reviewable in Git.
      </p>
    </div>
  {:else}
    <div class="examples-layout">
      <div class="examples-list" role="listbox" aria-label="Saved examples" tabindex="-1">
        {#each vm.requestExamples as example, index (example.id)}
          <div class="examples-row" class:active={selected?.id === example.id}>
            <button
              class="examples-row-main"
              type="button"
              role="option"
              aria-selected={selected?.id === example.id}
              onclick={() => vm.selectExample(example.id)}
            >
              <span class="examples-status {statusClass(example.response.statusCode)}">
                {example.response.statusCode || '—'}
              </span>
              <span class="examples-name">{example.name}</span>
            </button>
            <div class="examples-row-actions">
              <button
                class="btn btn-ghost btn-icon btn-xs examples-move"
                type="button"
                aria-label="Move {example.name} up"
                disabled={index === 0}
                onclick={() => vm.moveExample(example.id, -1)}
              >↑</button>
              <button
                class="btn btn-ghost btn-icon btn-xs examples-move"
                type="button"
                aria-label="Move {example.name} down"
                disabled={index === vm.requestExamples.length - 1}
                onclick={() => vm.moveExample(example.id, 1)}
              >↓</button>
              <button
                class="btn btn-ghost btn-icon btn-xs examples-move"
                type="button"
                aria-label="Rename {example.name}"
                onclick={() => vm.renameExample(example.id)}
              >✎</button>
              <button
                class="btn btn-ghost btn-icon btn-xs examples-move examples-delete"
                type="button"
                aria-label="Delete {example.name}"
                onclick={() => vm.deleteExample(example.id)}
              >✕</button>
            </div>
          </div>
        {/each}
      </div>

      {#if selected}
        {#key selected.id}
          <ExampleDetail example={selected} />
        {/key}
      {/if}
    </div>
  {/if}
</div>
