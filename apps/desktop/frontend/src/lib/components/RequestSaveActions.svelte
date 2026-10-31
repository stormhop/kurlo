<script lang="ts">
  let {
    saveDirty = false,
    canRevert = false,
    saveShortcut = '',
    disabled = false,
    onSave = () => {},
    onRevert = () => {},
  }: {
    saveDirty?: boolean;
    canRevert?: boolean;
    saveShortcut?: string;
    disabled?: boolean;
    onSave?: () => void;
    onRevert?: () => void;
  } = $props();
</script>

<div class="request-meta-actions">
  <button class="btn btn-ghost btn-icon btn-sm save-btn revert-btn" class:dirty={canRevert} type="button" onclick={onRevert} title="Revert unsaved changes" aria-label="Revert unsaved changes" disabled={disabled || !canRevert}>
    <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M4.2 3.2H2v-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M2.3 3.1A4.5 4.5 0 117 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>
  </button>
  <button class="btn btn-ghost btn-sm save-btn" class:dirty={saveDirty} type="button" onclick={onSave} title={saveShortcut ? `Save (${saveShortcut})` : 'Save'} disabled={disabled || !saveDirty}>
    <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M2 2h7.5L11 3.5V11H2V2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
      <rect x="4" y="7.5" width="5" height="3" rx="0.5" stroke="currentColor" stroke-width="1.1"/>
      <rect x="4.5" y="2" width="3.5" height="2.5" rx="0.5" stroke="currentColor" stroke-width="1.1"/>
    </svg>
    <span class="save-btn-label">{saveDirty ? 'Save' : 'Saved'}</span>
  </button>
</div>
