import type { CollectionRunnerResult } from './types/models';
import type { RunnerDataRow } from './runnerData';
import { clampConcurrency } from './concurrency';

export type CollectionRunnerReportSummary = {
  total: number;
  completed: number;
  passed: number;
  failed: number;
  skipped: number;
  testsPassed: number;
  testsTotal: number;
  duration: number;
  allPassed: boolean;
};

export type CollectionRunnerReportInput = {
  title: string;
  generatedAt?: Date | string;
  summary: CollectionRunnerReportSummary;
  results: CollectionRunnerResult[];
  iterations: number;
  delayMs: number;
  parallel: boolean;
  concurrency?: number;
  includeTags: string;
  excludeTags: string;
  dataFileName?: string;
  dataRows?: RunnerDataRow[];
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusLabel(result: CollectionRunnerResult): string {
  if (result.status === 'queued') return 'Queued';
  if (result.status === 'running') return 'Running';
  if (result.status === 'skipped') return 'Skipped';
  if (result.status === 'error') return 'Error';
  return result.status === 'passed' ? 'Passed' : 'Failed';
}

function runStatus(summary: CollectionRunnerReportSummary): string {
  if (summary.allPassed) return 'Passed';
  if (summary.failed > 0) return 'Failed';
  if (summary.skipped > 0) return 'Stopped';
  return 'Completed';
}

function formatDate(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' });
}

function dataPreview(row: RunnerDataRow | undefined): string {
  if (!row || !Object.keys(row).length) return '';
  return JSON.stringify(row);
}

function reportFileSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    || 'collection-runner';
}

