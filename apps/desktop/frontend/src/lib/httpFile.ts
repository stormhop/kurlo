
import type { KVRow, Method, RawBodyType, RequestTab, SavedRequest } from './types/models';
import { DEFAULT_REQUEST_SETTINGS, mkRow } from './constants';
import { emptyAuthState, newRequestId } from './utils';
import { serializeGraphQLPayload } from './graphql';
import { isWebSocketUrl, socketIOImportDetails } from './importDetection';
import { filesystemNameFromName } from './normalizers';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT']);
const REALTIME_METHODS = new Set(['WEBSOCKET', 'WS', 'GRPC', 'GRAPHQL']);

export type HttpFileVariable = { key: string; value: string };

export type HttpFileImport = {
  requests: SavedRequest[];
  variables: HttpFileVariable[];
};

function row(key: string, value: string): KVRow {
  return { ...mkRow(), key, value, enabled: true };
}

function isSeparator(line: string) {
  return /^\s*###/.test(line);
}

function separatorLabel(line: string) {
  return line.replace(/^\s*#+/, '').trim();
}

function isComment(line: string) {
  return /^\s*(#|\/\/)/.test(line);
}

function fileVariable(line: string): HttpFileVariable | null {
  const match = line.match(/^\s*@([A-Za-z0-9_.-]+)\s*(?:=|\s)\s*(.*)$/);
  if (!match) return null;
  return { key: match[1], value: match[2].trim() };
}

function directive(line: string): { key: string; value: string } | null {
  const match = line.match(/^\s*(?:#+|\/\/)\s*@([A-Za-z0-9_.-]+)\s*(?:=|\s)?\s*(.*)$/);
  if (!match) return null;
  return { key: match[1].toLowerCase(), value: match[2].trim() };
}

function rawTypeFromContentType(value: string): RawBodyType {
  const lower = value.toLowerCase();
  if (lower.includes('json')) return 'json';
  if (lower.includes('xml')) return 'xml';
  if (lower.includes('html')) return 'html';
  return 'text';
}

type RequestLine = { method: string; url: string };

function parseRequestLine(line: string): RequestLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  const head = parts[0].toUpperCase();
  if (METHODS.has(head) || REALTIME_METHODS.has(head)) {
    const rest = parts.slice(1);
    if (rest.length > 1 && /^HTTP\/[\d.]+$/i.test(rest[rest.length - 1])) rest.pop();
    return { method: head, url: rest.join(' ').trim() };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('{{') || trimmed.startsWith('/')) {
    const rest = [...parts];
    if (rest.length > 1 && /^HTTP\/[\d.]+$/i.test(rest[rest.length - 1])) rest.pop();
    return { method: 'GET', url: rest.join(' ').trim() };
  }
  return null;
}

function splitBlocks(text: string): Array<{ label: string; lines: string[] }> {
  const blocks: Array<{ label: string; lines: string[] }> = [];
  let current = { label: '', lines: [] as string[] };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (isSeparator(line)) {
      blocks.push(current);
      current = { label: separatorLabel(line), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  blocks.push(current);
  return blocks;
}

function nameFromUrl(method: string, url: string): string {
  const withoutQuery = url.split('?')[0];
  const path = withoutQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  const tail = path.split('/').filter(Boolean).pop();
  return tail ? `${method} /${tail}` : `${method} ${withoutQuery || 'request'}`;
}

type ParsedBlock = {
  name: string;
  method: string;
  url: string;
  headers: KVRow[];
  body: string;
  preRequestScripts: string[];
  responseScripts: string[];
  notes: string[];
};

function dedent(lines: string[]): string {
  const filled = lines.filter(line => line.trim());
  const indent = filled.length ? Math.min(...filled.map(line => line.match(/^\s*/)?.[0].length ?? 0)) : 0;
  return lines.map(line => line.slice(Math.min(indent, line.match(/^\s*/)?.[0].length ?? 0))).join('\n').trim();
}

function readInlineScript(lines: string[], start: number, prefix: RegExp): { code: string; next: number } | null {
  const opening = lines[start].trim().match(prefix);
  if (!opening) return null;
  const first = lines[start].trim().slice(opening[0].length);
  const closeOnFirst = first.indexOf('%}');
  if (closeOnFirst >= 0) return { code: first.slice(0, closeOnFirst).trim(), next: start + 1 };
  const code: string[] = first.trim() ? [first] : [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const closeAt = lines[index].indexOf('%}');
    if (closeAt >= 0) {
      const tail = lines[index].slice(0, closeAt);
      if (tail.trim()) code.push(tail);
      return { code: dedent(code), next: index + 1 };
    }
    code.push(lines[index]);
  }
  return { code: dedent(code), next: lines.length };
}

const PRE_SCRIPT = /^<\s*\{%/;
const RESPONSE_SCRIPT = /^>\s*\{%/;

function parseBlock(lines: string[], label: string, variables: HttpFileVariable[]): ParsedBlock | null {
  let name = label;
  const notes: string[] = [];
  const preRequestScripts: string[] = [];
  const responseScripts: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) { index += 1; continue; }
    const script = readInlineScript(lines, index, PRE_SCRIPT);
    if (script) {
      if (script.code) preRequestScripts.push(script.code);
      index = script.next;
      continue;
    }
    if (/^<\s+\S/.test(trimmed)) {
      notes.push(`The pre-request script ${trimmed.replace(/^<\s*/, '')} was a separate file in the source .http file and was not imported.`);
      index += 1;
      continue;
    }
    const variable = fileVariable(line);
    if (variable) {
      variables.push(variable);
      index += 1;
      continue;
    }
    if (isComment(line)) {
      const found = directive(line);
      if (found?.key === 'name' && found.value) name = found.value;
      index += 1;
      continue;
    }
    break;
  }

  const requestLine = index < lines.length ? parseRequestLine(lines[index]) : null;
  if (!requestLine) return null;
  index += 1;

  let url = requestLine.url;
  while (index < lines.length && /^\s+[?&]/.test(lines[index])) {
    url += lines[index].trim();
    index += 1;
  }

  const headers: KVRow[] = [];
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) { index += 1; break; }
    if (isComment(line)) continue;
    const separatorAt = line.indexOf(':');
    if (separatorAt <= 0) break;
    headers.push(row(line.slice(0, separatorAt).trim(), line.slice(separatorAt + 1).trim()));
  }

  const bodyLines: string[] = [];
  let bodyEnded = false;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    const script = readInlineScript(lines, index, RESPONSE_SCRIPT);
    if (script) {
      if (script.code) responseScripts.push(script.code);
      bodyEnded = true;
      index = script.next;
      continue;
    }
    if (/^>>!?\s*\S/.test(trimmed)) {
      notes.push(`Response was written to ${trimmed.replace(/^>>!?\s*/, '')} in the source .http file.`);
      bodyEnded = true;
    } else if (/^<>\s*\S/.test(trimmed)) {
      bodyEnded = true;
    } else if (/^>\s+\S/.test(trimmed)) {
      notes.push(`The response handler ${trimmed.replace(/^>\s*/, '')} was a separate file in the source .http file and was not imported.`);
      bodyEnded = true;
    } else if (/^<\s+\S/.test(trimmed) && !bodyEnded) {
      notes.push(`Body was loaded from ${trimmed.replace(/^<\s*/, '')} in the source .http file.`);
    } else if (!bodyEnded) {
      bodyLines.push(line);
    }
    index += 1;
  }

  return {
    name: name || nameFromUrl(requestLine.method, url),
    method: requestLine.method,
    url,
    headers,
    body: bodyLines.join('\n').trim(),
    preRequestScripts,
    responseScripts,
    notes,
  };
}

export function httpFileCollectionName(fileName: string): string {
  return fileName.replace(/\.(http|rest)$/i, '') || 'HTTP File';
}

export function parseHttpFile(text: string, collectionId: string, collectionName: string): HttpFileImport {
  const variables: HttpFileVariable[] = [];
  const requests: SavedRequest[] = [];

  for (const block of splitBlocks(text)) {
    const parsed = parseBlock(block.lines, block.label, variables);
    if (!parsed || !parsed.url) continue;

    const contentType = parsed.headers.find(header => header.key.toLowerCase() === 'content-type')?.value ?? '';
    const requestTypeHeader = parsed.headers.find(header => header.key.toLowerCase() === 'x-request-type')?.value ?? '';

    const socketIO = socketIOImportDetails(parsed.url);
    const isGraphQL = parsed.method === 'GRAPHQL'
      || requestTypeHeader.toLowerCase() === 'graphql'
      || contentType.toLowerCase().includes('graphql');
    const isWebSocket = parsed.method === 'WEBSOCKET' || parsed.method === 'WS' || isWebSocketUrl(parsed.url);

    const requestType = isGraphQL ? 'graphql' : socketIO ? 'socketio' : isWebSocket ? 'ws' : 'http';
    const method = (requestType === 'graphql' ? 'POST' : METHODS.has(parsed.method) ? parsed.method : 'GET') as Method;

    const rawBodyType = rawTypeFromContentType(contentType);
    let bodyType: SavedRequest['bodyType'] = 'none';
    let bodyContent = '';
    if (isGraphQL) {
      bodyType = 'graphql';
      bodyContent = serializeGraphQLPayload({ query: parsed.body, variables: '{}', operationName: '' });
    } else if (parsed.body) {
      bodyType = rawBodyType;
      bodyContent = parsed.body;
    }

    let requestTab: RequestTab = 'params';
    if (requestType === 'socketio') requestTab = 'events';
    else if (requestType === 'ws') requestTab = 'body';
    else if (requestType === 'graphql') requestTab = 'query';
    else if (bodyType !== 'none') requestTab = 'body';
    else if (parsed.headers.length) requestTab = 'headers';

    const id = newRequestId();
    const name = parsed.name || nameFromUrl(method, parsed.url);
    requests.push({
      id,
      name,
      filesystemName: filesystemNameFromName(name, id),
      collectionId,
      collection: collectionName,
      folderPath: [],
      requestType,
      method,
      url: socketIO?.url ?? parsed.url,
      requestTab,
      params: [],
      headers: parsed.headers,
      auth: emptyAuthState(),
      bodyType,
      rawBodyType,
      bodyContent,
      bodyFilePath: '',
      bodyFileName: '',
      formRows: [],
      preRequestScript: parsed.preRequestScripts.join('\n\n'),
      testScript: parsed.responseScripts.join('\n\n'),
      requestNotes: parsed.notes.join('\n'),
      settings: { ...DEFAULT_REQUEST_SETTINGS, ...(socketIO?.settings ?? {}) },
    });
  }

  if (!requests.length) throw new Error('No requests found in the .http file');

  const deduped = new Map<string, string>();
  for (const variable of variables) deduped.set(variable.key, variable.value);

  return { requests, variables: [...deduped].map(([key, value]) => ({ key, value })) };
}
