import { describe, expect, it } from 'vitest';
import { BINARY_DEFAULT_CONTENT_TYPE, binaryContentType, fileBaseName, isRemoteFileSource, requestFileDetails, resolveFilePathTemplate } from '../lib/filePathField';
import { requestBodyFeature } from '../lib/stores/features/requestBody';
import { mkRow } from '../lib/constants';
import type { KVRow } from '../lib/types/models';

describe('file path field', () => {
  it('resolves plain variables and leaves secrets and unknown names unresolved', () => {
    const suggestions = [
      { key: 'fixtures', value: 'data/fixtures' },
      { key: 'token', value: 'abc', secret: true },
    ];
    expect(resolveFilePathTemplate('{{fixtures}}/photo.png', suggestions)).toEqual({ path: 'data/fixtures/photo.png', unresolved: false });
    expect(resolveFilePathTemplate('{{ fixtures }}/a.bin', suggestions).path).toBe('data/fixtures/a.bin');
    expect(resolveFilePathTemplate('{{token}}/a.bin', suggestions).unresolved).toBe(true);
    expect(resolveFilePathTemplate('{{missing}}/a.bin', suggestions)).toEqual({ path: '{{missing}}/a.bin', unresolved: true });
    expect(resolveFilePathTemplate(' fixtures/a.bin ', suggestions)).toEqual({ path: 'fixtures/a.bin', unresolved: false });
  });

  it('treats URLs as remote sources but not file URLs or paths', () => {
    expect(isRemoteFileSource('https://api.example.com/openapi.json')).toBe(true);
    expect(isRemoteFileSource('file:///tmp/spec.yaml')).toBe(false);
    expect(isRemoteFileSource('specs/openapi.yaml')).toBe(false);
    expect(isRemoteFileSource('C:\\specs\\openapi.yaml')).toBe(false);
  });

  it('names the file and describes its size and type', () => {
    expect(fileBaseName('fixtures/photo.png')).toBe('photo.png');
    expect(fileBaseName('C:\\data\\body.bin')).toBe('body.bin');
    expect(requestFileDetails({ exists: true, size: 2048, contentType: 'image/png' })).toBe('2.0 KB · image/png');
    expect(requestFileDetails({ exists: true, size: 12, contentType: '' })).toBe('12 B');
    expect(requestFileDetails({ exists: false, size: 0, contentType: 'image/png' })).toBe('');
  });

  it('reports the binary Content-Type and suggests the detected one only when no header is set', () => {
    expect(binaryContentType('', 'image/png')).toEqual({ sent: BINARY_DEFAULT_CONTENT_TYPE, fromHeader: false, suggestion: 'image/png' });
    expect(binaryContentType(undefined, '')).toEqual({ sent: BINARY_DEFAULT_CONTENT_TYPE, fromHeader: false, suggestion: '' });
    expect(binaryContentType(undefined, BINARY_DEFAULT_CONTENT_TYPE).suggestion).toBe('');
    expect(binaryContentType(' image/webp ', 'image/png')).toEqual({ sent: 'image/webp', fromHeader: true, suggestion: '' });
  });
});

describe('binary body store helpers', () => {
  function host(rows: KVRow[]) {
    return { reqHeaders: rows, bodyFilePath: '', bodyFileName: '' } as unknown as Parameters<typeof requestBodyFeature.useBinaryContentType>[0] & { reqHeaders: KVRow[]; bodyFilePath: string; bodyFileName: string };
  }

  it('adds a Content-Type header before the trailing empty row', () => {
    const state = host([{ ...mkRow(), enabled: true, key: 'Accept', value: '*/*' }, mkRow()]);
    requestBodyFeature.useBinaryContentType.call(state, 'image/png');
    expect(state.reqHeaders.map(row => [row.key, row.value, row.enabled])).toEqual([['Accept', '*/*', true], ['Content-Type', 'image/png', true], ['', '', true]]);
    expect(requestBodyFeature.binaryContentTypeHeader.call(state)).toBe('image/png');
  });

  it('updates and enables an existing Content-Type header', () => {
    const state = host([{ ...mkRow(), enabled: false, key: 'content-type', value: 'text/plain' }, mkRow()]);
    expect(requestBodyFeature.binaryContentTypeHeader.call(state)).toBe('');
    requestBodyFeature.useBinaryContentType.call(state, 'application/pdf');
    expect(state.reqHeaders).toHaveLength(2);
    expect(state.reqHeaders[0]).toMatchObject({ key: 'content-type', value: 'application/pdf', enabled: true });
  });

  it('keeps the file name in step with the path', () => {
    const state = host([mkRow()]);
    requestBodyFeature.setBinaryFilePath.call(state, 'fixtures/photo.png');
    expect([state.bodyFilePath, state.bodyFileName]).toEqual(['fixtures/photo.png', 'photo.png']);
    requestBodyFeature.setBinaryFilePath.call(state, '');
    expect([state.bodyFilePath, state.bodyFileName]).toEqual(['', '']);
  });
});
