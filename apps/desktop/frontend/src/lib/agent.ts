import type { CodexRateLimit, AgentApproval, AgentChatSummary, AgentFileChange, AiBlock, AiMessage } from './wire';
import { emptyStepView, type AiStepView } from './stores/features/ai';

export const AGENT_WORKSPACE_CHANGE = 'changed by the Kurlo agent';

export type AgentTemplate = { id: string; title: string; summary: string; text: string };

export const AGENT_TEMPLATES: AgentTemplate[] = [
  { id: 'debug', title: 'Why did my request fail?', summary: 'Reads the history, auth and variables', text: 'Why did my last request fail? Find the cause and propose one fix.' },
  { id: 'check', title: 'Run and check the collection', summary: 'Runs it, then explains every failure', text: 'Run the collection and explain every failure, with a fix for each. Change nothing until I agree.' },
  { id: 'tests', title: 'Write tests for a request', summary: 'From a real response, with an example', text: 'Write tests for the request REQUEST NAME from a real response, and save the response as an example.' },
  { id: 'cover', title: 'Cover an endpoint', summary: 'Saves a request, tests and an example', text: 'Cover the endpoint POST /path: save a request for it, write tests and save an example response.' },
  { id: 'explain', title: 'Explain a request', summary: 'Auth, variables, scripts and tests', text: 'Explain what the request REQUEST NAME does: its auth, variables, scripts and tests.' },
];

export const AGENT_STARTERS = ['debug', 'check', 'tests', 'cover'];

export function agentKindMonogram(kind: string): string {
  switch (kind) {
    case 'openrouter': return 'OR';
    case 'anthropic': return 'An';
    case 'openai': return 'Oa';
    case 'local': return 'Lo';
    default: return 'Ai';
  }
}

export function agentEffortLabel(value: string): string {
  return value === 'xhigh' ? 'Extra high' : value ? value[0].toUpperCase() + value.slice(1) : 'Default';
}

export function agentEffortChoice(chosen: string, efforts: string[], fallback: string): string {
  if (chosen && efforts.includes(chosen)) return chosen;
  return fallback && efforts.includes(fallback) ? fallback : '';
}

export function agentEffortToStore(value: string, fallback: string): string {
  return value === fallback ? '' : value;
}

export function agentTemplatePlaceholder(text: string): { start: number; end: number } | null {
  const match = /REQUEST NAME|POST \/path/.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

export type AgentTurnView = {
  id: string;
  prompt: string;
  steps: AiStepView[];
};

export function agentTurnsFromMessages(messages: AiMessage[], chatId = '', messageOffset = 0): AgentTurnView[] {
  const turns: AgentTurnView[] = [];
  let current: AgentTurnView | null = null;
  for (const [messageIndex, message] of messages.entries()) {
    const blocks = message.blocks ?? [];
    if (message.role === 'user') {
      const prompt = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
      current = { id: `${chatId}:${messageOffset + messageIndex}`, prompt, steps: [] };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { id: `${chatId}:${messageOffset + messageIndex}`, prompt: '', steps: [] };
      turns.push(current);
    }
    if (message.role === 'assistant') {
      const step = emptyStepView(current.steps.length);
      step.blocks = blocks;
      step.done = true;
      step.stopReason = blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
      current.steps.push(step);
      continue;
    }
    if (message.role === 'tool') {
      const last = current.steps.at(-1);
      if (last) last.toolResults = [...last.toolResults, ...blocks];
    }
  }
  return turns;
}

export type AgentChatGroup = { label: string; chats: AgentChatSummary[] };

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function agentChatGroups(chats: AgentChatSummary[], now = Date.now()): AgentChatGroup[] {
  const today = startOfDay(now);
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const groups: AgentChatGroup[] = [
    { label: 'Today', chats: sorted.filter(chat => chat.updatedAt >= today) },
    { label: 'Earlier', chats: sorted.filter(chat => chat.updatedAt < today) },
  ];
  return groups.filter(group => group.chats.length > 0);
}

export function agentFilterChats(chats: AgentChatSummary[], query: string): AgentChatSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return chats;
  return chats.filter(chat => {
    const title = (chat.title ?? '').toLowerCase();
    return words.every(word => title.includes(word));
  });
}

