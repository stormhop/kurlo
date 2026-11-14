<script lang="ts">
  import BirdLoader from './BirdLoader.svelte';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import CodeEditor from '../CodeEditor.svelte';
  import Markdown from './Markdown.svelte';
  import { vm } from '../stores/app.svelte';
  import { agentNotesEditor as notes } from '../stores/agentNotes.svelte';
  import { AGENT_NOTES_FILE, agentNotesSize, agentNotesTemplateCount } from '../agentNotes';

  const folder = $derived(notes.path.endsWith(AGENT_NOTES_FILE) ? notes.path.slice(0, -AGENT_NOTES_FILE.length).replace(/[\\/]$/, '') : '');
  const templates = $derived(agentNotesTemplateCount(notes.content));
  const canSave = $derived(!notes.loading && !notes.saving && !notes.tooLarge && !notes.overLimit && (notes.dirty || !notes.exists));

  async function close() {
    if (notes.saving) return;
    if (notes.dirty && !(await vm.openConfirmDialog('Discard changes', `Your changes to ${AGENT_NOTES_FILE} are not saved.`, 'Discard'))) return;
    notes.close();
  }

  function finish(created: boolean) {
    notes.close();
    const toast = created ? `Created ${AGENT_NOTES_FILE}` : `Saved ${AGENT_NOTES_FILE}`;
    vm.collectionImportToast = toast;
    setTimeout(() => { if (vm.collectionImportToast === toast) vm.collectionImportToast = ''; }, 1800);
  }

  async function save() {
    if (!canSave) return;
    const created = !notes.exists;
    if (await notes.save()) finish(created);
  }

  async function reload() {
    if (await vm.openConfirmDialog('Load the newer version', `Your edits are replaced with ${AGENT_NOTES_FILE} as it is on disk now.`, 'Load')) notes.reloadFromDisk();
  }

  async function overwrite() {
    if (!(await vm.openConfirmDialog('Replace the newer version', `${AGENT_NOTES_FILE} on disk is replaced with your text. The changes made elsewhere are lost unless they are in Git.`, 'Replace'))) return;
    const created = !notes.conflictExists;
    if (await notes.overwrite()) finish(created);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      void close();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  }
</script>

<div class="modal-overlay" role="presentation">
  <div class="modal yaml-editor-modal agent-notes-modal" role="dialog" aria-modal="true" aria-labelledby="agent-notes-title" tabindex="-1" {onkeydown}>
    <div class="modal-head modal-header">
      <div class="yaml-editor-title">
        <span class="modal-title" id="agent-notes-title">{AGENT_NOTES_FILE}</span>
        {#if folder}<small>{folder}</small>{/if}
      </div>
      <div class="segmented agent-notes-view" role="radiogroup" aria-label="Notes view">
        <button class="segmented-item" class:active={!notes.preview} type="button" role="radio" aria-checked={!notes.preview} onclick={() => (notes.preview = false)}>Edit</button>
        <button class="segmented-item" class:active={notes.preview} type="button" role="radio" aria-checked={notes.preview} onclick={() => (notes.preview = true)}>Preview</button>
      </div>
      <button class="btn btn-ghost btn-icon modal-close" type="button" onclick={() => void close()} aria-label="Close"><AddCloseIcon /></button>
    </div>
    {#if !notes.exists && !notes.loading}
      <p class="agent-notes-intro">There is no {AGENT_NOTES_FILE} in this workspace yet. Start from this example: the agent reads the file before every turn, and the entries under <strong>## Templates</strong> show up in the Templates menu. Keep the file in Git so the team shares it.</p>
    {/if}
    <div class="yaml-editor-body agent-notes-body">
      {#if notes.loading}
        <BirdLoader label={`Loading ${AGENT_NOTES_FILE}`} />
      {:else if notes.tooLarge}
        <div class="yaml-editor-loading">{AGENT_NOTES_FILE} is over 32 KB, so Kurlo does not edit it here. Shorten it in another editor.</div>
      {:else if notes.preview}
        <div class="agent-notes-preview" aria-label="Preview">
          {#if notes.content.trim()}<Markdown source={notes.content} />{:else}<p class="agent-notes-empty">Nothing to preview yet.</p>{/if}
        </div>
      {:else}
        <CodeEditor
          bind:value={notes.content}
          language="text"
          fillHeight
          readonly={notes.saving}
          ariaLabel={`Text of ${AGENT_NOTES_FILE}`}
          testId="agent-notes-editor"
        />
      {/if}
    </div>
    <div class="modal-foot modal-footer yaml-editor-foot">
      <div class="yaml-editor-status" class:error={Boolean(notes.error) || notes.overLimit} role="status" aria-live="polite">
        {#if notes.error}
          <span class="yaml-editor-dot" aria-hidden="true"></span>
          <span>{notes.error}</span>
        {:else if !notes.loading && !notes.tooLarge}
          <span>{agentNotesSize(notes.content)}{templates ? ` · ${templates} ${templates === 1 ? 'template' : 'templates'}` : ''}</span>
        {/if}
      </div>
      {#if notes.conflict}
        <button class="btn btn-secondary btn-lg" type="button" onclick={() => void reload()} disabled={notes.saving}>Load newer version</button>
        <button class="btn btn-secondary btn-lg btn-danger" type="button" onclick={() => void overwrite()} disabled={notes.saving}>Replace it</button>
      {:else}
        <button class="btn btn-secondary btn-lg" type="button" onclick={() => void close()} disabled={notes.saving}>Cancel</button>
        <button class="btn btn-primary btn-lg" type="button" onclick={() => void save()} disabled={!canSave}>
          {notes.saving ? 'Saving…' : notes.exists ? 'Save' : 'Create file'}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .agent-notes-modal .modal-head {
    gap: var(--space-3);
  }
  .agent-notes-modal .yaml-editor-title {
    flex: 1 1 auto;
  }
  .agent-notes-modal .modal-title {
    flex: 0 0 auto;
  }
  .agent-notes-view {
    flex: 0 0 auto;
  }
  .agent-notes-intro {
    margin: 0;
    padding: 0 var(--space-5) var(--space-3);
    color: var(--text-2);
    font-size: var(--text-body);
    line-height: var(--leading-normal);
  }
  .agent-notes-intro strong {
    font-family: var(--font-mono);
    font-size: var(--text-code);
    font-weight: var(--weight-medium);
  }
  .agent-notes-preview {
    height: 100%;
    overflow: auto;
    padding: var(--space-4) var(--space-5);
  }
  .agent-notes-empty {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-body);
  }
</style>
