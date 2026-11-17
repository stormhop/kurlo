<script lang="ts">
  import { onMount } from 'svelte';
  import { announceShellResize } from '../shellResize';
  import { vm } from '../stores/app.svelte';
  import { perfMetricsForView, perfSeriesForView, formatPerfCPU, formatPerfMemory, formatPerfUptime, type PerformanceView } from '../stores/features/performance';

  const heightStorageKey = 'kurlo.performanceDockHeight.v1';
  let dock: HTMLDivElement;
  let maxHeight = $state(Math.max(1, Math.min(38, window.innerHeight / parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.5)));
  let minHeight = $derived(Math.min(14, maxHeight));
  let height = $state(readHeight());
  let actualHeight = $derived(Math.max(minHeight, Math.min(maxHeight, height)));
  let drag = $state<{ pointerId: number; y: number; height: number; rem: number } | null>(null);

  function readHeight() {
    try {
      const stored = Number(localStorage.getItem(heightStorageKey));
      if (Number.isFinite(stored) && stored > 0) return stored;
    } catch {}
    return 23;
  }

  function saveHeight() {
    try { localStorage.setItem(heightStorageKey, String(actualHeight)); } catch {}
    announceShellResize();
  }

  onMount(() => {
    const workspace = dock.parentElement;
    const updateBounds = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      maxHeight = Math.max(1, Math.min(38, window.innerHeight / rem * 0.5, (workspace?.clientHeight ?? window.innerHeight) / rem - 10));
      announceShellResize();
    };
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    if (workspace) observer.observe(workspace);
    window.addEventListener('resize', updateBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateBounds);
      announceShellResize();
    };
  });

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.blur();
    target.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, y: event.clientY, height: actualHeight, rem: parseFloat(getComputedStyle(document.documentElement).fontSize) };
  }

  function resize(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    height = Math.max(minHeight, Math.min(maxHeight, drag.height + (drag.y - event.clientY) / drag.rem));
  }

  function finishResize(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    saveHeight();
  }

  function resizeWithKeyboard(event: KeyboardEvent) {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    height = event.key === 'Home' ? minHeight : event.key === 'End' ? maxHeight : Math.max(minHeight, Math.min(maxHeight, actualHeight + (event.key === 'ArrowUp' ? 1 : -1)));
    saveHeight();
  }

  const views: { id: PerformanceView; label: string }[] = [{ id: 'all', label: 'All processes' }, { id: 'main', label: 'Main' }, { id: 'webview', label: 'Webview' }, { id: 'children', label: 'Child' }];
  let metrics = $derived(perfMetricsForView(vm.perfSample, vm.perfView));
  let series = $derived(perfSeriesForView(vm.perfHistory, vm.perfView));

  function paths(key: 'cpu' | 'memory') {
    const end = vm.perfSample?.sampledAt ?? Date.now();
    const max = Math.max(key === 'cpu' ? 1 : 1024 * 1024, ...series.map(point => point[key] ?? 0));
    const segments: string[][] = [];
    let current: string[] = [];
    let previous = 0;
    for (const point of series) {
      if (point[key] == null || (previous && point.sampledAt - previous > 10000)) {
        if (current.length) segments.push(current);
        current = [];
      }
      if (point[key] != null) {
        const x = Math.max(0, 400 - (end - point.sampledAt) / 120000 * 400);
        current.push(`${x.toFixed(2)},${(48 - (point[key] ?? 0) / max * 44).toFixed(2)}`);
      }
      previous = point.sampledAt;
    }
    if (current.length) segments.push(current);
    return { max, segments: segments.map(points => ({ line: `M${points.join(' L')}`, area: `M${points[0].split(',')[0]},50 L${points.join(' L')} L${points.at(-1)?.split(',')[0]},50 Z` })) };
  }
  let cpuChart = $derived(paths('cpu'));
  let memoryChart = $derived(paths('memory'));
</script>

