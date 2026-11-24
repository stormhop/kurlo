import type { ResponseRenderMode } from './response-render';
import { prettyJson, prettyMarkup } from './utils';

export type ResponseFormat = 'json' | 'xml' | 'html' | 'text';
export type ResponseFormatChoice = 'auto' | ResponseFormat;

export const RESPONSE_FORMAT_CHOICES: ResponseFormatChoice[] = ['auto', 'json', 'xml', 'html', 'text'];

export const RESPONSE_FORMAT_LABELS: Record<ResponseFormatChoice, string> = {
  auto: 'Auto',
  json: 'JSON',
  xml: 'XML',
  html: 'HTML',
  text: 'Text',
};

const SNIFF_LIMIT_CHARS = 10 * 1024 * 1024;
const HTML_START_RE = /^<!doctype\s+html|^<html[\s>]/i;
const HTML_TAG_RE = /<(head|body|div|p|h[1-6]|center|title|table|span|a|br|hr)[\s>/]/i;
const XML_START_RE = /^<\?xml[\s?]|^<[A-Za-z_][\w.:-]*[\s/>]/;

export function isResponseFormatChoice(value: string): value is ResponseFormatChoice {
  return (RESPONSE_FORMAT_CHOICES as string[]).includes(value);
}

function stripBom(text: string) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function contentTypeFormat(contentType: string): ResponseFormat | null {
  const ct = contentType.toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml')) return 'xml';
  return null;
}

function sniffable(contentType: string) {
  const ct = contentType.toLowerCase().split(';')[0].trim();
  return !ct || ct === 'text/plain' || ct === 'application/octet-stream';
}

function isJsonText(text: string) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function sniffResponseFormat(body: string): ResponseFormat {
  const text = stripBom(body).trim();
  if (!text || text.length > SNIFF_LIMIT_CHARS) return 'text';
  const first = text[0];
  if ((first === '{' || first === '[') && isJsonText(text)) return 'json';
  if (first !== '<' || !text.endsWith('>')) return 'text';
  if (HTML_START_RE.test(text)) return 'html';
  if (XML_START_RE.test(text)) return HTML_TAG_RE.test(text) && !text.startsWith('<?xml') ? 'html' : 'xml';
  return 'text';
}

export function detectResponseFormat(contentType: string, body: string): ResponseFormat {
  const declared = contentTypeFormat(contentType);
  if (declared) return declared;
  return sniffable(contentType) ? sniffResponseFormat(body) : 'text';
}

export type ResolvedResponseFormat = {
  format: ResponseFormat;
  detected: ResponseFormat;
  fallback: boolean;
};

export function resolveResponseFormat(contentType: string, body: string, choice: ResponseFormatChoice): ResolvedResponseFormat {
  const detected = detectResponseFormat(contentType, body);
  if (choice === 'auto' || choice === 'text') return { format: choice === 'auto' ? detected : 'text', detected, fallback: false };
  const text = stripBom(body).trim();
  const parses = choice === 'json' ? isJsonText(text) : text.startsWith('<') && text.endsWith('>');
  return parses ? { format: choice, detected, fallback: false } : { format: 'text', detected, fallback: true };
}

export function renderModeForFormat(format: ResponseFormat): ResponseRenderMode {
  if (format === 'json') return 'json';
  if (format === 'xml' || format === 'html') return 'html';
  return 'text';
}

export function formatResponseText(body: string, format: ResponseFormat): string {
  if (format === 'json') return prettyJson(stripBom(body));
  if (format === 'xml' || format === 'html') return prettyMarkup(stripBom(body));
  return body;
}

export function fileExtensionForFormat(format: ResponseFormat) {
  return format === 'text' ? 'txt' : format;
}
