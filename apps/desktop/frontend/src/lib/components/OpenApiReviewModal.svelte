<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import { trapFocus } from '../a11y';
  import { methodColor } from '../utils';
  import type { OpenApiReviewState } from '../stores/features/openapiSync';
  import type { OpenApiEndpointChange, OpenApiEndpointKind, OpenApiFieldChange, OpenApiSelection } from '../openapiSync';

  let {
    review,
    collectionName,
    onSelection,
    onApply,
    onAcceptAll,
    onSkip,
    onClose,
  }: {
    review: OpenApiReviewState;
    collectionName: string;
    onSelection: (selection: OpenApiSelection) => void;
    onApply: () => void;
    onAcceptAll: () => void;
    onSkip: () => void;
    onClose: () => void;
  } = $props();

  const GROUPS: Array<{ kind: OpenApiEndpointKind; title: string; hint: string }> = [
    { kind: 'new', title: 'New', hint: 'Added to the collection, in the folder of their first tag.' },
    { kind: 'changed', title: 'Changed', hint: 'Only the spec changed these fields, so Kurlo takes the spec version.' },
    { kind: 'conflict', title: 'Conflicts', hint: 'You and the spec both changed these. Your version stays unless you pick the spec.' },
    { kind: 'removed', title: 'Removed from the spec', hint: 'Tick a request to move it to Recently deleted.' },
  ];

  let expanded = $state<Set<string>>(new Set());

  const plan = $derived(review.plan);
  const selection = $derived(review.selection);
  const groups = $derived(GROUPS.map(group => ({ ...group, items: plan.endpoints.filter(endpoint => endpoint.kind === group.kind) })).filter(group => group.items.length));
  const selectedCount = $derived(plan.endpoints.filter(endpoint => selection.selected.has(endpoint.id)).length + (plan.collection && selection.collectionSelected ? 1 : 0));

  function methodOf(key: string) {
    return key.split(' ')[0] ?? '';
  }

  function pathOf(key: string) {
    return key.slice(key.indexOf(' ') + 1);
  }

  function withId(set: Set<string>, id: string, present: boolean): Set<string> {
    const rest = [...set].filter(value => value !== id);
    return new Set(present ? [...rest, id] : rest);
  }

  function toggle(id: string) {
    onSelection({ ...selection, selected: withId(selection.selected, id, !selection.selected.has(id)) });
  }

  function choose(id: string, useSpec: boolean) {
    onSelection({ ...selection, useSpec: withId(selection.useSpec, id, useSpec) });
  }

  function toggleGroup(items: OpenApiEndpointChange[]) {
    const ids = new Set(items.map(item => item.id));
    const all = items.every(item => selection.selected.has(item.id));
    const kept = [...selection.selected].filter(id => !ids.has(id));
    onSelection({ ...selection, selected: new Set(all ? kept : [...kept, ...ids]) });
  }

  function toggleExpanded(id: string) {
    expanded = withId(expanded, id, !expanded.has(id));
  }

  function itemLabel(item: OpenApiEndpointChange) {
    return [item.name, item.renamedFrom ? `moved from ${pathOf(item.renamedFrom)}` : '', fieldNames(item.fields)].filter(Boolean).join(' · ');
  }

  function fieldNames(fields: OpenApiFieldChange[]) {
    return fields.map(field => field.label).join(', ');
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }
</script>

