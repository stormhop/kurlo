import { describe, expect, it } from 'vitest';
import { LOG_PREVIEW_CHARS, parseScriptLog, scriptLogPreview, scriptProblemCount } from '../lib/scriptLogs';
import { isVariableReferenceOnly } from '../lib/variables';

describe('parseScriptLog', () => {
  it('reads the level the script engine puts in front of a line', () => {
    expect(parseScriptLog('[error] boom')).toEqual({ level: 'error', text: 'boom' });
    expect(parseScriptLog('[warn] careful')).toEqual({ level: 'warn', text: 'careful' });
    expect(parseScriptLog('[request] pm.sendRequest GET https://x → 200 OK · 3 ms')).toEqual({ level: 'request', text: 'pm.sendRequest GET https://x → 200 OK · 3 ms' });
    expect(parseScriptLog('plain [error] text')).toEqual({ level: 'log', text: 'plain [error] text' });
  });

  it('counts uncaught errors and console.error lines across both scripts', () => {
    expect(scriptProblemCount({ error: 'ReferenceError', logs: ['ok'] }, { logs: ['[error] a', '[warn] b'] })).toBe(2);
    expect(scriptProblemCount(undefined, { logs: [] })).toBe(0);
  });
});

describe('isVariableReferenceOnly', () => {
  it('is true only when the value is nothing but {{variables}}', () => {
    expect(isVariableReferenceOnly('{{token}}')).toBe(true);
    expect(isVariableReferenceOnly(' {{a}}{{b}} ')).toBe(true);
    expect(isVariableReferenceOnly('Bearer {{token}}')).toBe(false);
    expect(isVariableReferenceOnly('eyJhbGciOi')).toBe(false);
    expect(isVariableReferenceOnly('')).toBe(false);
  });
});

describe('scriptLogPreview', () => {
  it('leaves short lines alone', () => {
    expect(scriptLogPreview('short')).toBeNull();
    expect(scriptLogPreview('a\nb\nc')).toBeNull();
  });

  it('cuts a long line to a preview with an ellipsis', () => {
    const preview = scriptLogPreview('x'.repeat(300000))!;
    expect(preview).toHaveLength(LOG_PREVIEW_CHARS + 1);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('keeps the first lines of a many-line log', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(scriptLogPreview(text)).toBe(`${Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n')}…`);
  });
});
