import { describe, expect, it } from 'vitest';
import { AGENT_NOTES_STARTER, agentNotesBytes, agentNotesSize, agentNotesTemplateCount } from '../lib/agentNotes';

describe('agent notes', () => {
  it('counts the templates the agent picks up', () => {
    expect(agentNotesTemplateCount(AGENT_NOTES_STARTER)).toBe(1);
    expect(agentNotesTemplateCount('# Notes\n\n## Templates\n\n### One\nA\n### Two\nB\n\n## Other\n### Not one\n')).toBe(2);
    expect(agentNotesTemplateCount('## templates\n### Case\nx\n# Title\n### After a title\n')).toBe(1);
    expect(agentNotesTemplateCount('### Outside\n')).toBe(0);
  });

  it('measures the file in bytes against the 32 KB limit', () => {
    expect(agentNotesBytes('é')).toBe(2);
    expect(agentNotesSize('abc')).toBe('3 B of 32 KB');
    expect(agentNotesSize('x'.repeat(2048))).toBe('2.0 KB of 32 KB');
  });
});
