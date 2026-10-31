<script lang="ts">
  import { trapFocus } from '../a11y';
  import type { WorkspaceSecretRef } from '../backend';
  import { groupWorkspaceSecrets, type SecretLabelContext } from '../secretLabels';

  let {
    secrets,
    values,
    saving,
    error,
    context,
    onUpdate,
    onSave,
    onDismiss,
  }: {
    secrets: WorkspaceSecretRef[];
    values: Record<string, string>;
    saving: boolean;
    error: string;
    context: SecretLabelContext;
    onUpdate: (key: string, value: string) => void;
    onSave: () => void | Promise<void>;
    onDismiss: () => void;
  } = $props();

  const groups = $derived(groupWorkspaceSecrets(secrets, context));
  const filled = $derived(secrets.filter(secret => (values[secret.key] ?? '').length > 0).length);
  const firstKey = $derived(groups[0]?.items[0]?.key ?? '');
</script>

<div class="dialog-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onDismiss()}>
  <div class="modal missing-secrets-modal" role="dialog" aria-modal="true" aria-labelledby="missing-secrets-title" aria-describedby="missing-secrets-intro" tabindex="-1" use:trapFocus>
    <div class="modal-head dialog-head">
      <h2 class="modal-title" id="missing-secrets-title">Add secrets on this computer</h2>
      <button type="button" class="btn btn-ghost btn-icon dialog-close" onclick={onDismiss} aria-label="Close dialog">×</button>
    </div>
    <div class="missing-secrets-body">
      <p id="missing-secrets-intro">Secret values stay on the device where they were entered and never go into Git, so {secrets.length === 1 ? 'one secret this workspace uses is' : `${secrets.length} secrets this workspace uses are`} not on this computer yet. Fill in the ones you need now; anything left empty can be added later where it is used.</p>
      <div class="missing-secrets-groups">
        {#each groups as group (group.key)}
          <section class="missing-secrets-group" aria-label={group.title}>
            <header class="missing-secrets-group-head">
              <span class="missing-secrets-kind kind-{group.kind}" aria-hidden="true">
                {#if group.kind === 'request'}
                  <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
                {:else if group.kind === 'collection'}
                  <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.2h4l1.3 1.3h5.7v6.3a1.2 1.2 0 01-1.2 1.2H3.7a1.2 1.2 0 01-1.2-1.2V4.2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
                {:else if group.kind === 'environment'}
                  <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none"><path d="M4 3h8M4 8h8M4 13h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="6" cy="3" r="1.4" fill="currentColor"/><circle cx="10" cy="8" r="1.4" fill="currentColor"/><circle cx="7" cy="13" r="1.4" fill="currentColor"/></svg>
                {:else if group.kind === 'cookies'}
                  <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="6.5" r="0.9" fill="currentColor"/><circle cx="9.8" cy="9.5" r="0.9" fill="currentColor"/><circle cx="6.5" cy="10.2" r="0.7" fill="currentColor"/></svg>
                {:else}
                  <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2" stroke="currentColor" stroke-width="1.3"/></svg>
                {/if}
              </span>
              <span class="missing-secrets-group-title">{group.title}</span>
              {#if group.detail}<span class="missing-secrets-group-detail">{group.detail}</span>{/if}
            </header>
            {#each group.items as item (item.key)}
              <label class="missing-secrets-item" title={item.key}>
                <span class="missing-secrets-item-label">
                  <span>{item.title}</span>
                  {#if item.detail}<small>{item.detail}</small>{/if}
                </span>
                <input class="field field-mono"
                  type="password"
                  value={values[item.key] ?? ''}
                  placeholder="Paste value"
                  autocomplete="off"
                  spellcheck="false"
                  aria-label={`${group.title}: ${item.title}`}
                  data-autofocus={item.key === firstKey ? '' : undefined}
                  oninput={(event) => onUpdate(item.key, event.currentTarget.value)}
                />
              </label>
            {/each}
          </section>
        {/each}
      </div>
      {#if error}
        <div class="missing-secrets-error">{error}</div>
      {/if}
    </div>
    <div class="modal-foot dialog-actions">
      <button class="btn btn-secondary btn-lg" type="button" onclick={onDismiss} disabled={saving}>Later</button>
      <button class="btn btn-primary btn-lg" type="button" onclick={onSave} disabled={saving || !filled}>{saving ? 'Saving…' : filled ? `Save ${filled} ${filled === 1 ? 'secret' : 'secrets'}` : 'Save secrets'}</button>
    </div>
  </div>
</div>
