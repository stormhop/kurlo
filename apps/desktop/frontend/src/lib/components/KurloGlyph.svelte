<script lang="ts">
  import { BIRD_BODY, BIRD_EYE, BIRD_LEGS, BIRD_WING } from '../bird';

  let { size = '0.75rem' }: { size?: string } = $props();
</script>

<svg class="kurlo-glyph" viewBox="220 290 580 460" style={`width: ${size}; height: ${size}`} aria-hidden="true" focusable="false">
  {#each BIRD_LEGS as leg (leg.x)}
    <rect x={leg.x} y={leg.y} width={leg.width} height={leg.height} rx="12" fill="currentColor" />
  {/each}
  <path d={BIRD_BODY} fill="currentColor" />
  <path class="kurlo-glyph-wing" d={BIRD_WING} />
  <circle class="kurlo-glyph-eye" cx={BIRD_EYE.cx} cy={BIRD_EYE.cy} r={BIRD_EYE.r * 1.4} />
</svg>

<style>
  .kurlo-glyph {
    flex: 0 0 auto;
    overflow: visible;
  }
  .kurlo-glyph-wing {
    fill: var(--bg);
    opacity: 0.4;
  }
  .kurlo-glyph-eye {
    fill: var(--bg);
  }
</style>