export function collectionRunnerReportFileName(title: string, generatedAt: Date | string = new Date()): string {
  const date = typeof generatedAt === 'string' ? new Date(generatedAt) : generatedAt;
  const stamp = Number.isNaN(date.getTime())
    ? 'report'
    : date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${reportFileSlug(title)}-${stamp}.html`;
}

export function buildCollectionRunnerReportHtml(input: CollectionRunnerReportInput): string {
  const generatedAt = input.generatedAt ?? new Date();
  const dataRows = input.dataRows ?? [];
  const rows = input.results.map(result => {
    const tests = result.tests ?? [];
    const testDetails = tests.length
      ? `<ul class="tests">${tests.map(test => `<li class="${test.passed ? 'pass' : 'fail'}"><span>${escapeHtml(test.name)}</span>${test.error ? `<small>${escapeHtml(test.error)}</small>` : ''}</li>`).join('')}</ul>`
      : '<span class="muted">No tests</span>';
    const iterationData = dataPreview(dataRows[result.iteration - 1]);
    return `<tr>
      <td><span class="method">${escapeHtml(result.method)}</span></td>
      <td>
        <strong>${escapeHtml(result.name)}</strong>
        <small>${escapeHtml(result.url)}</small>
      </td>
      <td>${escapeHtml(result.iteration)}</td>
      <td><span class="status ${escapeHtml(result.status)}">${escapeHtml(statusLabel(result))}</span></td>
      <td>${result.statusCode || '-'}</td>
      <td>${result.duration ? `${escapeHtml(result.duration)} ms` : '-'}</td>
      <td>${result.testsTotal ? `${escapeHtml(result.testsPassed)}/${escapeHtml(result.testsTotal)}` : '-'}</td>
      <td>${iterationData ? `<code>${escapeHtml(iterationData)}</code>` : '<span class="muted">-</span>'}</td>
      <td>${result.error ? `<span class="error">${escapeHtml(result.error)}</span>` : testDetails}</td>
    </tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)} - Kurlo runner report</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #202124; background: #f7f8fb; }
    body { margin: 0; padding: 32px; }
    main { max-width: 1180px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 24px; }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.15; }
    h2 { margin: 28px 0 12px; font-size: 16px; }
    p { margin: 0; color: #646b78; }
    .badge { display: inline-flex; align-items: center; height: 30px; padding: 0 12px; border-radius: 999px; font-weight: 800; background: #eef2ff; color: #3f46d1; }
    .badge.failed { background: #fff1f2; color: #be123c; }
    .summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
    .card, table { background: #fff; border: 1px solid #e3e6ed; border-radius: 10px; box-shadow: 0 10px 30px rgba(31, 35, 50, 0.06); }
    .card { padding: 16px; }
    .card small { display: block; color: #757b86; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .card strong { display: block; margin-top: 8px; font-size: 22px; }
    .settings { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .setting { padding: 12px; border: 1px solid #e8ebf2; border-radius: 8px; background: #fff; }
    .setting small { display: block; color: #757b86; font-weight: 700; }
    .setting span { display: block; margin-top: 5px; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; overflow: hidden; }
    th, td { padding: 12px 14px; border-bottom: 1px solid #eef0f4; text-align: left; vertical-align: top; font-size: 13px; }
    th { color: #646b78; background: #fbfcff; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
    tr:last-child td { border-bottom: 0; }
    td strong, td small { display: block; }
    td small { margin-top: 4px; color: #757b86; overflow-wrap: anywhere; }
    code { display: inline-block; max-width: 260px; padding: 4px 6px; border-radius: 6px; background: #f4f6fa; color: #363b46; white-space: pre-wrap; overflow-wrap: anywhere; }
    .method { font-weight: 900; color: #177245; }
    .status { font-weight: 900; }
    .status.passed, .pass { color: #14804a; }
    .status.failed, .status.error, .fail, .error { color: #be123c; }
    .status.skipped { color: #a16207; }
    .muted { color: #8a919d; }
    .tests { margin: 0; padding: 0; list-style: none; }
    .tests li + li { margin-top: 6px; }
    .tests span { font-weight: 800; }
    .tests small { color: inherit; }
    @media (max-width: 900px) { body { padding: 18px; } header { display: block; } .summary, .settings { grid-template-columns: 1fr; } table { display: block; overflow-x: auto; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${escapeHtml(input.title)}</h1>
        <p>Kurlo collection runner report generated ${escapeHtml(formatDate(generatedAt))}</p>
      </div>
      <span class="badge ${input.summary.failed > 0 ? 'failed' : ''}">${escapeHtml(runStatus(input.summary))}</span>
    </header>
    <section class="summary">
      <div class="card"><small>Requests</small><strong>${escapeHtml(input.summary.completed)}/${escapeHtml(input.summary.total)}</strong></div>
      <div class="card"><small>Passed</small><strong>${escapeHtml(input.summary.passed)}</strong></div>
      <div class="card"><small>Failed</small><strong>${escapeHtml(input.summary.failed)}</strong></div>
      <div class="card"><small>Tests</small><strong>${escapeHtml(input.summary.testsPassed)}/${escapeHtml(input.summary.testsTotal)}</strong></div>
      <div class="card"><small>Duration</small><strong>${escapeHtml(input.summary.duration)} ms</strong></div>
    </section>
    <h2>Run Settings</h2>
    <section class="settings">
      <div class="setting"><small>Iterations</small><span>${escapeHtml(input.iterations)}</span></div>
      <div class="setting"><small>Mode</small><span>${input.parallel ? `Parallel (max ${escapeHtml(clampConcurrency(input.concurrency))} concurrent)` : 'Sequential'}</span></div>
      <div class="setting"><small>Delay</small><span>${escapeHtml(input.delayMs)} ms</span></div>
      <div class="setting"><small>Include tags</small><span>${escapeHtml(input.includeTags || 'None')}</span></div>
      <div class="setting"><small>Exclude tags</small><span>${escapeHtml(input.excludeTags || 'None')}</span></div>
      <div class="setting"><small>Data file</small><span>${escapeHtml(input.dataFileName ? `${input.dataFileName} (${dataRows.length} rows)` : 'None')}</span></div>
    </section>
    <h2>Results</h2>
    <table>
      <thead>
        <tr>
          <th>Method</th>
          <th>Request</th>
          <th>Iteration</th>
          <th>Status</th>
          <th>Code</th>
          <th>Time</th>
          <th>Tests</th>
          <th>Data</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="9" class="muted">No runner results</td></tr>'}</tbody>
    </table>
  </main>
</body>
</html>`;
}