<div class="performance-dock" class:performance-resizing={drag !== null} bind:this={dock} style:height={`${actualHeight}rem`} role="region" aria-label="Performance dock">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="panel-divider performance-resizer" role="separator" tabindex="0" aria-label="Resize performance dock" aria-orientation="horizontal" aria-controls="performance-panel" aria-valuemin={minHeight} aria-valuemax={maxHeight} aria-valuenow={actualHeight} aria-valuetext={`${actualHeight.toFixed(1)} rem high`} onpointerdown={startResize} onpointermove={resize} onpointerup={finishResize} onpointercancel={finishResize} onlostpointercapture={finishResize} onkeydown={resizeWithKeyboard}></div>
  <div id="performance-panel" class="performance-content">
    <div class="performance-toolbar"><h2>System Resources</h2><div class="performance-toolbar-actions"><div class="performance-views" role="group" aria-label="View processes"><span>View</span>{#each views as view (view.id)}<button class="btn btn-ghost btn-xs" class:active={vm.perfView === view.id} type="button" aria-pressed={vm.perfView === view.id} onclick={() => vm.setPerformanceView(view.id)}>{view.label}</button>{/each}</div><button class="btn btn-ghost btn-icon btn-xs" type="button" aria-label="Close performance dock" onclick={() => void vm.togglePerformanceDock()}><svg width="0.75rem" height="0.75rem" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4"/></svg></button></div></div>
    {#if vm.perfError}<p class="performance-notice" role="status">{vm.perfError}</p>{:else if vm.perfSample?.sensorLimited}<p class="performance-notice">Process metrics are limited on this platform. Unavailable values are shown as —.</p>{/if}
    <div class="performance-cards">
      <div class="performance-card"><span>CPU Usage</span><strong data-testid="perf-cpu">{formatPerfCPU(metrics.cpu)}</strong><small>Total CPU use</small></div>
      <div class="performance-card"><span>Memory Usage</span><strong data-testid="perf-memory">{formatPerfMemory(metrics.memory)}</strong><small>Resident memory</small></div>
      <div class="performance-card"><span>Uptime</span><strong data-testid="perf-uptime">{formatPerfUptime(metrics.uptime)}</strong><small>{vm.perfView === 'all' ? 'Application runtime' : 'Longest process runtime'}</small></div>
      <div class="performance-card"><span>Process ID</span><strong data-testid="perf-pid">{metrics.pid || '—'}</strong><small>{vm.perfView === 'all' ? 'Main PID' : 'Selected process PID'}</small></div>
    </div>
    <div class="performance-charts">
      {#each [{ label: 'CPU %', chart: cpuChart, max: formatPerfCPU(cpuChart.max) }, { label: 'Memory MB', chart: memoryChart, max: formatPerfMemory(memoryChart.max) }] as item (item.label)}
        <div class="performance-chart"><div><span>{item.label} · 2 min</span><small>{item.max}</small></div><svg viewBox="0 0 400 50" preserveAspectRatio="none" role="img" aria-label={`${item.label} over the last two minutes`}><path class="performance-chart-baseline" d="M0 49.5H400"/>{#each item.chart.segments as segment, index (index)}<path class="performance-chart-area" d={segment.area}/><path class="performance-chart-line" d={segment.line}/>{/each}</svg></div>
      {/each}
    </div>
    <h3>Processes</h3>
    <div class="performance-table-scroll"><table class="performance-table"><thead><tr><th>Name</th><th>PID</th><th>CPU %</th><th>Memory</th><th>Uptime</th><th>Kind</th></tr></thead><tbody>{#each vm.perfSample?.processes ?? [] as process (process.pid)}<tr><td><span>{process.name}</span><small>{process.role}</small></td><td>{process.pid}</td><td>{formatPerfCPU(process.cpuPercent)}</td><td>{formatPerfMemory(process.memoryBytes)}</td><td>{formatPerfUptime(process.uptimeSeconds)}</td><td>{process.kind}</td></tr>{:else}<tr><td colspan="6">No process metrics available.</td></tr>{/each}</tbody></table></div>
  </div>
</div>
