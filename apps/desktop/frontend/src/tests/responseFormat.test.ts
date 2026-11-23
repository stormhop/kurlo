import { describe, expect, it } from 'vitest';
import { detectResponseFormat, fileExtensionForFormat, formatResponseText, renderModeForFormat, resolveResponseFormat, sniffResponseFormat } from '../lib/responseFormat';
import { responseFeature } from '../lib/stores/features/response';
import type { HttpResponse } from '../lib/backend';

const json = '{"id":42,"tags":["a","b"]}';
const xml = '<?xml version="1.0"?><order id="7"><item sku="A1"/></order>';
const html = '<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>';

describe('response format detection', () => {
  it('trusts structured content types', () => {
    expect(detectResponseFormat('application/json; charset=utf-8', 'not json')).toBe('json');
    expect(detectResponseFormat('application/problem+json', json)).toBe('json');
    expect(detectResponseFormat('text/html', html)).toBe('html');
    expect(detectResponseFormat('application/xml', '<feed/>')).toBe('xml');
    expect(detectResponseFormat('application/atom+xml', '<feed/>')).toBe('xml');
  });

  it('sniffs plain text and missing content types', () => {
    expect(detectResponseFormat('text/plain', json)).toBe('json');
    expect(detectResponseFormat('', `\uFEFF  ${json}\n`)).toBe('json');
    expect(detectResponseFormat('text/plain; charset=utf-8', '[1,2,3]')).toBe('json');
    expect(detectResponseFormat('', xml)).toBe('xml');
    expect(detectResponseFormat('text/plain', '<feed><entry/></feed>')).toBe('xml');
    expect(detectResponseFormat('text/plain', html)).toBe('html');
    expect(detectResponseFormat('', '<div><p>Gateway error</p></div>')).toBe('html');
    expect(detectResponseFormat('application/octet-stream', json)).toBe('json');
  });

  it('keeps text that only looks structured', () => {
    expect(sniffResponseFormat('{not json}')).toBe('text');
    expect(sniffResponseFormat('OK: 3 jobs queued')).toBe('text');
    expect(sniffResponseFormat('<b> is bold')).toBe('text');
    expect(sniffResponseFormat('a < b > c')).toBe('text');
    expect(sniffResponseFormat('')).toBe('text');
    expect(sniffResponseFormat('42')).toBe('text');
  });

  it('does not sniff other declared types', () => {
    expect(detectResponseFormat('text/csv', '[1,2]')).toBe('text');
    expect(detectResponseFormat('application/javascript', '{"a":1}')).toBe('text');
  });
});

describe('response format choice', () => {
  it('uses the detected format for auto', () => {
    expect(resolveResponseFormat('text/plain', json, 'auto')).toEqual({ format: 'json', detected: 'json', fallback: false });
  });

  it('forces a format the body parses as', () => {
    expect(resolveResponseFormat('text/plain', '<order><item/></order>', 'html')).toEqual({ format: 'html', detected: 'xml', fallback: false });
    expect(resolveResponseFormat('application/json', json, 'text')).toEqual({ format: 'text', detected: 'json', fallback: false });
  });

  it('falls back to text when the forced format does not parse', () => {
    expect(resolveResponseFormat('text/plain', 'OK', 'json')).toEqual({ format: 'text', detected: 'text', fallback: true });
    expect(resolveResponseFormat('text/plain', '{"a":', 'json').fallback).toBe(true);
    expect(resolveResponseFormat('text/plain', json, 'xml')).toEqual({ format: 'text', detected: 'json', fallback: true });
  });

  it('formats, highlights and names files by format', () => {
    expect(formatResponseText(json, 'json')).toBe('{\n  "id": 42,\n  "tags": [\n    "a",\n    "b"\n  ]\n}');
    expect(formatResponseText('<a><b>1</b></a>', 'xml')).toBe('<a>\n  <b>1</b>\n</a>');
    expect(formatResponseText(json, 'text')).toBe(json);
    expect(renderModeForFormat('xml')).toBe('html');
    expect(renderModeForFormat('text')).toBe('text');
    expect(fileExtensionForFormat('xml')).toBe('xml');
    expect(fileExtensionForFormat('text')).toBe('txt');
  });
});

describe('response feature format', () => {
  function response(body: string, contentType = 'text/plain', size = body.length): HttpResponse {
    return { statusCode: 200, status: '200 OK', headers: contentType ? [{ key: 'Content-Type', value: contentType }] : [], body, duration: 1, size } as HttpResponse;
  }

  function host(resp: HttpResponse) {
    const state = Object.create(responseFeature) as Record<string, unknown> & typeof responseFeature;
    Object.assign(state, {
      response: resp,
      activeRequestId: 'req-1',
      responseFormats: new Map(),
      responseBodyPage: 0,
      responseFilterOpen: false,
      responseFilterQuery: '',
    });
    return state;
  }

  it('formats plain-text JSON and applies the per-request choice', () => {
    const resp = response(json);
    const vm = host(resp);
    expect(vm.responseRenderMode).toBe('json');
    expect(vm.responseDisplayBody).toContain('\n  "id": 42');
    expect(vm.isJsonResponse()).toBe(true);

    vm.setResponseFormat('text');
    expect(vm.responseFormatChoice).toBe('text');
    expect(vm.responseRenderMode).toBe('text');
    expect(vm.responseDisplayBody).toBe(json);
    expect(vm.isJsonResponse()).toBe(false);

    vm.setResponseFormat('auto');
    expect((vm.responseFormats as Map<string, string>).has('req-1')).toBe(false);
    expect(vm.responseDisplayBody).toContain('\n  "id": 42');
  });

  it('applies the choice only to the active response', () => {
    const resp = response(json);
    const vm = host(resp);
    vm.setResponseFormat('text');
    expect(vm.responseRenderModeFor(response(json))).toBe('json');
  });

  it('keeps paged and binary responses as text', () => {
    const paged = host(response(json, 'text/plain', 11 * 1024 * 1024));
    paged.setResponseFormat('json');
    expect(paged.responseFormat).toEqual({ format: 'text', detected: 'text', fallback: false });
    const binary = host({ ...response(json), bodyIsBinary: true } as HttpResponse);
    expect(binary.responseFormat.format).toBe('text');
  });
});
