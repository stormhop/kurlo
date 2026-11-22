<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import type { ProxyRule } from '../wire';
  import { ruleSummary, type RuleKind } from '../captureRules';

  let {
    rules,
    busy,
    onAdd,
    onEdit,
    onToggle,
    onMove,
    onDelete,
    onClose,
  }: {
    rules: ProxyRule[];
    busy: boolean;
    onAdd: (kind: RuleKind) => void;
    onEdit: (rule: ProxyRule) => void;
    onToggle: (rule: ProxyRule, enabled: boolean) => void;
    onMove: (rule: ProxyRule, offset: number) => void;
    onDelete: (rule: ProxyRule) => void;
    onClose: () => void;
  } = $props();

  let confirming = $state('');

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (confirming) confirming = '';
      else onClose();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside class="capture-rules" aria-label="Capture rules" onkeydown={onKeydown}>
  <header class="capture-rules-head">
    <div>
      <h3>Rules <span class="mock-count">{rules.length}</span></h3>
      <p>Rules apply while recording, in this order. The first matching Map local rule answers. Every matching Rewrite rule applies.</p>
    </div>
    <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Close rules" onclick={onClose}><AddCloseIcon /></button>
  </header>
  <div class="capture-rules-add">
    <button class="btn btn-secondary btn-sm" type="button" disabled={busy} onclick={() => onAdd('local')}>Add Map local</button>
    <button class="btn btn-secondary btn-sm" type="button" disabled={busy} onclick={() => onAdd('rewrite')}>Add Rewrite</button>
  </div>
  <ul class="capture-rules-list">
    {#each rules as rule, index (rule.id)}
      <li class="capture-rule" class:off={!rule.enabled}>
        <label class="switch-control capture-rule-switch">
          <input type="checkbox" checked={rule.enabled} disabled={busy} aria-label={`${rule.enabled ? 'Turn off' : 'Turn on'} ${rule.name || rule.url}`} onchange={event => onToggle(rule, event.currentTarget.checked)} />
          <span class="switch-track"></span>
        </label>
        <button class="capture-rule-main" type="button" disabled={busy} onclick={() => onEdit(rule)}>
          <span class="capture-rule-title">
            <span class="capture-rule-kind" class:rewrite={rule.kind === 'rewrite'}>{rule.kind === 'local' ? 'Map local' : 'Rewrite'}</span>
            <strong>{rule.name || rule.url}</strong>
          </span>
          {#if rule.name}<code>{rule.method || 'Any'} {rule.url}</code>{:else}<code>{rule.method || 'Any method'}</code>{/if}
          <span class="capture-rule-summary">{ruleSummary(rule)}{rule.hits ? ` · used ${rule.hits} ${rule.hits === 1 ? 'time' : 'times'}` : ''}</span>
        </button>
        <span class="capture-rule-actions">
          {#if confirming === rule.id}
            <button class="btn btn-danger btn-xs" type="button" disabled={busy} onclick={() => { confirming = ''; onDelete(rule); }}>Delete</button>
            <button class="btn btn-ghost btn-xs" type="button" onclick={() => (confirming = '')}>Keep</button>
          {:else}
            <button class="btn btn-ghost btn-icon btn-xs" type="button" aria-label={`Move ${rule.name || rule.url} up`} disabled={busy || index === 0} onclick={() => onMove(rule, -1)}>
              <svg width="0.75rem" height="0.75rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>
            </button>
            <button class="btn btn-ghost btn-icon btn-xs" type="button" aria-label={`Move ${rule.name || rule.url} down`} disabled={busy || index === rules.length - 1} onclick={() => onMove(rule, 1)}>
              <svg width="0.75rem" height="0.75rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <button class="btn btn-ghost btn-icon btn-xs" type="button" aria-label={`Delete ${rule.name || rule.url}`} disabled={busy} onclick={() => (confirming = rule.id)}>
              <svg width="0.75rem" height="0.75rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
            </button>
          {/if}
        </span>
      </li>
    {:else}
      <li class="empty-state capture-rules-empty">
        <strong class="empty-state-title">No rules yet</strong>
        <span class="empty-state-text">Map local answers a request with your own response. Rewrite sends it to another server or changes its path and headers. You can also start from a recorded request.</span>
      </li>
    {/each}
  </ul>
</aside>
