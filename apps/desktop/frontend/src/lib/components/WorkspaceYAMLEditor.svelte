<script lang="ts">
  import CodeEditor from '../CodeEditor.svelte';
  import { checkWorkspaceYAML } from '../backend';
  import { vm } from '../stores/app.svelte';

  let issue = $state<{ line: number; message: string } | null>(null);
  let checked = $state(false);

  const fileName = $derived(vm.yamlEditorPath.slice(vm.yamlEditorPath.lastIndexOf('/') + 1));
  const folder = $derived(vm.yamlEditorPath.includes('/') ? vm.yamlEditorPath.slice(0, vm.yamlEditorPath.lastIndexOf('/')) : '');
  const statusError = $derived(issue ? `Line ${issue.line}: ${issue.message}` : vm.yamlEditorError);

  async function validate(text: string) {
    const path = vm.yamlEditorPath;
    const result = await checkWorkspaceYAML(path, text);
    if (path !== vm.yamlEditorPath) return null;
    issue = result.ok ? null : { line: result.line, message: result.message };
    checked = true;
    return issue;
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !vm.yamlEditorSaving) {
      event.preventDefault();
      vm.closeWorkspaceYAMLEditor();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void vm.saveWorkspaceYAMLEditor();
    }
  }
</script>

<div class="modal-overlay" role="presentation">
  <div class="modal yaml-editor-modal" role="dialog" aria-modal="true" aria-labelledby="yaml-editor-title" tabindex="-1" {onkeydown}>
    <div class="modal-head modal-header">
      <div class="yaml-editor-title">
        <span class="modal-title" id="yaml-editor-title">{fileName || 'Edit YAML'}</span>
        {#if folder}<small title={vm.yamlEditorPath}>{folder}</small>{/if}
      </div>
      <button class="btn btn-ghost btn-icon modal-close" type="button" onclick={vm.closeWorkspaceYAMLEditor} aria-label="Close">&times;</button>
    </div>
    <div class="yaml-editor-body">
      {#if vm.yamlEditorLoading}
        <div class="yaml-editor-loading">Loading YAML&hellip;</div>
      {:else}
        <CodeEditor
          bind:value={vm.yamlEditorContent}
          language="yaml"
          fillHeight
          readonly={vm.yamlEditorSaving}
          ariaLabel={`YAML of ${vm.yamlEditorPath}`}
          testId="yaml-editor"
          {validate}
        />
      {/if}
    </div>
    <div class="modal-foot modal-footer yaml-editor-foot">
      <div class="yaml-editor-status" class:error={Boolean(statusError)} role="status" aria-live="polite" title={statusError || undefined}>
        {#if statusError}
          <span class="yaml-editor-dot" aria-hidden="true"></span>
          <span>{statusError}</span>
        {:else if checked}
          <span class="yaml-editor-dot ok" aria-hidden="true"></span>
          <span>No problems found</span>
        {/if}
      </div>
      <button class="btn btn-secondary btn-lg" type="button" onclick={vm.closeWorkspaceYAMLEditor} disabled={vm.yamlEditorSaving}>Cancel</button>
      <button class="btn btn-primary btn-lg" type="button" onclick={vm.saveWorkspaceYAMLEditor} disabled={vm.yamlEditorLoading || vm.yamlEditorSaving} title="Save (⌘S)">
        {vm.yamlEditorSaving ? 'Saving…' : 'Save YAML'}
      </button>
    </div>
  </div>
</div>
