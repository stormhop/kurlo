import { describe, expect, it, vi } from 'vitest';
import { readRequestFileBar } from '../lib/requestFileBar';
import { RequestFileDraft, type RequestFileResult } from '../lib/requestFileDraft.svelte';

function successful(content: string, revision: string, path = 'requests/example.yaml'): RequestFileResult {
  return { ok: true, content, revision, path };
}

describe('request file draft', () => {
  it('loads a file and saves edits against its revision', async () => {
    const read = vi.fn().mockResolvedValue(successful('name: Example\n', 'r1'));
    const write = vi.fn().mockResolvedValue(successful('name: Changed\n', 'r2'));
    const draft = new RequestFileDraft(read, write);

    expect(await draft.open()).toBe(true);
    expect(draft.path).toBe('requests/example.yaml');
    expect(draft.dirty).toBe(false);
    draft.edit('name: Changed\n');
    expect(await draft.save()).toBe(true);
    expect(write).toHaveBeenCalledWith('name: Changed\n', 'r1');
    expect(draft.dirty).toBe(false);
    expect(draft.revision).toBe('r2');
  });

  it('switches protocol in the same draft and preserves unrelated YAML across conversions', async () => {
    const source = 'version: 1\nrequest:\n  id: example\n  url: https://example.test/path\n  bodyContent: |-\n    {"keep": true}\n';
    const write = vi.fn();
    const draft = new RequestFileDraft(async () => successful(source, 'r1'), write);
    await draft.open();
    for (const type of ['graphql', 'ai', 'grpc', 'mcp', 'socketio', 'ws'] as const) {
      draft.changeProtocol(type);
      expect(draft.barType).toBe(type);
      expect(draft.barValues?.method).toBe(type === 'ws' || type === 'socketio' ? 'GET' : 'POST');
      expect(draft.content).toContain('  bodyContent: |-\n    {"keep": true}\n');
    }
    expect(draft.barValues?.url).toBe('wss://example.test/path');
    draft.changeProtocol('http', 'DELETE');
    expect(draft.barValues).toMatchObject({ method: 'DELETE', url: 'https://example.test/path', requestType: 'http' });
    expect(write).not.toHaveBeenCalled();
    draft.discard();
    expect(draft.content).toBe(source);
  });

  it('keeps a malformed target intact and clears the toolbar error after a YAML edit', async () => {
    const source = 'version: 1\nrequest:\n  url: [two, values]\n';
    const draft = new RequestFileDraft(async () => successful(source, 'r1'), vi.fn());
    await draft.open();
    draft.editBar({ url: 'next' });
    expect(draft.content).toBe(source);
    expect(draft.barIssue).toBeTruthy();
    draft.edit(source.replace('[two, values]', 'repaired'));
    expect(draft.barIssue).toBe('');
    expect(draft.barValues?.url).toBe('repaired');
  });

  it('returns a toolbar URL edit to its exact source and clears dirty only when no other edits remain', async () => {
    const original = 'version: 1\r\nrequest:\r\n  url: https://saved.test # endpoint\r\n  method: GET\r\n';
    const draft = new RequestFileDraft(async () => successful(original, 'r1'), vi.fn());
    await draft.open();
    draft.editBar({ url: 'https://saved.testx' });
    expect(draft.dirty).toBe(true);
    draft.editBar({ url: 'https://saved.test' });
    expect(draft.content).toBe(original);
    expect(draft.dirty).toBe(false);
    expect(draft.canRevert).toBe(false);

    draft.editBar({ method: 'PATCH' });
    draft.editBar({ url: 'https://saved.testx' });
    draft.editBar({ url: 'https://saved.test' });
    expect(draft.content).toBe(original.replace('method: GET', 'method: "PATCH"'));
    expect(draft.dirty).toBe(true);
  });

  it('restores exact URL text for small and indexed files, including omitted fields', async () => {
    const url = 'https://saved.test';
    for (const [yaml, originalUrl] of [
      ['request:\r\n  url: https://saved.test # endpoint\r\n', url],
      ["request:\n  url: 'https://saved.test'\n", url],
      ['request: {url: "https://saved.test", method: GET}', url],
      ['request: {method: GET}', ''],
      ['request:\n  url: # empty endpoint\n', ''],
      ['request:\r\n  method: GET', ''],
    ]) {
      for (const large of [false, true]) {
        const original = (large ? '# ' + 'x'.repeat(300 * 1024) + '\r\n' : '') + 'version: 1\r\n' + yaml;
        const draft = new RequestFileDraft(async () => successful(original, 'r1'), vi.fn());
        await draft.open();
        if (large) draft.acceptBarIndex(original, readRequestFileBar(original, { includeRanges: true }));
        draft.editBar({ url: originalUrl });
        expect(draft.dirty).toBe(false);
        draft.editBar({ url: 'https://typed.test' });
        expect(draft.barValues?.url).toBe('https://typed.test');
        draft.editBar({ url: originalUrl });
        expect(draft.content).toBe(original);
        expect(draft.canRevert).toBe(false);

        draft.editBar({ method: 'PATCH' });
        const methodEdit = draft.content;
        draft.editBar({ url: 'x' });
        draft.editBar({ url: originalUrl });
        expect(draft.content).toBe(methodEdit);
      }
    }
  });

  it('keeps a manual YAML edit when the toolbar URL returns to its starting value', async () => {
    const original = 'version: 1\nrequest:\n  url: https://saved.test\n';
    const draft = new RequestFileDraft(async () => successful(original, 'r1'), vi.fn());
    await draft.open();
    draft.editBar({ url: 'https://saved.testx' });
    const manual = draft.content.replace('url: "https://saved.testx"', 'url: "https://manual.test" # manual');
    draft.edit(manual);
    draft.editBar({ url: 'https://saved.test' });
    expect(draft.content).toContain('url: "https://saved.test" # manual');
    expect(draft.dirty).toBe(true);
  });

  it('keeps URL normalization changes while restoring the starting URL independently', async () => {
    const original = 'version: 1\nrequest:\n  url: https://saved.test\n  method: GET\n';
    const draft = new RequestFileDraft(async () => successful(original, 'r1'), vi.fn());
    await draft.open();
    draft.changeProtocol('ws');
    draft.changeProtocol('http');
    expect(draft.content).toBe('version: 1\nrequest:\n  url: https://saved.test\n  method: GET\n  requestType: "http"\n');
    expect(draft.dirty).toBe(true);
    expect(draft.barValues?.url).toBe('https://saved.test');
  });

  it('keeps boolean toolbar fields typed while replaying independent edits', async () => {
    const original = 'version: 1\nrequest:\n  url: https://saved.test\n  nameAuto: true\n';
    const draft = new RequestFileDraft(async () => successful(original, 'r1'), vi.fn());
    await draft.open();
    draft.editBar({ nameAuto: false });
    draft.editBar({ url: 'https://saved.test/changed' });
    draft.editBar({ url: 'https://saved.test' });

    expect(draft.content).toBe('version: 1\nrequest:\n  url: https://saved.test\n  nameAuto: false\n');
    expect(draft.barValues?.nameAuto).toBe('false');
  });

  it('reuses scalar ranges in a large file and ignores stale background results', async () => {
    const body = '    ' + 'x'.repeat(300 * 1024) + '\r\n';
    const original = 'version: 1\r\nrequest:\r\n  id: example\r\n  name: Original\r\n  url: old # keep\r\n  bodyContent: |-\r\n' + body;
    const draft = new RequestFileDraft(async () => successful(original, 'r1'), vi.fn());
    await draft.open();
    const first = readRequestFileBar(original, { includeRanges: true });
    draft.acceptBarIndex(original, first);
    for (const url of ['https://short.test', '{{baseUrl}}/orders?note="one"', 'x']) {
      draft.editBar({ url });
      draft.editBar({ name: 'Request ' + url.length });
      expect(draft.needsBarIndex).toBe(false);
      expect(draft.content).toContain('url: ' + JSON.stringify(url) + ' # keep\r\n');
      expect(draft.barValues?.url).toBe(url);
    }
    const newer = draft.content.replace('url: "x"', 'url: newer');
    draft.edit(newer);
    expect(draft.needsBarIndex).toBe(true);
    draft.acceptBarIndex(original, first);
    expect(draft.needsBarIndex).toBe(true);
    draft.changeProtocol('ws');
    expect(draft.barValues).toMatchObject({ requestType: 'ws', url: 'newer' });
    expect(draft.content).toContain('bodyContent: |-\r\n' + body);
  });

  it('keeps edits made while a save is in flight', async () => {
    let finishSave: (result: RequestFileResult) => void = () => {};
    const write = vi.fn(() => new Promise<RequestFileResult>(resolve => { finishSave = resolve; }));
    const draft = new RequestFileDraft(async () => successful('name: Example\n', 'r1'), write);
    await draft.open();
    draft.edit('name: First edit\n');
    const saving = draft.save();
    draft.edit('name: Second edit\n');
    finishSave(successful('name: First edit\n', 'r2'));

    expect(await saving).toBe(true);
    expect(draft.content).toBe('name: Second edit\n');
    expect(draft.savedContent).toBe('name: First edit\n');
    expect(draft.dirty).toBe(true);
  });

  it.each(['https://saved.test', 'https://saved.test/second'])('keeps a later toolbar edit to %s reversible after a formatted save', async liveUrl => {
    const original = 'version: 1\nrequest:\n  url: https://saved.test\n  method: GET\n';
    const formatted = 'version: 1\nrequest:\n  method: GET\n  url: https://saved.test/first\n';
    let submitted = '';
    let finishSave: (result: RequestFileResult) => void = () => {};
    const draft = new RequestFileDraft(
      async () => successful(original, 'r1'),
      content => {
        submitted = content;
        return new Promise<RequestFileResult>(resolve => { finishSave = resolve; });
      },
    );
    await draft.open();
    draft.editBar({ url: 'https://saved.test/first' });
    const saving = draft.save();
    draft.editBar({ url: liveUrl });
    finishSave(successful(formatted, 'r2'));
    expect(await saving).toBe(true);
    draft.editBar({ url: 'https://saved.test/first' });

    expect(draft.content).toBe(formatted);
    expect(draft.savedContent).toBe(formatted);
    expect(draft.dirty).toBe(false);
    expect(submitted).not.toBe(formatted);
  });

  it('does not rebase a toolbar session over a manual edit made while save is in flight', async () => {
    const original = 'version: 1\nrequest:\n  url: https://saved.test\n';
    let submitted = '';
    let finishSave: (result: RequestFileResult) => void = () => {};
    const draft = new RequestFileDraft(
      async () => successful(original, 'r1'),
      content => {
        submitted = content;
        return new Promise<RequestFileResult>(resolve => { finishSave = resolve; });
      },
    );
    await draft.open();
    draft.editBar({ url: 'https://saved.test/first' });
    const saving = draft.save();
    const manual = draft.content + '# manual note\n';
    draft.edit(manual);
    draft.editBar({ url: 'https://saved.test/second' });
    finishSave(successful(submitted, 'r2'));
    expect(await saving).toBe(true);
    draft.editBar({ url: 'https://saved.test/first' });

    expect(draft.content).toBe(manual);
    expect(draft.dirty).toBe(true);
  });

  it('returns the active save promise to concurrent close or quit guards', async () => {
    let finishSave: (result: RequestFileResult) => void = () => {};
    const draft = new RequestFileDraft(
      async () => successful('name: Example\n', 'r1'),
      () => new Promise<RequestFileResult>(resolve => { finishSave = resolve; }),
    );
    await draft.open();
    draft.edit('name: Changed\n');
    const save = draft.save();

    expect(draft.save()).toBe(save);
    finishSave(successful('name: Changed\n', 'r2'));
    expect(await save).toBe(true);
  });

  it('retains local edits when a refresh detects a disk change', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(successful('name: Example\n', 'r1'))
      .mockResolvedValueOnce(successful('name: Changed externally\n', 'r2'))
      .mockResolvedValueOnce(successful('name: Changed externally\n', 'r2'));
    const draft = new RequestFileDraft(read, vi.fn());
    await draft.open();
    draft.edit('name: Local edit\n');

    expect(await draft.open()).toBe(true);
    expect(draft.content).toBe('name: Local edit\n');
    expect(draft.remoteContent).toBe('name: Changed externally\n');
    expect(draft.conflicted).toBe(true);
    expect(await draft.save()).toBe(false);
    await draft.reloadRemote();
    expect(draft.content).toBe('name: Changed externally\n');
    expect(draft.dirty).toBe(false);
  });

  it('applies only the newest overlapping read result', async () => {
    const results: Array<(result: RequestFileResult) => void> = [];
    const read = vi.fn(() => new Promise<RequestFileResult>(resolve => { results.push(resolve); }));
    const draft = new RequestFileDraft(read, vi.fn());
    const first = draft.open();
    const second = draft.open();
    results[1](successful('name: Newest\n', 'r2'));
    expect(await second).toBe(true);
    results[0](successful('name: Stale\n', 'r1'));
    expect(await first).toBe(false);
    expect(draft.content).toBe('name: Newest\n');
    expect(draft.loading).toBe(false);
  });

  it('ignores a read that started before a successful write', async () => {
    let finishRead: (result: RequestFileResult) => void = () => {};
    let finishSave: (result: RequestFileResult) => void = () => {};
    const read = vi.fn()
      .mockResolvedValueOnce(successful('name: Example\n', 'r1'))
      .mockImplementationOnce(() => new Promise<RequestFileResult>(resolve => { finishRead = resolve; }));
    const write = vi.fn(() => new Promise<RequestFileResult>(resolve => { finishSave = resolve; }));
    const draft = new RequestFileDraft(read, write);
    await draft.open();
    draft.edit('name: Saved\n');
    const staleRead = draft.open();
    const save = draft.save();
    finishSave(successful('name: Saved\n', 'r2'));

    expect(await save).toBe(true);
    finishRead(successful('name: Stale disk read\n', 'r3'));
    expect(await staleRead).toBe(false);
    expect(draft.content).toBe('name: Saved\n');
    expect(draft.revision).toBe('r2');
  });

  it('requires a base revision before enabling editing', async () => {
    const draft = new RequestFileDraft(async () => ({ ok: true, content: 'name: Example\n' }), vi.fn());

    expect(await draft.open()).toBe(false);
    expect(draft.ready).toBe(false);
    expect(draft.error).toContain('no revision');
  });

  it('reloads disk when a conflict response omits the remote snapshot', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(successful('name: Example\n', 'r1'))
      .mockResolvedValueOnce(successful('name: External\n', 'r2'));
    const write = vi.fn().mockResolvedValue({ ok: false, conflict: true, error: 'File changed externally' });
    const draft = new RequestFileDraft(read, write);
    await draft.open();
    draft.edit('name: Local\n');

    expect(await draft.save()).toBe(false);
    expect(draft.conflicted).toBe(true);
    expect(await draft.reloadRemote()).toBe(true);
    expect(draft.content).toBe('name: External\n');
    expect(draft.revision).toBe('r2');
    expect(draft.dirty).toBe(false);
  });

  it('preserves a save validation error through a successful remount refresh', async () => {
    const read = vi.fn().mockResolvedValue(successful('name: Example\n', 'r1'));
    const write = vi.fn().mockResolvedValue({ ok: false, error: 'Invalid YAML', line: 2 });
    const draft = new RequestFileDraft(read, write);
    await draft.open();
    draft.edit('name: [\n');
    expect(await draft.save()).toBe(false);
    await draft.open();

    expect(draft.error).toBe('Invalid YAML');
    expect(draft.errorLine).toBe(2);
    expect(draft.content).toBe('name: [\n');
  });

  it('keeps Revert available for a clean draft with a validation error', async () => {
    const draft = new RequestFileDraft(
      async () => successful('name: Example\n', 'r1'),
      async () => ({ ok: false, error: 'Invalid YAML', line: 2 }),
    );
    await draft.open();
    draft.edit('name: [\n');
    await draft.save();
    draft.edit('name: Example\n');

    expect(draft.dirty).toBe(false);
    expect(draft.error).toBe('Invalid YAML');
    expect(draft.canRevert).toBe(true);
    draft.discard();
    expect(draft.error).toBe('');
    expect(draft.canRevert).toBe(false);
  });

  it('preserves edits made while a conflict reload is pending', async () => {
    let finishRead: (result: RequestFileResult) => void = () => {};
    const read = vi.fn()
      .mockResolvedValueOnce(successful('name: Example\n', 'r1'))
      .mockImplementationOnce(() => new Promise<RequestFileResult>(resolve => { finishRead = resolve; }));
    const draft = new RequestFileDraft(read, vi.fn());
    await draft.open();
    draft.edit('name: Local\n');
    draft.remoteContent = 'name: External\n';
    draft.remoteRevision = 'r2';
    draft.conflict = true;
    const reloading = draft.reloadRemote();
    draft.edit('name: Local edit during reload\n');
    finishRead(successful('name: Latest external\n', 'r3'));

    expect(await reloading).toBe(false);
    expect(draft.content).toBe('name: Local edit during reload\n');
    expect(draft.remoteContent).toBe('name: Latest external\n');
    expect(draft.remoteRevision).toBe('r3');
    expect(draft.conflicted).toBe(true);
  });

  it('rebases a local draft after choosing to keep it over the disk version', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(successful('name: Example\n', 'r1'))
      .mockResolvedValueOnce(successful('name: External\n', 'r2'));
    const write = vi.fn().mockResolvedValue(successful('name: Mine\n', 'r3'));
    const draft = new RequestFileDraft(read, write);
    await draft.open();
    draft.edit('name: Mine\n');
    await draft.open();
    draft.keepLocalChanges();

    expect(draft.dirty).toBe(true);
    expect(draft.conflicted).toBe(false);
    expect(await draft.save()).toBe(true);
    expect(write).toHaveBeenCalledWith('name: Mine\n', 'r2');
  });
});