{#snippet fieldDiff(fields: OpenApiFieldChange[])}
  <div class="openapi-review-fields">
    {#each fields as field (field.field)}
      <div class="openapi-review-field" class:conflict={field.conflict}>
        <span class="openapi-review-field-name">{field.label}{#if field.conflict}<span class="openapi-review-tag">conflict</span>{/if}</span>
        <div class="openapi-review-values">
          <div><span class="openapi-review-side">Yours</span><pre>{field.local}</pre></div>
          <div><span class="openapi-review-side">Spec</span><pre>{field.spec}</pre></div>
        </div>
      </div>
    {/each}
  </div>
{/snippet}

<div class="dialog-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onClose()}>
  <div class="modal openapi-review" role="dialog" aria-modal="true" aria-labelledby="openapi-review-title" tabindex="-1" use:trapFocus onkeydown={onKeydown}>
    <div class="modal-head">
      <h2 class="modal-title" id="openapi-review-title">Spec changes · {collectionName}</h2>
      <button type="button" class="btn btn-ghost btn-icon" onclick={onClose} aria-label="Close dialog"><AddCloseIcon /></button>
    </div>
    <div class="openapi-review-body">
      {#if review.firstSync}
        <p class="openapi-review-note">First sync for this collection. Kurlo has no earlier copy of the spec, so every difference from your requests is shown as a conflict. Your version stays unless you pick the spec.</p>
      {/if}
      {#if plan.collection}
        <section class="openapi-review-group" aria-label="Collection settings">
          <div class="openapi-review-group-head"><strong>Collection settings</strong></div>
          <div class="openapi-review-item">
            <div class="openapi-review-row">
              <input type="checkbox" class="check" checked={selection.collectionSelected} aria-label="Apply collection changes" onchange={() => onSelection({ ...selection, collectionSelected: !selection.collectionSelected })} />
              <button class="btn-link openapi-review-name" type="button" onclick={() => toggleExpanded('collection')} aria-expanded={expanded.has('collection')}>
                <span class="openapi-review-path">{fieldNames(plan.collection.fields)}</span>
              </button>
              {#if plan.collection.conflict}
                <div class="segmented" role="radiogroup" aria-label="Collection conflict">
                  <button class="segmented-item" type="button" role="radio" aria-checked={!selection.collectionUseSpec} onclick={() => onSelection({ ...selection, collectionUseSpec: false })}>Keep mine</button>
                  <button class="segmented-item" type="button" role="radio" aria-checked={selection.collectionUseSpec} onclick={() => onSelection({ ...selection, collectionUseSpec: true })}>Use spec</button>
                </div>
              {/if}
            </div>
            {#if expanded.has('collection')}{@render fieldDiff(plan.collection.fields)}{/if}
          </div>
        </section>
      {/if}
      {#each groups as group (group.kind)}
        <section class="openapi-review-group" aria-label={group.title} data-kind={group.kind}>
          <div class="openapi-review-group-head">
            <strong>{group.title} <span class="openapi-review-count">{group.items.length}</span></strong>
            <span>{group.hint}</span>
            <button class="btn-link" type="button" onclick={() => toggleGroup(group.items)}>{group.items.every(item => selection.selected.has(item.id)) ? 'Untick all' : 'Tick all'}</button>
          </div>
          {#each group.items as item (item.id)}
            <div class="openapi-review-item">
              <div class="openapi-review-row">
                <input type="checkbox" class="check" checked={selection.selected.has(item.id)} aria-label={`Apply ${item.key}`} onchange={() => toggle(item.id)} />
                <button class="btn-link openapi-review-name" type="button" disabled={!item.fields.length} onclick={() => toggleExpanded(item.id)} aria-expanded={expanded.has(item.id)}>
                  <span class="collection-method {methodColor(methodOf(item.key))}">{methodOf(item.key)}</span>
                  <span class="openapi-review-path">{pathOf(item.key)}</span>
                  <span class="openapi-review-label">{itemLabel(item)}</span>
                </button>
                {#if item.kind === 'conflict'}
                  <div class="segmented" role="radiogroup" aria-label={`Conflict in ${item.key}`}>
                    <button class="segmented-item" type="button" role="radio" aria-checked={!selection.useSpec.has(item.id)} onclick={() => choose(item.id, false)}>Keep mine</button>
                    <button class="segmented-item" type="button" role="radio" aria-checked={selection.useSpec.has(item.id)} onclick={() => choose(item.id, true)}>Use spec</button>
                  </div>
                {/if}
              </div>
              {#if expanded.has(item.id) && item.fields.length}{@render fieldDiff(item.fields)}{/if}
            </div>
          {/each}
        </section>
      {/each}
    </div>
    <div class="modal-foot openapi-review-foot">
      <button class="btn btn-ghost" type="button" disabled={review.applying} onclick={onSkip}>Skip this version</button>
      <span class="openapi-review-spacer"></span>
      <button class="btn btn-secondary" type="button" disabled={review.applying} onclick={onAcceptAll}>Accept all</button>
      <button class="btn btn-primary" type="button" disabled={review.applying} onclick={onApply}>{review.applying ? 'Applying…' : `Apply ${selectedCount || ''}`.trim()}</button>
    </div>
  </div>
</div>
