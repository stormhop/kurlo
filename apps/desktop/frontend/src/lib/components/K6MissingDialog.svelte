<script lang="ts">
  import { trapFocus } from '../a11y';
  import type { K6Info } from '../wire';

  let {
    info,
    onChoose,
    onCheckAgain,
    onExportOnly,
    onOpenGuide,
    onCopy,
    onClose,
  }: {
    info: K6Info | null;
    onChoose: () => void;
    onCheckAgain: () => void;
    onExportOnly: () => void;
    onOpenGuide: () => void;
    onCopy: (text: string) => void;
    onClose: () => void;
  } = $props();

  const INSTALLS = [
    { os: 'macOS', command: 'brew install k6' },
    { os: 'Windows', command: 'winget install k6 --source winget' },
    { os: 'Linux', command: 'sudo snap install k6' },
  ];

  let copied = $state('');

  function copy(command: string) {
    onCopy(command);
    copied = command;
    setTimeout(() => {
      if (copied === command) copied = '';
    }, 1400);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }
</script>

<div class="dialog-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onClose()}>
  <div class="modal k6-missing" role="dialog" aria-modal="true" aria-labelledby="k6-missing-title" tabindex="-1" use:trapFocus onkeydown={onKeydown}>
    <div class="modal-head">
      <h2 class="modal-title" id="k6-missing-title">k6 is not installed</h2>
      <button type="button" class="btn btn-ghost btn-icon" onclick={onClose} aria-label="Close dialog">×</button>
    </div>
    <div class="k6-missing-body">
      <p class="loadtest-hint">Kurlo builds the load test and Grafana k6 runs it. k6 is free and open source; install it once, then run the test again.</p>
      {#if info?.path && info.error}
        <p class="k6-export-error" role="alert">{info.path}: {info.error}</p>
      {/if}
      <ul class="k6-missing-list">
        {#each INSTALLS as install (install.os)}
          <li>
            <span class="loadtest-label">{install.os}</span>
            <code>{install.command}</code>
            <button class="btn btn-ghost btn-sm" type="button" onclick={() => copy(install.command)}>{copied === install.command ? 'Copied' : 'Copy'}</button>
          </li>
        {/each}
      </ul>
      <div class="loadtest-row">
        <button class="btn-link" type="button" onclick={onOpenGuide}>Other ways to install k6</button>
        <span class="loadtest-hint">·</span>
        <button class="btn-link" type="button" onclick={onChoose}>Choose the k6 program…</button>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" type="button" onclick={onExportOnly}>Export script only</button>
      <button class="btn btn-primary" type="button" onclick={onCheckAgain}>Check again</button>
    </div>
  </div>
</div>
