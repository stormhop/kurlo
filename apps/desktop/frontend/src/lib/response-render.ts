import type { ResponseLine } from './types/models';
import { escapeHtml } from './utils';

export type ResponseRenderMode = 'json' | 'html' | 'text';

type CountMatchesOptions = {
  chunkSize?: number;
  shouldContinue?: () => boolean;
};

const DEFAULT_MATCH_CHUNK_SIZE = 256 * 1024;
const RESPONSE_DOM_NODE_BUDGET = 2_500;
const RESPONSE_LONG_LINE_CHARS = 4_096;
const RESPONSE_TEXT_CHARS_PER_COST_UNIT = 256;
const JSON_TOKEN_RE = /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;

function countMatchesChunk(source: string, needle: string, start: number, end: number) {
  const scanEnd = Math.min(source.length, end + needle.length - 1);
  const haystack = source.slice(start, scanEnd).toLowerCase();
  let count = 0;
  let pos = 0;
  let nextStart = end;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1 || start + idx >= end) return { count, nextStart };
    count += 1;
    nextStart = start + idx + needle.length;
    pos = idx + needle.length;
  }
}

export function countMatches(source: string, query: string, options: CountMatchesOptions = {}) {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  let count = 0;
  const chunkSize = Math.max(needle.length, options.chunkSize ?? DEFAULT_MATCH_CHUNK_SIZE);
  for (let start = 0; start < source.length;) {
    if (options.shouldContinue && !options.shouldContinue()) return count;
    const chunk = countMatchesChunk(source, needle, start, Math.min(source.length, start + chunkSize));
    count += chunk.count;
    start = Math.max(chunk.nextStart, start + chunkSize);
  }
  return count;
}

export async function countMatchesAsync(source: string, query: string, options: CountMatchesOptions = {}) {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const chunkSize = Math.max(needle.length, options.chunkSize ?? DEFAULT_MATCH_CHUNK_SIZE);
  let count = 0;
  let start = 0;

  return new Promise<number>((resolve) => {
    const step = () => {
      if (options.shouldContinue && !options.shouldContinue()) {
        resolve(count);
        return;
      }
      const end = Math.min(source.length, start + chunkSize);
      const chunk = countMatchesChunk(source, needle, start, end);
      count += chunk.count;
      start = Math.max(chunk.nextStart, end);
      if (start >= source.length) {
        resolve(count);
      } else {
        globalThis.setTimeout(step, 0);
      }
    };
    globalThis.setTimeout(step, 0);
  });
}

function jsonTokenClass(token: string) {
  if (/^"/.test(token)) return /:$/.test(token) ? 'jk' : 'js';
  if (/^(true|false)$/.test(token)) return 'jb';
  if (token === 'null') return 'jnull';
  return 'jn';
}

function normalizeRenderMode(mode: ResponseRenderMode | boolean): ResponseRenderMode {
  if (mode === true) return 'json';
  if (mode === false) return 'text';
  return mode;
}

type SearchMarks = { ranges: Array<{ start: number; end: number; index: number }>; currentIndex: number };

function lineSearchMarks(line: string, query: string, counter: { value: number }, currentIndex: number): SearchMarks {
  const needle = query.trim().toLowerCase();
  const ranges: SearchMarks['ranges'] = [];
  if (needle) {
    const lower = line.toLowerCase();
    let pos = 0;
    while (true) {
      const idx = lower.indexOf(needle, pos);
      if (idx === -1) break;
      ranges.push({ start: idx, end: idx + needle.length, index: counter.value });
      counter.value += 1;
      pos = idx + needle.length;
    }
  }
  return { ranges, currentIndex };
}

function markSegment(text: string, offset: number, marks: SearchMarks) {
  const end = offset + text.length;
  let html = '';
  let pos = 0;
  for (const range of marks.ranges) {
    if (range.end <= offset + pos) continue;
    if (range.start >= end) break;
    const from = Math.max(range.start, offset) - offset;
    const to = Math.min(range.end, end) - offset;
    if (from > pos) html += escapeHtml(text.slice(pos, from));
    html += `<mark class="rsp-search-hit${range.index === marks.currentIndex ? ' rsp-search-current' : ''}">${escapeHtml(text.slice(from, to))}</mark>`;
    pos = to;
  }
  if (pos < text.length) html += escapeHtml(text.slice(pos));
  return html;
}

function renderJsonLine(line: string, marks: SearchMarks) {
  JSON_TOKEN_RE.lastIndex = 0;
  let html = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = JSON_TOKEN_RE.exec(line)) !== null) {
    if (match.index > last) html += markSegment(line.slice(last, match.index), last, marks);
    const token = match[0];
    html += `<span class="${jsonTokenClass(token)}">${markSegment(token, match.index, marks)}</span>`;
    last = match.index + token.length;
  }
  if (last < line.length) html += markSegment(line.slice(last), last, marks);
  return html || '&nbsp;';
}

