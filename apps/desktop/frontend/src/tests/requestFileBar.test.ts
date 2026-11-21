import { describe, expect, it } from 'vitest';
import { patchRequestFileBar, readRequestFileBar } from '../lib/requestFileBar';

describe('requestFileBar', () => {
  it('reads toolbar fields and booleans from a block mapping with quoted keys', () => {
    const source = [
      'version: 1',
      'request:',
      '  "name": AI request',
      '  nameAuto: false',
      '  url: https://example.test',
      "  method: 'GET'",
      '  requestType: http',
      '  bodyType: json',
      '  aiProvider: kurlo',
      '  aiModel: model-a',
      '  aiConnectionId: connection-a',
      '  grpcMethod: package.Service/Method',
      '',
    ].join('\n');

    expect(readRequestFileBar(source)).toEqual({
      ok: true,
      values: {
        name: 'AI request',
        nameAuto: 'false',
        url: 'https://example.test',
        method: 'GET',
        requestType: 'http',
        bodyType: 'json',
        aiProvider: 'kurlo',
        aiModel: 'model-a',
        aiConnectionId: 'connection-a',
        grpcMethod: 'package.Service/Method',
      },
      fieldErrors: {},
    });
  });

  it('patches several scalar values and leaves other source text intact', () => {
    const source = [
      '# saved comment',
      'version: 1',
      'request:',
      '  id: request-a',
      '  url: "{{baseUrl}}/old" # endpoint note',
      '  method: GET',
      '  bodyContent: |',
      '    payload: unchanged',
      '',
    ].join('\r\n');
    const result = patchRequestFileBar(source, {
      url: 'https://example.test/path?q="hello"',
      method: 'PATCH',
      nameAuto: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('url: "https://example.test/path?q=\\"hello\\"" # endpoint note');
    expect(result.content).toContain('method: "PATCH"');
    expect(result.content).toContain('nameAuto: false');
    expect(result.content).toContain('bodyContent: |\r\n    payload: unchanged');
    expect(result.content).toContain('# saved comment\r\n');
    expect(result.content).toContain('\r\n  method:');
  });

  it('patches flow mappings without changing their comments or layout', () => {
    const source = `version: 1\r\nrequest: {"url": "old", method: GET, nameAuto: true} # keep\r\n`;
    const result = patchRequestFileBar(source, { url: 'https://new.test', method: 'POST', nameAuto: false });

    expect(result).toEqual({
      ok: true,
      content: `version: 1\r\nrequest: {"url": "https://new.test", method: "POST", nameAuto: false} # keep\r\n`,
    });
  });

  it('inserts missing values into block and flow mappings', () => {
    const block = 'version: 1\nrequest:\n  id: request-a\n  url:\n';
    const blockResult = patchRequestFileBar(block, { method: 'GET', requestType: 'http' });
    expect(blockResult.ok && blockResult.content).toBe('version: 1\nrequest:\n  id: request-a\n  url:\n  method: "GET"\n  requestType: "http"\n');

    const flow = patchRequestFileBar('version: 1\nrequest: {id: request-a}\n', { url: 'https://new.test' });
    expect(flow).toEqual({ ok: true, content: 'version: 1\nrequest: {id: request-a, url: "https://new.test"}\n' });
  });

  it('keeps following top-level keys and comments separated when inserting toolbar fields', () => {
    const source = 'version: 1\nrequest:\n  bodyContent: |+\n    first\n\n\n# request order\norder: 4\n';
    const result = patchRequestFileBar(source, { url: 'https://new.test' });

    expect(result).toEqual({
      ok: true,
      content: 'version: 1\nrequest:\n  bodyContent: |+\n    first\n\n\n  url: "https://new.test"\n# request order\norder: 4\n',
    });
  });

  it('preserves a final newline when inserting at end of file', () => {
    const result = patchRequestFileBar('version: 1\nrequest:\n  id: request-a\n', { url: 'https://new.test' });
    expect(result).toEqual({ ok: true, content: 'version: 1\nrequest:\n  id: request-a\n  url: "https://new.test"\n' });
  });

  it('returns changed content from one parse', () => {
    expect(patchRequestFileBar('version: 1\nrequest: {url: old}\n', { url: 'new' })).toEqual({
      ok: true,
      content: 'version: 1\nrequest: {url: "new"}\n',
    });
  });

  it('keeps existing scalar quoting when the value is already the same', () => {
    const quoted = 'version: 1\nrequest: {url: "https://same.test"}\n';
    expect(patchRequestFileBar(quoted, { url: 'https://same.test' })).toEqual({ ok: true, content: quoted });

    const boolean = 'version: 1\nrequest: {nameAuto: false}\n';
    expect(patchRequestFileBar(boolean, { nameAuto: false })).toEqual({ ok: true, content: boolean });

    const stringBoolean = 'version: 1\nrequest: {url: false}\n';
    expect(patchRequestFileBar(stringBoolean, { url: 'false' })).toEqual({ ok: true, content: 'version: 1\nrequest: {url: "false"}\n' });
  });

  it('returns optional ranges only for unique, decodable scalar toolbar fields', () => {
    const source = 'version: 1\nrequest:\n  url: "https://example.test"\n  nameAuto: false\n  aiModel: *model\n  aiModel: other\n';
    const result = readRequestFileBar(source, { includeRanges: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ranges).toEqual({
      url: { from: source.indexOf('"https://example.test"'), to: source.indexOf('"https://example.test"') + '"https://example.test"'.length },
      nameAuto: { from: source.indexOf('false'), to: source.indexOf('false') + 'false'.length },
    });
    expect(result.fieldErrors.aiModel).toContain('duplicated');

    const withoutRanges = readRequestFileBar(source);
    expect(withoutRanges.ok && 'ranges' in withoutRanges).toBe(false);
  });

  it('rejects duplicate keys and non-scalar targets atomically', () => {
    const duplicate = 'version: 1\nrequest:\n  url: old\n  url: other\n  method: GET\n';
    expect(patchRequestFileBar(duplicate, { method: 'POST' }).ok).toBe(true);
    expect(patchRequestFileBar(duplicate, { url: 'new' })).toMatchObject({ ok: false });

    const sequence = 'version: 1\nrequest:\n  url: old\n  method: [GET]\n';
    expect(patchRequestFileBar(sequence, { url: 'new', method: 'POST' })).toMatchObject({ ok: false });
    expect(sequence).toBe('version: 1\nrequest:\n  url: old\n  method: [GET]\n');
  });

  it('rejects multiline and ambiguous request structures without changing source', () => {
    const blockValue = 'version: 1\nrequest:\n  url: |\n    first\n    second\n';
    expect(patchRequestFileBar(blockValue, { url: 'single-line' })).toMatchObject({ ok: false });

    const duplicateRequest = 'version: 1\nrequest: {url: first}\nrequest: {url: second}\n';
    expect(readRequestFileBar(duplicateRequest)).toMatchObject({ ok: false });

    const malformed = 'version: 1\nrequest: [unfinished\n';
    expect(patchRequestFileBar(malformed, { url: 'new' })).toMatchObject({ ok: false });
  });

  it('rejects aliases, block scalars, and unsupported YAML quote escapes safely', () => {
    expect(readRequestFileBar('version: 1\nrequest: {url: *endpoint}\n')).toMatchObject({ ok: true, fieldErrors: { url: expect.stringContaining('single-line scalar') } });
    expect(readRequestFileBar('version: 1\nrequest:\n  url: >-\n    first\n    second\n')).toMatchObject({ ok: true, fieldErrors: { url: expect.stringContaining('single-line scalar') } });
    expect(readRequestFileBar('version: 1\nrequest:\n  url: "\\x41"\n')).toMatchObject({ ok: true, fieldErrors: { url: expect.stringContaining('cannot be decoded safely') } });
    expect(patchRequestFileBar('version: 1\nrequest: {url: *endpoint}\n', { url: 'new' })).toMatchObject({ ok: false });
  });

  it('keeps clear toolbar values usable when another request field is malformed', () => {
    const source = 'version: 1\nrequest:\n  url: old\n  headers: [unfinished\n';
    const read = readRequestFileBar(source);
    expect(read.ok && read.values.url).toBe('old');
    expect(patchRequestFileBar(source, { url: 'new' })).toMatchObject({ ok: true });
    expect(patchRequestFileBar(source, { requestType: 'http' })).toMatchObject({ ok: false });

    const duplicate = 'version: 1\nrequest:\n  url: old\n  aiModel: first\n  aiModel: second\n';
    const duplicateRead = readRequestFileBar(duplicate);
    expect(duplicateRead.ok && duplicateRead.values.url).toBe('old');
    expect(duplicateRead.ok && duplicateRead.fieldErrors.aiModel).toContain('duplicated');
    expect(patchRequestFileBar(duplicate, { url: 'new' })).toMatchObject({ ok: true });
    expect(patchRequestFileBar(duplicate, { aiModel: 'new' })).toMatchObject({ ok: false });
  });

  it('does not let the toolbar helper edit service-managed fields', () => {
    for (const key of ['id', 'collectionId', 'filesystemName', 'examples', 'order']) {
      expect(patchRequestFileBar('version: 1\nrequest: {url: old}\n', { [key]: 'changed' })).toMatchObject({ ok: false });
    }
  });

  it('reuses an incremental YAML parse after a toolbar edit', () => {
    const source = 'version: 1\nrequest:\n  id: request-a\n  url: old\n  bodyContent: |\n    value\norder: 1\n';
    const changed = patchRequestFileBar(source, { url: 'new' });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(readRequestFileBar(changed.content)).toEqual({ ok: true, values: { url: 'new' }, fieldErrors: {} });
  });

  it('keeps toolbar edits working with bodies larger than 256 KiB', () => {
    const body = 'x'.repeat(300 * 1024);
    const source = `version: 1\nrequest:\n  url: old\n  bodyContent: ${JSON.stringify(body)}\n`;
    const changed = patchRequestFileBar(source, { url: 'new' });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.content).toContain('url: "new"');
    expect(changed.content).toContain(JSON.stringify(body));
  });
});
