import { describe, it, expect } from 'vitest';

import { renderResponseBodyLines } from '../lib/response-render';

function generateHugeJson(entryCount: number): string {
  const entries = Array.from({ length: entryCount }, (_, i) => ({
    id: i,
    name: `User ${i}`,
    email: `user${i}@example.com`,
    active: i % 2 === 0,
    score: Number((Math.sin(i) * 100).toFixed(4)),
    tags: ['api', 'kurlo', `tag-${i % 10}`],
    address: {
      street: `${i} Main St`,
      city: 'Springfield',
      state: 'IL',
      zip: String(10000 + i).padStart(5, '0'),
    },
    metadata: {
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
      updatedAt: new Date(Date.now() - i * 500).toISOString(),
      version: 1,
    },
  }));
  return JSON.stringify(entries, null, 2);
}

function generateDeepNestedJson(depth: number): string {
  let obj: Record<string, unknown> = { value: 'leaf', index: depth };
  for (let i = depth - 1; i >= 0; i--) {
    obj = { level: i, child: obj, data: Array.from({ length: 10 }, (_, j) => ({ k: j, v: `item-${i}-${j}` })) };
  }
  return JSON.stringify(obj, null, 2);
}

describe('Huge JSON parsing', () => {
  it('parses a 500-entry JSON array', () => {
    const json = generateHugeJson(500);
    const parsed = JSON.parse(json) as unknown[];
    expect(parsed).toHaveLength(500);
    expect((parsed[0] as { id: number }).id).toBe(0);
    expect((parsed[499] as { id: number }).id).toBe(499);
  });

  it('parses a 2000-entry JSON array', () => {
    const json = generateHugeJson(2000);
    const parsed = JSON.parse(json) as unknown[];
    expect(parsed).toHaveLength(2000);
  });

  it('round-trips 5000-entry JSON without data loss', () => {
    const json = generateHugeJson(5000);
    const reparsed = JSON.stringify(JSON.parse(json), null, 2);
    expect(reparsed).toBe(json);
  });

  it('handles deeply nested JSON (depth 50)', () => {
    const json = generateDeepNestedJson(50);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect(parsed.level).toBe(0);
  });
});

describe('Line rendering with huge JSON', () => {
  it('renders 500-entry JSON into correct line count', () => {
    const json = generateHugeJson(500);
    const lines = renderResponseBodyLines(json, 'json', '', 0);
    const rawLines = json.split('\n');
    expect(lines).toHaveLength(rawLines.length);
  });

  it('all lines have a number and html property', () => {
    const json = generateHugeJson(100);
    const lines = renderResponseBodyLines(json, 'json', '', 0);
    for (const line of lines) {
      expect(typeof line.number).toBe('number');
      expect(typeof line.html).toBe('string');
    }
  });

  it('line numbers are sequential from 1', () => {
    const json = generateHugeJson(50);
    const lines = renderResponseBodyLines(json, 'json', '', 0);
    expect(lines[0].number).toBe(1);
    expect(lines[lines.length - 1].number).toBe(lines.length);
  });

  it('syntax highlighting spans are present in JSON mode', () => {
    const json = JSON.stringify({ key: 'value', count: 42, active: true, nothing: null }, null, 2);
    const lines = renderResponseBodyLines(json, 'json', '', 0);
    const combined = lines.map(l => l.html).join('\n');
    expect(combined).toContain('class="jk"');
    expect(combined).toContain('class="js"');
    expect(combined).toContain('class="jn"');
    expect(combined).toContain('class="jb"');
    expect(combined).toContain('class="jnull"');
  });

  it('no HTML injection from user data', () => {
    const json = JSON.stringify({ xss: '<script>alert(1)</script>', url: 'a&b' }, null, 2);
    const lines = renderResponseBodyLines(json, 'json', '', 0);
    const combined = lines.map(l => l.html).join('\n');
    expect(combined).not.toContain('<script>');
    expect(combined).toContain('&lt;script&gt;');
    expect(combined).toContain('&amp;');
  });

  it('renders 2000-entry JSON under 500ms', () => {
    const json = generateHugeJson(2000);
    const start = performance.now();
    const lines = renderResponseBodyLines(json, 'json', '', 0);
    const elapsed = performance.now() - start;
    expect(lines.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });

  it('renders 5000-entry JSON under 2000ms', () => {
    const json = generateHugeJson(5000);
    const start = performance.now();
    const lines = renderResponseBodyLines(json, 'json', '', 0);
    const elapsed = performance.now() - start;
    expect(lines.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('JSON size metrics', () => {
  it('500-entry payload is at least 100KB', () => {
    const json = generateHugeJson(500);
    const bytes = new TextEncoder().encode(json).length;
    expect(bytes).toBeGreaterThan(100_000);
  });

  it('2000-entry payload is at least 400KB', () => {
    const json = generateHugeJson(2000);
    const bytes = new TextEncoder().encode(json).length;
    expect(bytes).toBeGreaterThan(400_000);
  });

  it('5000-entry payload is at least 1MB', () => {
    const json = generateHugeJson(5000);
    const bytes = new TextEncoder().encode(json).length;
    expect(bytes).toBeGreaterThan(1_000_000);
  });
});
