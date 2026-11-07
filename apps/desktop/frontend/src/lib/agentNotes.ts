export const AGENT_NOTES_FILE = 'kurlo-agent.md';

export const AGENT_NOTES_MAX_BYTES = 32 * 1024;

export const AGENT_NOTES_STARTER = `# Notes for the agent

## Conventions

- Run tests against the Local environment.
- Name requests after what they do, such as "Create order".
- Never change requests in the Payments collection.

## Templates

### Smoke check
Run every request in REQUEST NAME and explain the failures.
`;

export function agentNotesBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function agentNotesSize(text: string): string {
  const bytes = agentNotesBytes(text);
  const limit = `${AGENT_NOTES_MAX_BYTES / 1024} KB`;
  if (bytes < 1024) return `${bytes} B of ${limit}`;
  return `${(bytes / 1024).toFixed(1)} KB of ${limit}`;
}

export function agentNotesTemplateCount(text: string): number {
  let inSection = false;
  let count = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) inSection = trimmed.slice(3).trim().toLowerCase() === 'templates';
    else if (trimmed.startsWith('# ')) inSection = false;
    else if (inSection && trimmed.startsWith('### ')) count++;
  }
  return count;
}
