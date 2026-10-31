<script lang="ts">
  import { executorPoints, formatDuration } from '../loadPresets';
  import type { LoadExecutor } from '../wire';

  const WIDTH = 600;
  const HEIGHT = 160;

  let {
    executor,
    unit,
    label,
    progressMs = null,
    highlight = -1,
  }: {
    executor: LoadExecutor;
    unit: string;
    label: string;
    progressMs?: number | null;
    highlight?: number;
  } = $props();

  const clipId = $props.id();
  const points = $derived(executorPoints(executor));
  const totalMs = $derived(points.at(-1)?.ms ?? 0);
  const peak = $derived(Math.max(1, ...points.map(point => point.value)));
  const coords = $derived(points.map((point, index) => ({
    x: totalMs > 0 ? point.ms / totalMs * WIDTH : index / Math.max(1, points.length - 1) * WIDTH,
    y: HEIGHT - point.value / peak * HEIGHT,
  })));
  const line = $derived(coords.map(point => `${round(point.x)},${round(point.y)}`).join(' '));
  const area = $derived(`0,${HEIGHT} ${line} ${WIDTH},${HEIGHT}`);
  const boundaries = $derived(executor.stages?.length ? coords.slice(1, -1).map(point => point.x) : []);
  const band = $derived.by(() => {
    if (highlight < 0 || !executor.stages?.length || highlight + 1 >= coords.length) return null;
    return { x: coords[highlight].x, width: coords[highlight + 1].x - coords[highlight].x };
  });
  const progress = $derived(progressMs === null || totalMs <= 0 ? null : Math.min(1, Math.max(0, progressMs / totalMs)));
  const progressValue = $derived(progress === null ? 0 : valueAt(progress * totalMs));

  function valueAt(ms: number) {
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1];
      const to = points[index];
      if (ms <= to.ms) {
        const span = to.ms - from.ms;
        return span > 0 ? from.value + (to.value - from.value) * (ms - from.ms) / span : to.value;
      }
    }
    return points.at(-1)?.value ?? 0;
  }

  function round(value: number) {
    return Math.round(value * 10) / 10;
  }

  function compact(value: number) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, notation: value >= 10000 ? 'compact' : 'standard' }).format(value);
  }
</script>

<div class="loadchart" class:loadchart-live={progress !== null}>
  <div class="loadchart-y" aria-hidden="true">
    <span>{compact(peak)}</span>
    <span>{compact(peak / 2)}</span>
    <span>0</span>
  </div>
  <div class="loadchart-plot">
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <line x1="0" y1={HEIGHT / 2} x2={WIDTH} y2={HEIGHT / 2} class="loadchart-grid" />
      <line x1="0" y1="0.5" x2={WIDTH} y2="0.5" class="loadchart-grid" />
      {#if band}<rect x={band.x} y="0" width={band.width} height={HEIGHT} class="loadchart-band" />{/if}
      {#each boundaries as x, index (index)}<line x1={x} y1="0" x2={x} y2={HEIGHT} class="loadchart-divider" />{/each}
      {#if progress === null}
        <polygon points={area} class="loadtest-area" />
        <polyline points={line} class="loadtest-line" />
      {:else}
        <clipPath id={clipId}><rect x="0" y="-2" width={progress * WIDTH} height={HEIGHT + 4} /></clipPath>
        <polyline points={line} class="loadchart-planned" />
        <g clip-path={`url(#${clipId})`}>
          <polygon points={area} class="loadtest-area" />
          <polyline points={line} class="loadtest-line" />
        </g>
        <line x1={progress * WIDTH} y1="0" x2={progress * WIDTH} y2={HEIGHT} class="loadchart-now" />
      {/if}
      <line x1="0" y1={HEIGHT - 0.5} x2={WIDTH} y2={HEIGHT - 0.5} class="loadtest-axis" />
    </svg>
    {#if progress !== null}
      <span class="loadchart-now-label" style={`left: ${progress * 100}%; transform: translateX(${progress < 0.12 ? 0 : progress > 0.88 ? -100 : -50}%)`}>now · {compact(Math.round(progressValue))} {unit}</span>
    {/if}
  </div>
  <div class="loadchart-x" aria-hidden="true">
    <span>0</span>
    {#if executor.stages?.length}
      <span class="loadchart-stages">
        {#each executor.stages as stage, index (index)}
          <span class:active={index === highlight} style={`flex-grow: ${Math.max(1, stage.durationMs)}`}>{index + 1}</span>
        {/each}
      </span>
    {:else}
      <span class="loadchart-stages"></span>
    {/if}
    <span>{formatDuration(totalMs)}</span>
  </div>
</div>
