import { performanceStatus, startPerformanceStream, stopPerformanceStream } from '../../backend';
import { listenRuntime } from '../../runtimeEvents';
import type { PerformanceProcess, PerformanceSample } from '../../wire';

export type PerformanceView = 'all' | 'main' | 'webview' | 'children';
export const PERFORMANCE_STORAGE_KEY = 'kurlo.performanceDock.v1';

export function perfProcessesForView(sample: PerformanceSample | null, view: PerformanceView): PerformanceProcess[] {
  return (sample?.processes ?? []).filter(process => view === 'all' || process.kind === (view === 'children' ? 'child' : view));
}

export function perfMetricsForView(sample: PerformanceSample | null, view: PerformanceView) {
  const processes = perfProcessesForView(sample, view);
  const populated = !!sample?.processes.length;
  const sum = (key: 'cpuPercent' | 'memoryBytes') => processes.length && processes.every(process => process[key] != null)
    ? processes.reduce((total, process) => total + (process[key] ?? 0), 0) : null;
  return {
    cpu: view === 'all' ? sample?.totalCpuPercent ?? null : sum('cpuPercent'),
    memory: view === 'all' ? sample?.totalMemoryBytes ?? null : sum('memoryBytes'),
    uptime: view === 'all' ? (populated ? sample?.mainUptimeSeconds ?? null : null) : processes.length && processes.every(process => process.uptimeSeconds != null) ? Math.max(...processes.map(process => process.uptimeSeconds ?? 0)) : null,
    pid: view === 'all' ? (populated ? sample?.mainPid ?? null : null) : processes.length === 1 ? processes[0].pid : null,
  };
}

export function perfSeriesForView(history: PerformanceSample[], view: PerformanceView) {
  return history.map(sample => ({ sampledAt: sample.sampledAt, ...perfMetricsForView(sample, view) }));
}

export function formatPerfCPU(value: number | null | undefined) { return value == null ? '—' : `${value.toFixed(1)}%`; }
export function formatPerfMemory(value: number | null | undefined) { return value == null ? '—' : `${(value / 1024 / 1024).toFixed(1)} MB`; }
export function formatPerfUptime(value: number | null | undefined) {
  if (value == null) return '—';
  const seconds = Math.floor(value);
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${hours}h ` : ''}${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`;
}

type PerformanceHost = {
  perfDockOpen: boolean;
  perfView: PerformanceView;
  perfSample: PerformanceSample | null;
  perfHistory: PerformanceSample[];
  perfError: string;
  togglePerformanceDock: () => Promise<void>;
};

function recordSample(host: PerformanceHost, sample: PerformanceSample) {
  if (host.perfSample && sample.sampledAt < host.perfSample.sampledAt) return;
  host.perfSample = sample;
  host.perfHistory = [...host.perfHistory.filter(previous => previous.sampledAt < sample.sampledAt && previous.sampledAt > sample.sampledAt - 120000), sample].slice(-120);
}

const generations = new WeakMap<object, number>();

export const performanceFeature = {
  initPerformanceListeners(this: PerformanceHost) {
    let disposed = false;
    const unlisten = listenRuntime<PerformanceSample>('perf:sample', sample => {
      if (!this.perfDockOpen || disposed) return;
      recordSample(this, sample);
    });
    try {
      const saved = JSON.parse(localStorage.getItem(PERFORMANCE_STORAGE_KEY) ?? 'null');
      if (['all', 'main', 'webview', 'children'].includes(saved?.view)) this.perfView = saved.view;
      if (saved?.open && !this.perfDockOpen) void this.togglePerformanceDock();
    } catch {}
    return () => {
      disposed = true;
      generations.set(this, (generations.get(this) ?? 0) + 1);
      unlisten();
      this.perfDockOpen = false;
      void stopPerformanceStream();
    };
  },

  setPerformanceView(this: PerformanceHost, view: PerformanceView) {
    this.perfView = view;
    try { localStorage.setItem(PERFORMANCE_STORAGE_KEY, JSON.stringify({ open: this.perfDockOpen, view })); } catch {}
  },

  async togglePerformanceDock(this: PerformanceHost) {
    const generation = (generations.get(this) ?? 0) + 1;
    generations.set(this, generation);
    this.perfDockOpen = !this.perfDockOpen;
    this.perfError = '';
    try { localStorage.setItem(PERFORMANCE_STORAGE_KEY, JSON.stringify({ open: this.perfDockOpen, view: this.perfView })); } catch {}
    try {
      if (this.perfDockOpen) {
        this.perfSample = null;
        this.perfHistory = [];
        await startPerformanceStream(1000);
        if (!this.perfDockOpen) { await stopPerformanceStream(); return; }
        if (generations.get(this) !== generation) return;
        const sample = await performanceStatus();
        if (this.perfDockOpen && generations.get(this) === generation) recordSample(this, sample);
      } else {
        await stopPerformanceStream();
      }
    } catch (error) {
      if (generations.get(this) !== generation) return;
      this.perfError = `Performance metrics are unavailable: ${String(error)}`;
      await stopPerformanceStream().catch(() => undefined);
    }
  },
};
