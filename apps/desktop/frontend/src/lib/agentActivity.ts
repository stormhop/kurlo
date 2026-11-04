import type { AgentActivityEntry, AgentActivitySummary, AgentFileChange } from './backend';
import type { AgentMode } from './stores/agent.svelte';

export type AgentActivityPeriod = 'all' | 'day' | 'week';

export type AgentActivityQuery = {
  text: string;
  client: string;
  period: AgentActivityPeriod;
};

export const AGENT_ACTIVITY_SCOPES = [
  { value: 'workspace', label: 'This workspace' },
  { value: 'all', label: 'All workspaces' },
];

export function agentActivityPlace(entry: AgentActivitySummary): string {
  if (entry.here) return '';
  if (entry.workspaceName) return entry.workspaceName;
  return entry.workspaceId ? 'Another workspace' : 'No workspace';
}

export const AGENT_ACTIVITY_PERIODS: Array<{ value: AgentActivityPeriod; label: string }> = [
  { value: 'all', label: 'Any time' },
  { value: 'day', label: 'Last 24 hours' },
  { value: 'week', label: 'Last 7 days' },
];

const DAY = 24 * 60 * 60 * 1000;

export function agentActivityClients(entries: AgentActivitySummary[]): string[] {
  return [...new Set(entries.map(entry => entry.client).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function filterAgentActivity(entries: AgentActivitySummary[], query: AgentActivityQuery, now = Date.now()): AgentActivitySummary[] {
  const words = query.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const since = query.period === 'day' ? now - DAY : query.period === 'week' ? now - 7 * DAY : 0;
  return entries.filter(entry => {
    if (query.client && entry.client !== query.client) return false;
    if (since && entry.time < since) return false;
    if (!words.length) return true;
    const haystack = [entry.tool, entry.client, entry.status, entry.error ?? '', entry.branch ?? '', entry.commit ?? '', ...entry.files].join(' ').toLowerCase();
    return words.every(word => haystack.includes(word));
  });
}

export function agentActivityGroups(entries: AgentActivitySummary[], now = Date.now()): Array<{ label: string; entries: AgentActivitySummary[] }> {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const startOfToday = today.getTime();
  const groups = [
    { label: 'Today', entries: [] as AgentActivitySummary[] },
    { label: 'Yesterday', entries: [] as AgentActivitySummary[] },
    { label: 'Earlier', entries: [] as AgentActivitySummary[] },
  ];
  for (const entry of entries) {
    const group = entry.time >= startOfToday ? 0 : entry.time >= startOfToday - DAY ? 1 : 2;
    groups[group].entries.push(entry);
  }
  return groups.filter(group => group.entries.length);
}

export function agentActivityStatus(entry: AgentActivitySummary): { label: string; tone: 'ok' | 'bad' | 'muted' } {
  if (entry.reverted) return { label: 'Restored', tone: 'muted' };
  if (entry.status === 'declined') return { label: 'Declined', tone: 'muted' };
  if (entry.status === 'error') return { label: 'Error', tone: 'bad' };
  return { label: entry.files.length ? 'Changed files' : 'Done', tone: 'ok' };
}

export function agentActivityFilesLabel(entry: AgentActivitySummary): string {
  if (!entry.files.length) return '';
  return entry.files.length === 1 ? '1 file' : `${entry.files.length} files`;
}

export function agentActivityTime(time: number, now = Date.now()): string {
  const date = new Date(time);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function agentActivityFullTime(time: number): string {
  return new Date(time).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function agentActivityCanRestore(change: AgentFileChange): boolean {
  return !change.reverted && !change.tooLarge;
}

export function agentActivityRestorable(entry: AgentActivityEntry | null): AgentFileChange[] {
  return entry?.changes.filter(agentActivityCanRestore) ?? [];
}

export function agentActivityChangeStatus(change: AgentFileChange): string {
  if (change.reverted) return 'restored';
  if (change.before == null && !change.tooLarge) return 'new file';
  if (change.after == null && !change.tooLarge) return 'deleted';
  return 'changed';
}

export function agentActivityChatMode(client: string): AgentMode | null {
  if (client === 'Kurlo agent') return 'kurlo';
  if (client === 'Codex via Kurlo') return 'external';
  if (client === 'Claude Code via Kurlo') return 'claude';
  return null;
}

export function agentActivityPretty(text: string): string {
  if (!text.trim()) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