export function agentTurnAnswer(steps: { blocks: AiBlock[] }[]): string {
  const parts: string[] = [];
  for (const step of steps) {
    for (const block of step.blocks) {
      if (block.type === 'text' && block.text?.trim()) parts.push(block.text.trim());
    }
  }
  return parts.join('\n\n');
}

export type AgentToolTarget =
  | { kind: 'request'; ref: string }
  | { kind: 'history'; id: string }
  | { kind: 'environment'; name: string };

function parseInput(input: string | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(input || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function agentToolTarget(block: AiBlock, result?: AiBlock): AgentToolTarget | null {
  const input = parseInput(block.input);
  switch (block.name) {
    case 'get_request':
    case 'run_request':
    case 'generate_tests':
    case 'save_example':
    case 'delete_request': {
      const ref = text(input.request);
      return ref && block.name !== 'delete_request' ? { kind: 'request', ref } : null;
    }
    case 'save_request': {
      const output = parseInput(result?.text);
      const ref = text(output.id) || text(input.request) || text(output.path);
      return ref ? { kind: 'request', ref } : null;
    }
    case 'get_history_entry':
    case 'diagnose_last_failure': {
      const id = text(input.entry) || text(parseInput(result?.text).id);
      return id ? { kind: 'history', id } : null;
    }
    case 'set_variable': {
      const name = text(input.environment);
      return name ? { kind: 'environment', name } : null;
    }
  }
  return null;
}

export type AgentRequestRef = { id: string; name: string; path: string };

export function agentFindRequest(requests: AgentRequestRef[], ref: string): AgentRequestRef | null {
  const wanted = ref.trim();
  if (!wanted) return null;
  const lower = wanted.toLowerCase();
  return requests.find(request => request.id === wanted)
    ?? requests.find(request => request.path.toLowerCase() === lower)
    ?? requests.find(request => request.name.toLowerCase() === lower)
    ?? null;
}

export function agentToolLabel(name: string | undefined): string {
  switch (name) {
    case 'list_requests': return 'Listed requests';
    case 'get_request': return 'Read a request';
    case 'list_environments': return 'Listed environments';
    case 'run_request': return 'Ran a request';
    case 'run_collection': return 'Ran a collection';
    case 'send_request': return 'Sent a request';
    case 'list_history': return 'Read the history';
    case 'get_history_entry': return 'Read a history entry';
    case 'diagnose_last_failure': return 'Diagnosed a failure';
    case 'create_collection': return 'Created a collection';
    case 'save_request': return 'Saved a request';
    case 'delete_request': return 'Deleted a request';
    case 'save_example': return 'Saved an example';
    case 'set_variable': return 'Set a variable';
    case 'generate_tests': return 'Generated tests';
    case 'git_status': return 'Checked Git status';
    case 'git_diff': return 'Read the Git diff';
    case 'git_create_branch': return 'Created a branch';
    case 'git_commit': return 'Committed changes';
    case 'git_push': return 'Pushed the branch';
    case 'pull_request_url': return 'Built a pull request link';
    default: return name ?? 'Tool';
  }
}

export function agentChangeSummary(change: AgentFileChange): string {
  if (change.tooLarge) return 'changed';
  if (change.before == null) return 'new file';
  if (change.after == null) return 'deleted';
  return 'changed';
}

export function agentApprovalTitle(approval: AgentApproval): string {
  if (approval.tool === 'git_push') return 'Push this branch?';
  if (approval.tool === 'git_create_branch') return 'Create this branch?';
  if (approval.tool === 'git_commit') return approval.changes.length === 1 ? 'Commit 1 file?' : `Commit ${approval.changes.length} files?`;
  if (approval.kind === 'external') return 'Authorize this request?';
  if (approval.tool === 'apply_changes') return 'Apply these changes?';
  if (approval.kind === 'write') {
    return approval.changes.length === 1 ? 'Change 1 file?' : `Change ${approval.changes.length} files?`;
  }
  return 'Send this request?';
}

export function agentApprovalAction(approval: AgentApproval): string {
  if (approval.tool === 'git_push') return 'Push';
  if (approval.tool === 'git_create_branch') return 'Create branch';
  if (approval.tool === 'git_commit') return 'Commit';
  if (approval.kind === 'write') return 'Apply';
  return approval.kind === 'external' ? 'Authorize' : 'Send';
}

export function agentApprovalArguments(approval: AgentApproval): string {
  try {
    return JSON.stringify(JSON.parse(approval.arguments || '{}'), null, 2);
  } catch {
    return approval.arguments;
  }
}

export function agentContextPercent(tokens: number, window: number): number | null {
  return Number.isFinite(tokens) && tokens >= 0 && Number.isFinite(window) && window > 0 ? Math.min(100, Math.round(tokens / window * 100)) : null;
}

export function agentQuotaWindows(limits: CodexRateLimit[]): Array<{ label: string; duration: string; remaining: number; resetsAt: number }> {
  return limits.flatMap(limit => [limit.primary, limit.secondary].flatMap((window, index) => {
    if (!window || !Number.isFinite(window.usedPercent)) return [];
    const minutes = window.windowDurationMins ?? 0;
    const duration = minutes > 0 ? minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m` : index === 0 ? 'Primary' : 'Secondary';
    return [{ label: `${limit.limitName || limit.limitId || 'Codex'} · ${duration}`, duration, remaining: Math.max(0, Math.min(100, 100 - window.usedPercent)), resetsAt: window.resetsAt ?? 0 }];
  }));
}

export type AgentStepSummary = { target: string; detail: string; status: number; durationMs: number };

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function agentStepSummary(block: AiBlock, result?: AiBlock): AgentStepSummary {
  const input = parseInput(block.input);
  const output = result && !result.isError ? parseInput(result.text) : {};
  const target = text(output.name) || text(input.request) || text(input.name) || text(input.collection) || text(input.environment) || text(input.entry) || text(input.variable);
  const method = text(output.method) || text(input.method);
  const url = text(output.url) || text(input.url);
  const detail = [method.toUpperCase(), url].filter(Boolean).join(' ');
  const status = numberField(output.statusCode) || numberField(output.status);
  return { target, detail: detail === target ? '' : detail, status, durationMs: numberField(output.durationMs) };
}

export type AgentTurnSegment<T> =
  | { kind: 'block'; step: T; block: AiBlock; blockIndex: number }
  | { kind: 'tools'; items: Array<{ step: T; block: AiBlock; blockIndex: number }> }
  | { kind: 'error'; step: T; error: string };

export function agentTurnSegments<T extends { blocks: AiBlock[]; error?: string }>(steps: T[]): AgentTurnSegment<T>[] {
  const segments: AgentTurnSegment<T>[] = [];
  for (const step of steps) {
    step.blocks.forEach((block, blockIndex) => {
      if (block.type === 'tool_use') {
        const last = segments.at(-1);
        if (last?.kind === 'tools') last.items.push({ step, block, blockIndex });
        else segments.push({ kind: 'tools', items: [{ step, block, blockIndex }] });
        return;
      }
      if (block.type === 'text' && !block.text) return;
      if (block.type === 'thinking' && !(block.text ?? '').trim()) return;
      segments.push({ kind: 'block', step, block, blockIndex });
    });
    if (step.error) segments.push({ kind: 'error', step, error: step.error });
  }
  return segments;
}

export const AGENT_WRITE_TOOLS = ['save_request', 'delete_request', 'save_example', 'set_variable', 'create_collection', 'generate_tests'];
