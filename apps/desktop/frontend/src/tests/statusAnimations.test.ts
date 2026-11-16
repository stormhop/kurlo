import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');

const cases: Array<[file: string, selector: string, animation: RegExp]> = [
  ['styles/mock.css', '.mock-pulse', /animation:\s*mock-pulse[^;]*\s3;/],
  ['styles/sse.css', '.sse-dot-live', /animation:\s*sse-pulse[^;]*\s3;/],
  ['styles/loadtest.css', '.sidebar-loadtest-status.running', /animation:\s*sidebar-loadtest-pulse[^;]*\s3;/],
  ['styles/request-extras.css', '.save-status-dot', /animation:\s*save-status-pulse[^;]*\s4;/],
  ['lib/components/AiConversationPanel.svelte', '.ai-live-dot', /animation:\s*ai-pulse[^;]*\s3;/],
  ['lib/components/AiConversationPanel.svelte', '.ai-caret', /animation:\s*ai-blink[^;]*\s6;/],
  ['lib/components/AboutNight.svelte', '.about-night-eye', /animation:\s*about-night-blink[^;]*\s2;/],
  ['lib/components/AboutNight.svelte', '.about-night-bird', /animation:\s*about-night-breathe[^;]*\s3;/],
];

function rule(source: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('status indicators', () => {
  it('pulse a few times and then stay still', () => {
    for (const [file, selector, animation] of cases) {
      const body = rule(readFileSync(join(SRC, file), 'utf8'), selector);
      expect(body, `${file} ${selector}`).toMatch(animation);
      expect(body, `${file} ${selector}`).not.toMatch(/infinite/);
    }
  });
});
