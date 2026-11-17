import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ performanceStatus: vi.fn(), startPerformanceStream: vi.fn(), stopPerformanceStream: vi.fn() }));
vi.mock('../lib/backend', () => backend);
import { performanceFeature, perfProcessesForView, perfMetricsForView, perfSeriesForView, formatPerfCPU, formatPerfMemory, formatPerfUptime, PERFORMANCE_STORAGE_KEY, type PerformanceView } from '../lib/stores/features/performance';
import type { PerformanceSample } from '../lib/wire';

const sample: PerformanceSample = { sampledAt: 1000, intervalMs: 1000, mainPid: 10, mainUptimeSeconds: 4951, totalCpuPercent: 3, totalMemoryBytes: 314572800, sensorLimited: false, processes: [
  { pid: 10, parentPid: 1, name: 'Kurlo (main)', role: 'Application', kind: 'main', cpuPercent: 1, memoryBytes: 104857600, uptimeSeconds: 4951 },
  { pid: 20, parentPid: 10, name: 'Webview', role: 'Webview', kind: 'webview', cpuPercent: 2, memoryBytes: 209715200, uptimeSeconds: 4950 },
] };
function host() {
  return { ...performanceFeature, perfDockOpen: false, perfView: 'all' as PerformanceView, perfSample: null as PerformanceSample | null, perfHistory: [] as PerformanceSample[], perfError: '' };
}
let emit: (sample: PerformanceSample) => void;
const off = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal('window', { runtime: { EventsOn: (_: string, callback: typeof emit) => { emit = callback; return off; } } });
  backend.performanceStatus.mockResolvedValue(sample);
  backend.startPerformanceStream.mockResolvedValue(undefined);
  backend.stopPerformanceStream.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('performance dock', () => {
  it('filters cards and history without filtering the process table', () => {
    expect(perfProcessesForView(sample, 'webview').map(process => process.pid)).toEqual([20]);
    expect(perfMetricsForView(sample, 'all').cpu).toBe(3);
    expect(perfMetricsForView(sample, 'main').memory).toBe(104857600);
    expect(perfMetricsForView(sample, 'children').cpu).toBeNull();
    expect(perfSeriesForView([sample], 'webview')[0].cpu).toBe(2);
    expect(perfMetricsForView({ ...sample, processes: [{ ...sample.processes[0], cpuPercent: null }] }, 'main').cpu).toBeNull();
    expect(formatPerfCPU(null)).toBe('—');
    expect(formatPerfCPU(0.4)).toBe('0.4%');
    expect(formatPerfMemory(314572800)).toBe('300.0 MB');
    expect(formatPerfUptime(4951)).toBe('1h 22m 31s');
  });
  it('starts on open, retains two minutes and stops on close and disposal', async () => {
    const vm = host();
    const dispose = vm.initPerformanceListeners();
    await vm.togglePerformanceDock();
    expect(backend.startPerformanceStream).toHaveBeenCalledWith(1000);
    for (let i = 2; i <= 140; i++) emit({ ...sample, sampledAt: i * 1000 });
    expect(vm.perfHistory).toHaveLength(120);
    vm.setPerformanceView('main');
    expect(JSON.parse(localStorage.getItem(PERFORMANCE_STORAGE_KEY)!)).toEqual({ open: true, view: 'main' });
    await vm.togglePerformanceDock();
    emit({ ...sample, sampledAt: 150000 });
    expect(vm.perfSample?.sampledAt).toBe(140000);
    expect(backend.stopPerformanceStream).toHaveBeenCalledOnce();
    dispose();
    expect(off).toHaveBeenCalledOnce();
  });
  it('restores an open dock and its selected view', async () => {
    localStorage.setItem(PERFORMANCE_STORAGE_KEY, JSON.stringify({ open: true, view: 'webview' }));
    const vm = host();
    vm.initPerformanceListeners();
    await vi.waitFor(() => expect(vm.perfSample).toEqual(sample));
    expect(vm.perfDockOpen).toBe(true);
    expect(vm.perfView).toBe('webview');
  });
  it('handles rapid close while the initial status is pending', async () => {
    let resolve!: (value: PerformanceSample) => void;
    backend.performanceStatus.mockReturnValue(new Promise<PerformanceSample>(done => { resolve = done; }));
    const vm = host();
    const opening = vm.togglePerformanceDock();
    await vi.waitFor(() => expect(backend.performanceStatus).toHaveBeenCalled());
    await vm.togglePerformanceDock();
    resolve(sample);
    await opening;
    expect(vm.perfDockOpen).toBe(false);
    expect(vm.perfSample).toBeNull();
  });
  it('keeps newer stream samples when the initial snapshot resolves late', async () => {
    let resolve!: (value: PerformanceSample) => void;
    backend.performanceStatus.mockReturnValue(new Promise<PerformanceSample>(done => { resolve = done; }));
    const vm = host();
    vm.initPerformanceListeners();
    const opening = vm.togglePerformanceDock();
    await vi.waitFor(() => expect(backend.performanceStatus).toHaveBeenCalled());
    emit({ ...sample, sampledAt: 2000 });
    resolve(sample);
    await opening;
    emit(sample);
    expect(vm.perfSample?.sampledAt).toBe(2000);
    expect(vm.perfHistory.map(point => point.sampledAt)).toEqual([2000]);
  });
  it('stops on errors and reports unavailable sensors', async () => {
    backend.performanceStatus.mockRejectedValue(new Error('sensor unavailable'));
    const vm = host();
    await vm.togglePerformanceDock();
    expect(vm.perfError).toContain('sensor unavailable');
    expect(backend.stopPerformanceStream).toHaveBeenCalled();
  });
});
