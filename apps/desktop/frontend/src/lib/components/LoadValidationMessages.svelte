<script lang="ts">
  let { problems = [] }: { problems?: string[] } = $props();
</script>

{#if problems.length}
  <ul class="loadtest-errors" role="status">
    {#each problems as problem, index (index)}<li>{problem}</li>{/each}
  </ul>
{/if}