function renderHtmlTag(token: string, offset: number, marks: SearchMarks) {
  if (/^<!--/.test(token) || /^<!\[CDATA\[/.test(token)) {
    return `<span class="hc">${markSegment(token, offset, marks)}</span>`;
  }
  if (/^<!/.test(token) || /^<\?/.test(token)) {
    return `<span class="hm">${markSegment(token, offset, marks)}</span>`;
  }

  const partRE = /(\s+|<\/?|\/?>|=|"[^"]*"|'[^']*'|[^\s=<>"']+)/g;
  let html = '';
  let last = 0;
  let match: RegExpExecArray | null;
  let tagNamePending = false;
  let tagNameSeen = false;
  let valuePending = false;

  while ((match = partRE.exec(token)) !== null) {
    if (match.index > last) html += markSegment(token.slice(last, match.index), offset + last, marks);
    const part = match[0];
    let className: string;

    if (/^\s+$/.test(part)) {
      html += markSegment(part, offset + match.index, marks);
      last = match.index + part.length;
      continue;
    }
    if (part === '<' || part === '</') {
      className = 'ht';
      tagNamePending = true;
    } else if (part === '>' || part === '/>' || part === '=') {
      className = 'ht';
      if (part === '=') valuePending = true;
    } else if (/^["']/.test(part) || valuePending) {
      className = 'js';
      valuePending = false;
    } else if (tagNamePending && !tagNameSeen) {
      className = 'hn';
      tagNamePending = false;
      tagNameSeen = true;
    } else {
      className = 'ha';
    }

    html += `<span class="${className}">${markSegment(part, offset + match.index, marks)}</span>`;
    last = match.index + part.length;
  }

  if (last < token.length) html += markSegment(token.slice(last), offset + last, marks);
  return html || markSegment(token, offset, marks);
}

function renderHtmlLine(line: string, marks: SearchMarks) {
  const tagRE = /(<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z][^>]*>|<![^>]*>|<\?[^>]*\?>)/g;
  let html = '';
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRE.exec(line)) !== null) {
    if (match.index > last) html += markSegment(line.slice(last, match.index), last, marks);
    html += renderHtmlTag(match[0], match.index, marks);
    last = match.index + match[0].length;
  }

  if (last < line.length) html += markSegment(line.slice(last), last, marks);
  return html || '&nbsp;';
}

export function shouldVirtualizeResponseBody(source: string, mode: ResponseRenderMode) {
  if (!source) return false;

  let estimatedNodes = 3 + Math.ceil(source.length / RESPONSE_TEXT_CHARS_PER_COST_UNIT);
  let currentLineLength = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charCodeAt(i);
    if (ch === 10 || ch === 13) {
      if (ch === 13 && source.charCodeAt(i + 1) === 10) i += 1;
      estimatedNodes += 3;
      currentLineLength = 0;
      if (estimatedNodes >= RESPONSE_DOM_NODE_BUDGET) return true;
    } else {
      currentLineLength += 1;
      if (currentLineLength >= RESPONSE_LONG_LINE_CHARS) return true;
    }
  }

  if (mode === 'json') {
    JSON_TOKEN_RE.lastIndex = 0;
    while (JSON_TOKEN_RE.exec(source)) {
      estimatedNodes += 1;
      if (estimatedNodes >= RESPONSE_DOM_NODE_BUDGET) return true;
    }
  } else if (mode === 'html') {
    for (let i = 0; i < source.length; i += 1) {
      if (source.charCodeAt(i) !== 60) continue;
      estimatedNodes += 3;
      if (estimatedNodes >= RESPONSE_DOM_NODE_BUDGET) return true;
    }
  }

  return false;
}

export function countLineMatches(line: string, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const source = line.toLowerCase();
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = source.indexOf(needle, pos);
    if (idx === -1) return count;
    count += 1;
    pos = idx + needle.length;
  }
}

export function buildResponseMatchOffsets(lines: string[], query: string) {
  if (!query.trim()) return [0];
  const offsets = new Array<number>(lines.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < lines.length; i += 1) {
    offsets[i + 1] = offsets[i] + countLineMatches(lines[i], query);
  }
  return offsets;
}

export function responseMatchLine(offsets: number[], matchIndex: number) {
  if (offsets.length < 2 || matchIndex < 0 || matchIndex >= offsets[offsets.length - 1]) return -1;
  let low = 0;
  let high = offsets.length - 1;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid] <= matchIndex) low = mid;
    else high = mid;
  }
  return low;
}

export function renderResponseBodyLine(
  line: string,
  number: number,
  mode: ResponseRenderMode | boolean,
  query: string,
  counter: { value: number },
  currentIndex: number,
): ResponseLine {
  const before = counter.value;
  const renderMode = normalizeRenderMode(mode);
  const marks = lineSearchMarks(line, query, counter, currentIndex);
  const html = renderMode === 'json'
    ? renderJsonLine(line, marks)
    : renderMode === 'html'
      ? renderHtmlLine(line, marks)
      : (markSegment(line, 0, marks) || '&nbsp;');
  return {
    number,
    html,
    hasCurrentMatch: counter.value > before && currentIndex >= before && currentIndex < counter.value,
  };
}

export function renderResponseBodyLines(source: string, mode: ResponseRenderMode | boolean, query: string, currentIndex: number): ResponseLine[] {
  const lines = source.split(/\r\n|\r|\n/);
  const counter = { value: 0 };
  return (lines.length ? lines : ['']).map((line, idx) => (
    renderResponseBodyLine(line, idx + 1, mode, query, counter, currentIndex)
  ));
}
