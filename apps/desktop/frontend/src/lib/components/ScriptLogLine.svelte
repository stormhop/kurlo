<script lang="ts">
  import { parseScriptLog, scriptLogPreview } from '../scriptLogs';
  import { formatSize } from '../utils';

  let { line }: { line: string } = $props();
  const parsed = $derived(parseScriptLog(line));
  const preview = $derived(scriptLogPreview(parsed.text));
  const fullSize = $derived(new TextEncoder().encode(parsed.text).length);
  let expanded = $state(false);
  const icons = { log: '›', request: '→', warn: '!', error: '×' };
</script>

<div class="script-log-row log-{parsed.level}" data-level={parsed.level}>
  <span class="log-icon" aria-hidden="true">{icons[parsed.level]}</span>
  {#if parsed.level === 'warn' || parsed.level === 'error'}<span class="sr-only">{parsed.level}:</span>{/if}
  <span class="log-body">
    <span class="log-msg">{preview && !expanded ? preview : parsed.text}</span>
    {#if preview}
      <button class="btn btn-ghost btn-xs log-toggle" type="button" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
        {expanded ? 'Show less' : `Show all · ${formatSize(fullSize)}`}
      </button>
    {/if}
  </span>
</div>
