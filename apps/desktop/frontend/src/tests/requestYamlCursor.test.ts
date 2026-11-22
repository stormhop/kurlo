import { yamlLanguage } from '@codemirror/lang-yaml';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { requestYamlCursor } from '../lib/requestYamlCursor';

function context(source: string, marker: string, offset = 0, cursorOffset = 0) {
  const index = source.indexOf(marker, offset);
  if (index < 0) throw new Error(`Missing marker ${marker}`);
  const position = index + cursorOffset;
  return requestYamlCursor(EditorState.create({ doc: source, extensions: [yamlLanguage] }), position);
}

describe('requestYamlCursor', () => {
  it('returns the parent path and scalar siblings for a nested key', () => {
    const source = 'version: 1\nrequest:\n  auth:\n    type: basic\n    basicUser: user@example.test\n';
    expect(context(source, 'basicUser')).toMatchObject({
      path: ['request', 'auth'],
      kind: 'key',
      siblings: new Map([['type', 'basic'], ['basicUser', '']]),
    });
  });

  it('returns the full value path and replacement range for a quoted scalar', () => {
    const source = 'version: 1\nrequest:\n  requestType: http\n  method: POST\n  auth:\n    type: "basic"\n';
    const result = context(source, 'basic');
    expect(result).toMatchObject({
      path: ['request', 'auth', 'type'],
      kind: 'value',
      requestType: 'http',
      method: 'POST',
      hasColon: true,
    });
    expect(result && source.slice(result.from, result.to)).toBe('"basic"');
  });

  it('uses indentation to suggest fields in an empty nested mapping', () => {
    const source = 'version: 1\nrequest:\n  auth:\n    \n';
    expect(context(source, '    ', source.indexOf('    \n'), 4)).toMatchObject({
      path: ['request', 'auth'],
      kind: 'key',
      siblings: new Map(),
    });
  });

  it('offers key completion while an unfinished key is being typed', () => {
    const source = 'version: 1\nrequest:\n  auth:\n    basicU\n';
    const result = context(source, 'basicU', 0, 'basicU'.length);
    expect(result).toMatchObject({ path: ['request', 'auth'], kind: 'key' });
    expect(result && source.slice(result.from, result.to)).toBe('basicU');
  });

  it('keeps an unfinished first key inside an otherwise empty auth mapping', () => {
    const source = 'version: 1\nrequest:\n  auth:\n    ty';
    const result = context(source, 'ty', 0, 'ty'.length);
    expect(result).toMatchObject({ path: ['request', 'auth'], kind: 'key', siblings: new Map() });
  });

  it('offers value completion after a colon with no scalar yet', () => {
    const source = 'version: 1\nrequest:\n  requestType: http\n  auth:\n    type: ';
    expect(context(source, 'type: ', 0, 'type: '.length)).toMatchObject({
      path: ['request', 'auth', 'type'],
      kind: 'value',
      requestType: 'http',
      hasColon: true,
    });
  });

  it('keeps the mapping path for a future sibling key after existing entries', () => {
    const source = 'version: 1\nrequest:\n  auth:\n    type: basic\n    \n';
    expect(context(source, '    ', source.lastIndexOf('    '), 4)).toMatchObject({
      path: ['request', 'auth'],
      kind: 'key',
      siblings: new Map([['type', 'basic']]),
    });
  });

  it('uses the parent mapping when the cursor dedents', () => {
    const source = 'version: 1\nrequest:\n  auth:\n    type: basic\n  ';
    const result = context(source, '  ', source.length - 2, 2);
    expect(result).toMatchObject({
      path: ['request'],
      kind: 'key',
      siblings: new Map([['auth', '']]),
    });
  });

  it('marks row item mappings with a wildcard path', () => {
    const source = 'version: 1\nrequest:\n  headers:\n    - id: row-1\n      key: X-Test\n      value: yes\n';
    expect(context(source, 'key: X-Test')).toMatchObject({
      path: ['request', 'headers', '*'],
      kind: 'key',
      siblings: new Map([['id', ''], ['key', ''], ['value', '']]),
    });
  });

  it('offers row properties after a bare list marker', () => {
    const source = 'version: 1\nrequest:\n  headers:\n    - ';
    expect(context(source, '- ', 0, '- '.length)).toMatchObject({ path: ['request', 'headers', '*'], kind: 'key' });
  });

  it('offers key completion within a partially typed list item', () => {
    const source = 'version: 1\nrequest:\n  headers:\n    - ke';
    const result = context(source, 'ke', 0, 'ke'.length);
    expect(result).toMatchObject({ path: ['request', 'headers', '*'], kind: 'key' });
    expect(result && source.slice(result.from, result.to)).toBe('ke');
  });

  it('does not treat a list item value as a row key', () => {
    const source = 'version: 1\nrequest:\n  headers:\n    - enabled: f';
    const result = context(source, 'f', 0, 1);
    expect(result).toMatchObject({ path: ['request', 'headers', '*', 'enabled'], kind: 'value' });
    expect(result && source.slice(result.from, result.to)).toBe('f');
  });

  it('supports flow mappings', () => {
    const source = 'version: 1\nrequest:\n  auth: {type: basic, basicUser: user}\n';
    expect(context(source, 'basicUser')).toMatchObject({
      path: ['request', 'auth'],
      kind: 'key',
      inFlow: true,
      siblings: new Map([['type', 'basic'], ['basicUser', '']]),
    });
  });

  it('ignores comments and block scalar contents', () => {
    const comment = '# request.auth.type: basic\nversion: 1\nrequest:\n  auth:\n    # type: basic\n';
    const block = 'version: 1\nrequest:\n  requestNotes: |\n    auth:\n      type: basic\n';
    expect(context(comment, 'type: basic')).toBeNull();
    expect(context(block, 'type: basic')).toBeNull();
  });

  it('returns null for free text outside a mapping', () => {
    expect(context('some free text\n', 'some free text')).toBeNull();
  });

  it('keeps sibling values limited to scalar discriminators', () => {
    const source = 'version: 1\nrequest:\n  bodyType: json\n  bodyContent: ' + 'x'.repeat(500) + '\n  auth:\n    type: basic\n';
    const result = context(source, 'basic');
    expect(result?.siblings).toEqual(new Map([['type', 'basic']]));
    expect(result && source.slice(result.from, result.to)).toBe('basic');
  });

  it('reads quoted keys and infers the protocol in a legacy inline document', () => {
    const source = '{version: 1, request: {url: "wss://example.test", "auth": {"type": "basic", }}}';
    const pos = source.indexOf(', }') + 2;
    const state = EditorState.create({ doc: source, extensions: [yamlLanguage] });
    expect(requestYamlCursor(state, pos)).toMatchObject({
      path: ['request', 'auth'], requestType: 'ws', kind: 'key', siblings: new Map([['type', 'basic']]),
    });
  });
});
