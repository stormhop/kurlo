<script lang="ts">
  import { trapFocus } from '../a11y';
  import CodeEditor from '../CodeEditor.svelte';
  import type { K6ExportResult, LoadTest } from '../wire';

  let {
    loadTest,
    onExport,
    onSave,
    onCopy,
    onClose,
  }: {
    loadTest: LoadTest;
    onExport: (inlineSecrets: boolean) => Promise<K6ExportResult>;
    onSave: (fileName: string, script: string) => Promise<boolean>;
    onCopy: (text: string) => void;
    onClose: () => void;
  } = $props();

  let inlineSecrets = $state(false);
  let result = $state<K6ExportResult | null>(null);
  let loading = $state(true);
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  let request = 0;

  const stepCount = $derived(loadTest.scenarios[0]?.steps.length ?? 0);
  const warnings = $derived(result?.warnings.filter(warning => warning.level !== 'info') ?? []);
  const notes = $derived(result?.warnings.filter(warning => warning.level === 'info') ?? []);
  const secretNames = $derived(notes.map(note => /^(\S+) is secret/.exec(note.message)?.[1]).filter((name): name is string => Boolean(name)));
  const command = $derived(`${secretNames.map(name => `${name}=…`).join(' ')}${secretNames.length ? ' ' : ''}k6 run ${result?.fileName || 'load-test.k6.js'}`);

  $effect(() => {
    const inline = inlineSecrets;
    const current = ++request;
    loading = true;
    void onExport(inline).then(next => {
      if (current !== request) return;
      result = next;
      loading = false;
    });
  });

  function copy() {
    if (!result?.script) return;
    onCopy(result.script);
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
          <span class="loadtest-label">Secrets</span>
          <div class="segmented segmented-md" role="radiogroup" aria-label="Secrets">
            <button class="segmented-item" type="button" role="radio" aria-checked={!inlineSecrets} onclick={() => (inlineSecrets = false)}>Pass when running</button>
            <button class="segmented-item" type="button" role="radio" aria-checked={inlineSecrets} onclick={() => (inlineSecrets = true)}>Write into the script</button>
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
        <CodeEditor value={result?.script ?? ''} language="javascript" readonly fillHeight ariaLabel="k6 script" />
      </div>
    </div>

    <div class="modal-foot">
      <span class="loadtest-hint k6-export-file">{loading ? 'Generating…' : result?.fileName ?? ''}</span>
      <button class="btn btn-secondary" class:feedback-ok={copied} type="button" disabled={!result?.script} onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      <button class="btn btn-primary" type="button" disabled={!result?.script} onclick={() => result && onSave(result.fileName, result.script)}>Save script…</button>
    </div>
  </div>
</div>
