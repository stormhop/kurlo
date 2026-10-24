<script lang="ts">
  import { onMount } from 'svelte';
  import { trapFocus } from '../a11y';
  import { FIND_DEBOUNCE_MS, buildFindRegExp, expandReplacement, findInRequests, replaceMatches, type FindMatch, type FindOptions } from '../findReplace';
  import type { FindReplaceUndo } from '../stores/features/findReplace';
  import type { SavedRequest } from '../types/models';
  import RequestTypeBadge from './RequestTypeBadge.svelte';

  let {
    scopeLabel,
    requests,
    unsavedIds,
    undo,
    requestLabel,
    onApply,
    onUndo,
    onOpenRequest,
    onClose,
  }: {
    scopeLabel: string;
    requests: SavedRequest[];
    unsavedIds: Set<string>;
    undo: FindReplaceUndo | null;
    requestLabel: (request: SavedRequest) => string;
    onApply: (changed: SavedRequest[], replaced: number) => Promise<boolean>;
    onUndo: () => Promise<boolean>;
    onOpenRequest: (id: string) => void;
    onClose: () => void;
  } = $props();

  let query = $state('');
  let searchQuery = $state('');
  let replacement = $state('');
  let options = $state<FindOptions>({ matchCase: false, wholeWord: false, regex: false });
  let busy = $state(false);
  let notice = $state('');
  let findInput = $state<HTMLInputElement>();

  let searchable = $derived(requests.filter(req => !unsavedIds.has(req.id)));
  let skipped = $derived(requests.length - searchable.length);
  let result = $derived(findInRequests(searchable, searchQuery, options));
  let groups = $derived(searchable
    .map(request => ({ request, matches: result.matches.filter(match => match.requestId === request.id) }))
    .filter(group => group.matches.length));
  let matchedRequests = $derived(new Set(result.matches.map(match => match.requestId)).size);

  onMount(() => {
    setTimeout(() => findInput?.focus(), 0);
  });

  $effect(() => {
    const next = query;
    if (!next) {
      searchQuery = '';
      return;
    }
    const timer = setTimeout(() => (searchQuery = next), FIND_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  function previewReplacement(match: FindMatch) {
    if (!options.regex) return replacement;
    try {
      const exec = new RegExp(buildFindRegExp(searchQuery, options).source, options.matchCase ? '' : 'i').exec(match.text);
      return exec ? expandReplacement(replacement, exec) : replacement;
    } catch {
      return replacement;
    }
  }

  function toggle(option: keyof FindOptions) {
    options = { ...options, [option]: !options[option] };
  }

  async function apply(scope: SavedRequest[], matches?: FindMatch[]) {
    if (busy || !searchQuery) return;
    const replaced = replaceMatches(scope, searchQuery, replacement, options, matches);
    if (replaced.error || !replaced.requests.length) {
      notice = replaced.error || 'Nothing changed: the text moved since it was found.';
      return;
    }
    busy = true;
    try {
      const ok = await onApply(replaced.requests, replaced.replaced);
      notice = ok ? '' : 'The changes could not be saved.';
    } finally {
      busy = false;
    }
  }

  async function undoLast() {
    if (busy) return;
    busy = true;
    try {
      if (!(await onUndo())) notice = 'Undo failed: the changes could not be saved.';
    } finally {
      busy = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }
</script>

<div class="dialog-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onClose()}>
  <div class="modal find-replace-modal" role="dialog" aria-modal="true" aria-labelledby="find-replace-title" tabindex="-1" use:trapFocus onkeydown={onKeydown}>
    <div class="modal-head dialog-head">
      <div class="find-replace-heading">
        <h2 class="modal-title" id="find-replace-title">Find and replace</h2>
        <span class="find-replace-scope" title={scopeLabel}>{scopeLabel}</span>
      </div>
      <button type="button" class="btn btn-ghost btn-icon dialog-close" onclick={onClose} aria-label="Close dialog">×</button>
    </div>

    <div class="find-replace-form">
      <div class="find-replace-row">
        <input class="field field-input" bind:this={findInput} bind:value={query} placeholder="Find" aria-label="Find" spellcheck="false" data-autofocus />
        <div class="find-replace-toggles" role="group" aria-label="Search options">
          <button type="button" class="btn btn-ghost btn-sm find-replace-toggle" class:active={options.matchCase} aria-pressed={options.matchCase} title="Match case" aria-label="Match case" onclick={() => toggle('matchCase')}>Aa</button>
          <button type="button" class="btn btn-ghost btn-sm find-replace-toggle" class:active={options.wholeWord} aria-pressed={options.wholeWord} title="Whole word" aria-label="Whole word" onclick={() => toggle('wholeWord')}><u>ab</u></button>
          <button type="button" class="btn btn-ghost btn-sm find-replace-toggle" class:active={options.regex} aria-pressed={options.regex} title="Regular expression ($1 refers to a group in the replacement)" aria-label="Regular expression" onclick={() => toggle('regex')}>.*</button>
        </div>
      </div>
      <div class="find-replace-row">
        <input class="field field-input" bind:value={replacement} placeholder="Replace" aria-label="Replace" spellcheck="false" />
        <button type="button" class="btn btn-primary" disabled={busy || !result.total || Boolean(result.error)} onclick={() => apply(searchable)}>
          Replace all{result.total ? ` (${result.total})` : ''}
        </button>
      </div>
      <div class="find-replace-status" role="status">
        {#if result.error}
          <span class="find-replace-error">{result.error}</span>
        {:else if searchQuery}
          {result.total} match{result.total === 1 ? '' : 'es'} in {matchedRequests} request{matchedRequests === 1 ? '' : 's'}{result.truncated ? ` — showing the first ${result.matches.length}` : ''}
        {:else}
          Searches the URL, query, path variables, headers, form fields, body, scripts, docs and auth fields that hold no secret.
        {/if}
        {#if skipped}
          <span class="find-replace-skipped">{skipped} request{skipped === 1 ? ' has' : 's have'} unsaved changes and {skipped === 1 ? 'is' : 'are'} skipped — save them first.</span>
        {/if}
        {#if notice}<span class="find-replace-error">{notice}</span>{/if}
      </div>
      {#if undo}
        <div class="find-replace-undo" role="status">
          <span>Replaced {undo.replaced} match{undo.replaced === 1 ? '' : 'es'} in {undo.after.length} request{undo.after.length === 1 ? '' : 's'}.</span>
          <button type="button" class="btn btn-secondary btn-sm" disabled={busy} onclick={undoLast}>Undo</button>
        </div>
      {/if}
    </div>

    <div class="find-replace-results" aria-label="Matches">
      {#each groups as group (group.request.id)}
        <section class="find-replace-group">
          <div class="find-replace-group-head">
            <RequestTypeBadge request={group.request} variant="search" />
            <button type="button" class="btn-link find-replace-request" title="Open request" onclick={() => onOpenRequest(group.request.id)}>{requestLabel(group.request)}</button>
            <span class="find-replace-count">{group.matches.length}</span>
            <button type="button" class="btn btn-ghost btn-sm" disabled={busy} onclick={() => apply([group.request])}>Replace in request</button>
          </div>
          {#each group.matches as match (match.key)}
            <div class="find-replace-match">
              <span class="find-replace-field">{match.fieldLabel}{match.line > 1 ? ` · line ${match.line}` : ''}</span>
              <code class="find-replace-context">{match.before}<mark class:replaced={replacement !== ''}>{match.text}</mark>{#if replacement !== ''}<ins>{previewReplacement(match)}</ins>{/if}{match.after}</code>
              <button type="button" class="btn btn-ghost btn-sm" disabled={busy} onclick={() => apply([group.request], [match])}>Replace</button>
            </div>
          {/each}
        </section>
      {/each}
    </div>
  </div>
</div>
