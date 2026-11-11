<script lang="ts">
  import Markdown from './Markdown.svelte';

  const COLLAPSED_PX = 384;

  let { source, resetKey = '' }: { source: string; resetKey?: string } = $props();

  let body = $state<HTMLDivElement>();
  let expanded = $state(false);
  let overflows = $state(false);
  let lastResetKey = '';

  $effect(() => {
    if (resetKey === lastResetKey) return;
    lastResetKey = resetKey;
    expanded = false;
  });

  $effect(() => {
    const element = body;
    void source;
    if (!element) {
      overflows = false;
      return;
    }
    const measure = () => { overflows = element.scrollHeight > COLLAPSED_PX + 1; };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });
</script>

<div class="overview-readme-body" class:collapsed={overflows && !expanded} bind:this={body}><Markdown {source} /></div>
{#if overflows}
  <button class="btn btn-ghost btn-sm overview-readme-more" type="button" onclick={() => (expanded = !expanded)} aria-expanded={expanded}>{expanded ? 'Show less' : 'Show all'}</button>
{/if}
