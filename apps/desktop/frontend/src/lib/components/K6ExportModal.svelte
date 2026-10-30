<script lang="ts">
  import { tabListKeyboard, trapFocus } from '../a11y';
  import CodeEditor from '../CodeEditor.svelte';
  import type { K6ExportResult, LoadTest } from '../wire';

  let {
    loadTest,
    onExport,
    onSave,
    onSaveFolder,
    onRun,
    runDisabled = false,
    onCopy,
    onClose,
  }: {
    loadTest: LoadTest;
    onExport: (inlineSecrets: boolean, folder: boolean) => Promise<K6ExportResult>;
    onSaveFolder: (inlineSecrets: boolean) => Promise<boolean>;
    onRun: () => void;
    runDisabled?: boolean;
    onSave: (fileName: string, script: string) => Promise<boolean>;
    onCopy: (text: string) => void;
    onClose: () => void;
  } = $props();

  let inlineSecrets = $state(false);
  let result = $state<K6ExportResult | null>(null);
  let loading = $state(true);
  let folder = $state(false);
  let activeFile = $state('script.k6.js');
  let saving = $state(false);
  let saved = $state(false);
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  let request = 0;

  const stepCount = $derived(loadTest.scenarios[0]?.steps.length ?? 0);
  const warnings = $derived(result?.warnings?.filter(warning => warning.level !== 'info') ?? []);
  const notes = $derived(result?.warnings?.filter(warning => warning.level === 'info') ?? []);
  const secretNames = $derived(notes.map(note => /^(\S+) is secret/.exec(note.message)?.[1]).filter((name): name is string => Boolean(name)));
  const command = $derived(`${secretNames.map(name => `${name}=…`).join(' ')}${secretNames.length ? ' ' : ''}k6 run ${result?.fileName || 'load-test.k6.js'}`);

  $effect(() => {
    const inline = inlineSecrets;
    const separate = folder;
    saved = false;
    activeFile = 'script.k6.js';
    const current = ++request;
    loading = true;
    void onExport(inline, separate).then(next => {
      if (current !== request) return;
      result = next;
      loading = false;
    }).catch(() => {
      if (current !== request) return;
      result = { script: '', fileName: '', warnings: [], steps: [], error: 'Could not generate the k6 export.' };
      loading = false;
    });
  });

  async function save() {
    if (!result?.script || loading || saving) return;
    saving = true;
    try {
      saved = folder ? await onSaveFolder(inlineSecrets) : await onSave(result.fileName, result.script);
    } finally {
      saving = false;
    }
  }

  function copy() {
    if (!result?.script) return;
    onCopy(folder ? result.files?.find(file => file.path === activeFile)?.content ?? result.script : result.script);
    copied = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = false), 1400);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }
</script>

<div class="dialog-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onClose()}>
  <div class="modal k6-export" role="dialog" aria-modal="true" aria-labelledby="k6-export-title" tabindex="-1" use:trapFocus onkeydown={onKeydown}>
    <div class="modal-head">
      <div class="k6-export-title">
        <h2 class="modal-title" id="k6-export-title">Export to k6</h2>
        <span class="loadtest-hint">{loadTest.name} · {stepCount} step{stepCount === 1 ? '' : 's'}</span>
      </div>
      <button type="button" class="btn btn-ghost btn-icon" onclick={onClose} aria-label="Close dialog">×</button>
    </div>

    <div class="k6-export-body">
      <div class="k6-export-side">
        <section class="loadtest-field">
          <span class="loadtest-label">Export as</span>
          <div class="segmented segmented-md" role="radiogroup" aria-label="Export format">
            <button class="segmented-item" type="button" role="radio" aria-checked={!folder} disabled={saving} onclick={() => (folder = false)}>Single script</button>
            <button class="segmented-item" type="button" role="radio" aria-checked={folder} disabled={saving} onclick={() => (folder = true)}>Folder</button>
          </div>
          <span class="loadtest-hint">{folder ? 'A new folder with script.k6.js and data.json when the test uses data. Choose its parent folder when saving.' : 'One script with test data included.'}</span>
        </section>
        <section class="loadtest-field">
          <span class="loadtest-label">Secrets</span>
          <div class="segmented segmented-md" role="radiogroup" aria-label="Secrets">
            <button class="segmented-item" type="button" role="radio" aria-checked={!inlineSecrets} disabled={saving} onclick={() => (inlineSecrets = false)}>Pass when running</button>
            <button class="segmented-item" type="button" role="radio" aria-checked={inlineSecrets} disabled={saving} onclick={() => (inlineSecrets = true)}>Write into the script</button>
          </div>
          <span class="loadtest-hint">
            {inlineSecrets
              ? 'Secret values are written into the file. Do not commit or share it.'
              : 'Secret values stay out of the file; k6 reads them from the environment.'}
          </span>
        </section>

        <section class="loadtest-field">
          <span class="loadtest-label">Run it</span>
          <code class="k6-export-command">{command}</code>
          <span class="loadtest-hint">Install k6 from grafana.com/docs/k6 if you do not have it.</span>
        </section>

        <section class="loadtest-field">
          <span class="loadtest-label">What does not carry over</span>
          {#if result?.error}
            <p class="k6-export-error" role="alert">{result.error}</p>
          {:else if warnings.length}
            <ul class="k6-export-warnings">
              {#each warnings as warning (`${warning.step}|${warning.message}`)}
                <li><span class="tag tag-warning">{warning.step ? `Step ${warning.step}` : 'Test'}</span><span>{warning.message}</span></li>
              {/each}
            </ul>
          {:else if result}
            <span class="loadtest-hint">Everything in this load test carries over.</span>
          {/if}
        </section>
      </div>

      <div class="k6-export-code">
        {#if folder && result?.files?.length}
          <div class="tab-bar tabs" role="tablist" aria-label="Export files" use:tabListKeyboard>
            {#each result.files as file (file.path)}
              <button class="tab" type="button" role="tab" aria-selected={activeFile === file.path} tabindex={activeFile === file.path ? 0 : -1} onclick={() => (activeFile = file.path)}>{file.path}</button>
            {/each}
          </div>
        {/if}
        <CodeEditor value={folder ? result?.files?.find(file => file.path === activeFile)?.content ?? '' : result?.script ?? ''} language={activeFile === 'data.json' && folder ? 'json' : 'javascript'} readonly fillHeight ariaLabel="k6 script" />
      </div>
    </div>

    <div class="modal-foot">
      <span class="loadtest-hint k6-export-file">{loading ? 'Generating…' : result?.fileName ?? ''}</span>
      <button class="btn btn-secondary" class:feedback-ok={copied} type="button" disabled={loading || saving || !result?.script} onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      <button class="btn btn-secondary" class:feedback-ok={saved} type="button" disabled={loading || saving || !result?.script} onclick={save}>{saving ? 'Saving…' : saved ? 'Saved' : folder ? 'Save folder…' : 'Save script…'}</button>
      <button class="btn btn-primary" type="button" disabled={runDisabled || loading || saving || !result?.script} onclick={onRun}>Run with local k6</button>
    </div>
  </div>
</div>
