<script lang="ts">
  import Select from './Select.svelte';
  import type { HttpResponse } from '../backend';
  import { collapseUnchanged, type DiffChunk, type ResponseDiff } from '../responseDiff';

  let {
    diff,
    previous,
    current,
    baselineLabel = 'previous',
    options = [],
    selectedId = '',
    onSelect = () => {},
    onDismiss,
  }: {
    diff: ResponseDiff | null;
    previous: HttpResponse | null;
    current: HttpResponse | null;
    baselineLabel?: string;
    options?: Array<{ id: string; label: string }>;
    selectedId?: string;
    onSelect?: (exampleId: string) => void;
    onDismiss: () => void;
  } = $props();

  let collapsed = $state(true);
  let chunks = $derived<DiffChunk[]>(diff ? (collapsed ? collapseUnchanged(diff.lines, 3) : [{ kind: 'lines', lines: diff.lines }]) : []);

  function sign(kind: 'equal' | 'added' | 'removed') {
    return kind === 'added' ? '+' : kind === 'removed' ? '−' : ' ';
  }
</script>

<div class="diff-panel" id="response-panel-diff" role="tabpanel">
  {#if !diff || !previous || !current}
    <div class="diff-empty">
      {#if options.length}
        Send this request to compare what comes back with the selected baseline.
      {:else}
        Send this request again to compare the new response with this one.
      {/if}
    </div>
  {:else}
    <div class="diff-bar">
      <div class="diff-bar-meta">
        <span class="diff-side diff-side-before">
          {baselineLabel} · {previous.statusCode}{#if previous.duration} · {previous.duration} ms{/if}
        </span>
        <span class="diff-arrow" aria-hidden="true">→</span>
        <span class="diff-side diff-side-after">
          current · {current.statusCode} · {current.duration} ms
        </span>
      </div>
      <div class="diff-bar-actions">
        {#if options.length > 1}
          <label class="diff-baseline-picker">
            <span>Compare with</span>
            <Select value={selectedId} options={options.map(option => ({ value: option.id, label: option.label }))} className="diff-baseline-select" ariaLabel="Compare with" onChange={onSelect} />
          </label>
        {/if}
        {#if diff.identical}
          <span class="diff-count diff-count-same">No changes</span>
        {:else}
          <span class="diff-count diff-count-add">+{diff.added}</span>
          <span class="diff-count diff-count-del">−{diff.removed}</span>
        {/if}
        {#if !diff.identical}
          <button class="btn btn-ghost btn-sm" type="button" onclick={() => (collapsed = !collapsed)}>
            {collapsed ? 'Show all lines' : 'Collapse unchanged'}
          </button>
        {/if}
        <button class="btn btn-ghost btn-sm" type="button" onclick={onDismiss}>Clear baseline</button>
      </div>
    </div>

    {#if diff.approximate}
      <p class="diff-note">
        The changed region was too large for an exact comparison, so lines are matched by position.
      </p>
    {/if}

    {#if diff.identical}
      <div class="diff-empty">Both responses have identical bodies.</div>
    {:else}
      <div class="diff-lines">
        {#each chunks as chunk, eachIndex (eachIndex)}
          {#if chunk.kind === 'gap'}
            <div class="diff-gap">{chunk.count} unchanged line{chunk.count === 1 ? '' : 's'}</div>
          {:else}
            {#each chunk.lines as line, eachIndex (eachIndex)}
              <div class="diff-line diff-{line.kind}">
                <span class="diff-num">{line.beforeLine ?? ''}</span>
                <span class="diff-num">{line.afterLine ?? ''}</span>
                <span class="diff-sign" aria-hidden="true">{sign(line.kind)}</span>
                <span class="diff-text">{line.text}</span>
              </div>
            {/each}
          {/if}
        {/each}
      </div>
    {/if}
  {/if}
</div>
