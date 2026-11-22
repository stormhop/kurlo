import { describe, expect, it } from 'vitest';
import { formatCapturedBody, formatEventStream, indentJsonLoose } from '../lib/captureBody';

describe('captured body formatting', () => {
  it('pretty prints complete JSON', () => {
    expect(formatCapturedBody('{"a":[1,2],"b":{}}', false)).toEqual({ text: '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {}\n}', json: true });
  });

  it('indents JSON cut off in the middle of a string', () => {
    expect(indentJsonLoose('{"flag":{"version":7,"value":true},"name":"a, {b}: [c')).toBe('{\n  "flag": {\n    "version": 7,\n    "value": true\n  },\n  "name": "a, {b}: [c');
  });

  it('keeps escaped quotes and empty containers', () => {
    expect(indentJsonLoose('{"q":"say \\"hi\\", ok","list":[ ],"o":{ }}')).toBe('{\n  "q": "say \\"hi\\", ok",\n  "list": [],\n  "o": {}\n}');
  });

  it('formats JSON in event stream data lines', () => {
    expect(formatEventStream('event:put\ndata:{"a":{"v":1}}\n\ndata: plain text\nid:7')).toBe('event: put\ndata: {\n  "a": {\n    "v": 1\n  }\n}\n\ndata: plain text\nid: 7');
    expect(formatCapturedBody('event:put\ndata:{"a":1}', true).json).toBe(false);
  });

  it('leaves other text alone', () => {
    expect(formatCapturedBody('hello, world: {x}', false)).toEqual({ text: 'hello, world: {x}', json: false });
    expect(formatCapturedBody('<p>{"a":1}</p>', false).json).toBe(false);
  });
});
