export type ScriptLogLevel = 'log' | 'request' | 'warn' | 'error';

const LEVEL_PREFIXES: [string, ScriptLogLevel][] = [
  ['[error] ', 'error'],
  ['[warn] ', 'warn'],
  ['[request] ', 'request'],
];

export function parseScriptLog(line: string): { level: ScriptLogLevel; text: string } {
  for (const [prefix, level] of LEVEL_PREFIXES) {
    if (line.startsWith(prefix)) return { level, text: line.slice(prefix.length) };
  }
  return { level: 'log', text: line };
}

type ScriptResultLike = { error?: string; logs?: string[] | null } | null | undefined;

export function scriptProblemCount(...results: ScriptResultLike[]): number {
  let count = 0;
  for (const result of results) {
    if (result?.error) count += 1;
    for (const line of result?.logs ?? []) {
      if (parseScriptLog(line).level === 'error') count += 1;
    }
  }
  return count;
}

export const LOG_PREVIEW_CHARS = 600;
export const LOG_PREVIEW_LINES = 8;

export function scriptLogPreview(text: string): string | null {
  const lines = text.split('\n');
  if (text.length <= LOG_PREVIEW_CHARS && lines.length <= LOG_PREVIEW_LINES) return null;
  let preview = lines.slice(0, LOG_PREVIEW_LINES).join('\n');
  if (preview.length > LOG_PREVIEW_CHARS) preview = preview.slice(0, LOG_PREVIEW_CHARS);
  return `${preview.trimEnd()}…`;
}
