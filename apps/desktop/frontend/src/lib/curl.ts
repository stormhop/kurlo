import { methodConventionallyHasNoBody, RAW_BODY_CONTENT_TYPES } from './constants';
import { applyPathParams } from './pathParams';

function splitCurlFormValue(raw: string): { value: string; contentType: string } {
  const match = /;type=([^;]+)$/i.exec(raw);
  if (!match) return { value: raw, contentType: '' };
  return { value: raw.slice(0, match.index), contentType: match[1].trim() };
}

type CurlRow = { key: string; value: string; enabled: boolean; isFile?: boolean; fileName?: string; contentType?: string };
type CurlAuth = {
  type: string;
  token?: string;
  username?: string;
  password?: string;
  keyName?: string;
  keyValue?: string;
  keyIn?: string;
  awsAccessKey?: string;
  awsSecretKey?: string;
  awsSessionToken?: string;
  awsRegion?: string;
  awsService?: string;
};

type CurlRequest = {
  method: string;
  url: string;
  params: CurlRow[];
  pathParams?: CurlRow[];
  headers: CurlRow[];
  auth: CurlAuth;
  bodyType: string;
  body: string;
  bodyFilePath?: string;
  formData: CurlRow[];
};

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function toCurl(req: CurlRequest): string {
  const parts: string[] = ['curl'];

  if (req.method !== 'GET') {
    parts.push(`-X ${req.method}`);
  }

  let urlStr = applyPathParams(req.url, req.pathParams);
  const activeParams = req.params.filter(p => p.enabled && p.key);
  if (req.auth.type === 'apikey' && req.auth.keyIn === 'query' && req.auth.keyName) {
    activeParams.push({ key: req.auth.keyName, value: req.auth.keyValue ?? '', enabled: true });
  }
  if (activeParams.length) {
    const sep = urlStr.includes('?') ? '&' : '?';
    urlStr += sep + activeParams.map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
  }
  parts.push(shellQuote(urlStr));

  switch (req.auth.type) {
    case 'bearer':
    case 'oauth2':
      if (req.auth.token) parts.push(`-H ${shellQuote(`Authorization: Bearer ${req.auth.token}`)}`);
      break;
    case 'basic':
      parts.push(`-u ${shellQuote(`${req.auth.username}:${req.auth.password}`)}`);
      break;
    case 'digest':
      parts.push('--digest', `-u ${shellQuote(`${req.auth.username ?? ''}:${req.auth.password ?? ''}`)}`);
      break;
    case 'aws':
      parts.push(`--aws-sigv4 ${shellQuote(`aws:amz:${req.auth.awsRegion ?? ''}:${req.auth.awsService ?? ''}`)}`);
      parts.push(`-u ${shellQuote(`${req.auth.awsAccessKey ?? ''}:${req.auth.awsSecretKey ?? ''}`)}`);
      if (req.auth.awsSessionToken) parts.push(`-H ${shellQuote(`x-amz-security-token: ${req.auth.awsSessionToken}`)}`);
      break;
    case 'apikey':
      if (req.auth.keyIn === 'header' && req.auth.keyName) {
        parts.push(`-H ${shellQuote(`${req.auth.keyName}: ${req.auth.keyValue}`)}`);
      }
      break;
  }

  for (const h of req.headers) {
    if (h.enabled && h.key) {
      parts.push(`-H ${shellQuote(`${h.key}: ${h.value}`)}`);
    }
  }

  switch (req.bodyType) {
    case 'json':
    case 'text':
    case 'xml':
    case 'html':
    case 'javascript':
    case 'graphql': {
      const rawContentType = RAW_BODY_CONTENT_TYPES[req.bodyType];
      const hasOwnContentType = req.headers.some(h => h.enabled && h.key.toLowerCase() === 'content-type');
      const carriesBody = Boolean(req.body) || !methodConventionallyHasNoBody(req.method);
      if (!carriesBody) break;
      if (rawContentType && !hasOwnContentType) {
        parts.push(`-H ${shellQuote(`Content-Type: ${rawContentType}`)}`);
      }
      parts.push(`--data-raw ${shellQuote(req.body)}`);
      break;
    }
    case 'urlencoded': {
      const fields = req.formData.filter(r => r.enabled && r.key);
      for (const f of fields) {
        parts.push(`--data-urlencode ${shellQuote(`${f.key}=${f.value}`)}`);
      }
      break;
    }
    case 'form': {
      for (const f of req.formData) {
        if (f.enabled && f.key) {
          const suffix = f.contentType ? `;type=${f.contentType}` : '';
          if (f.isFile) {
            parts.push(`-F ${shellQuote(`${f.key}=@${f.value}${suffix}`)}`);
          } else {
            parts.push(`-F ${shellQuote(`${f.key}=${f.value}${suffix}`)}`);
          }
        }
      }
      break;
    }
    case 'binary':
      if (req.bodyFilePath) {
        parts.push(`--data-binary ${shellQuote(`@${req.bodyFilePath}`)}`);
      }
      break;
  }

  return parts.join(' \\\n  ');
}

export type ParsedCurl = Partial<{
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  body: string;
  bodyFilePath: string;
  bodyType: string;
  formData: { key: string; value: string; isFile: boolean; contentType?: string }[];
  username: string;
  password: string;
  followRedirects: boolean;
  insecure: boolean;
  timeoutMs: number;
  proxyUrl: string;
}>;

export function parseCurl(input: string): ParsedCurl {
  const raw = normalizeCurlInput(input);
  const tokens = tokenise(raw);
  if (!tokens.length || !/^curl(?:\.exe)?$/i.test(tokens[0])) return {};

  const result: ParsedCurl = { method: 'GET', headers: [], formData: [] };
  const getQueryParts: string[] = [];
  let explicitMethod = false;
  let useGet = false;
  let sentAsForm = false;
  let sentAsJson = false;

  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    const request = readOptionValue(tokens, i, ['-X', '--request']);
    const header = readOptionValue(tokens, i, ['-H', '--header']);
    const url = readOptionValue(tokens, i, ['--url']);
    const cookie = readOptionValue(tokens, i, ['-b', '--cookie']);
    const data = readOptionValue(tokens, i, ['-d', '--data', '--data-ascii', '--data-raw']);
    const json = readOptionValue(tokens, i, ['--json']);
    const dataBinary = readOptionValue(tokens, i, ['--data-binary']);
    const dataUrlencode = readOptionValue(tokens, i, ['--data-urlencode']);
    const form = readOptionValue(tokens, i, ['-F', '--form']);
    const formString = readOptionValue(tokens, i, ['--form-string']);
    const user = readOptionValue(tokens, i, ['-u', '--user']);
    const userAgent = readOptionValue(tokens, i, ['-A', '--user-agent']);
    const referer = readOptionValue(tokens, i, ['-e', '--referer']);
    const maxTime = readOptionValue(tokens, i, ['-m', '--max-time']);
    const proxy = readOptionValue(tokens, i, ['-x', '--proxy']);
    const ignored = readOptionValue(tokens, i, IGNORED_VALUE_FLAGS);

    if (request) {
      result.method = request.value.toUpperCase() || 'GET';
      explicitMethod = Boolean(request.value);
      i = request.index;
    } else if (header) {
      const raw = header.value;
      const colon = raw.indexOf(':');
      if (colon > 0) {
        result.headers!.push({ key: raw.slice(0, colon).trim(), value: raw.slice(colon + 1).trim() });
      }
      i = header.index;
    } else if (url) {
      if (url.value) result.url = cleanUrlToken(url.value);
      i = url.index;
    } else if (cookie) {
      if (looksLikeCookieHeader(cookie.value)) {
        const existing = result.headers!.find(h => h.key.toLowerCase() === 'cookie');
        if (existing) existing.value = `${existing.value}; ${cookie.value.trim()}`;
        else result.headers!.push({ key: 'Cookie', value: cookie.value.trim() });
      }
      i = cookie.index;
    } else if (data) {
      if (data.value.startsWith('@') && result.body === undefined && data.value.length > 1) {
        result.bodyType = 'binary';
        result.bodyFilePath = data.value.slice(1);
      } else {
        result.body = [result.body, data.value].filter(Boolean).join('&');
        result.bodyType = result.bodyType === 'binary' ? 'text' : result.bodyType ?? 'text';
        if (data.value) getQueryParts.push(data.value);
      }
      sentAsForm = true;
      if (!explicitMethod && (!result.method || result.method === 'GET')) result.method = 'POST';
      i = data.index;
    } else if (json) {
      if (json.value.startsWith('@') && result.body === undefined && json.value.length > 1) {
        result.bodyType = 'binary';
        result.bodyFilePath = json.value.slice(1);
      } else {
        result.body = (result.body ?? '') + json.value;
        result.bodyType = 'json';
      }
      sentAsJson = true;
      if (!explicitMethod && (!result.method || result.method === 'GET')) result.method = 'POST';
      i = json.index;
    } else if (dataBinary) {
      const v = dataBinary.value;
      if (v.startsWith('@')) {
        result.bodyType = 'binary';
        result.bodyFilePath = v.slice(1);
      } else {
        result.body = v;
        result.bodyType = 'text';
      }
      if (!explicitMethod && (!result.method || result.method === 'GET')) result.method = 'POST';
      i = dataBinary.index;
    } else if (dataUrlencode) {
      const row = parseDataUrlencode(dataUrlencode.value);
      if (row) {
        result.formData!.push(row);
      } else {
        result.body = [result.body, dataUrlencode.value].filter(Boolean).join('&');
      }
      if (dataUrlencode.value && !dataUrlencode.value.startsWith('@')) getQueryParts.push(dataUrlencode.value);
      result.bodyType = 'urlencoded';
      if (!explicitMethod && (!result.method || result.method === 'GET')) result.method = 'POST';
      i = dataUrlencode.index;
    } else if (form || formString) {
      const raw = (form ?? formString)!.value;
      const eq = raw.indexOf('=');
      if (eq > 0) {
        const key = raw.slice(0, eq);
        const { value: val, contentType } = splitCurlFormValue(raw.slice(eq + 1));
        const isFile = Boolean(form) && val.startsWith('@');
        result.formData!.push({ key, value: isFile ? val.slice(1) : val, isFile, ...(contentType ? { contentType } : {}) });
      }
      result.bodyType = 'form';
      if (!explicitMethod && (!result.method || result.method === 'GET')) result.method = 'POST';
      i = (form ?? formString)!.index;
    } else if (user) {
      const colon = user.value.indexOf(':');
      result.username = colon >= 0 ? user.value.slice(0, colon) : user.value;
      result.password = colon >= 0 ? user.value.slice(colon + 1) : '';
      i = user.index;
    } else if (userAgent) {
      if (userAgent.value) result.headers!.push({ key: 'User-Agent', value: userAgent.value });
      i = userAgent.index;
    } else if (referer) {
      if (referer.value) result.headers!.push({ key: 'Referer', value: referer.value });
      i = referer.index;
    } else if (maxTime) {
      const seconds = Number(maxTime.value);
      if (Number.isFinite(seconds) && seconds > 0) result.timeoutMs = Math.round(seconds * 1000);
      i = maxTime.index;
    } else if (proxy) {
      if (proxy.value) result.proxyUrl = proxy.value;
      i = proxy.index;
    } else if (t === '-L' || t === '--location' || t === '--location-trusted') {
      result.followRedirects = true;
    } else if (t === '-k' || t === '--insecure') {
      result.insecure = true;
    } else if (t === '-G' || t === '--get') {
      useGet = true;
    } else if (t === '-I' || t === '--head') {
      result.method = 'HEAD';
      explicitMethod = true;
    } else if (ignored) {
      i = ignored.index;
    } else if (!t.startsWith('-')) {
      setUrlCandidate(result, t);
    }
    i++;
  }

  if (useGet && getQueryParts.length && result.url) {
    result.url = appendQueryParts(result.url, getQueryParts);
    delete result.body;
    delete result.bodyType;
    result.formData = [];
    if (!explicitMethod) result.method = 'GET';
  }

  const hasHeader = (name: string) => result.headers!.some(h => h.key.toLowerCase() === name);
  if (sentAsJson) {
    if (!hasHeader('content-type')) result.headers!.push({ key: 'Content-Type', value: 'application/json' });
    if (!hasHeader('accept')) result.headers!.push({ key: 'Accept', value: 'application/json' });
  } else if (sentAsForm && result.bodyType === 'text' && !hasHeader('content-type')) {
    if (looksUrlencoded(result.body ?? '')) result.bodyType = 'urlencoded';
    else result.headers!.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' });
  }

  if (result.body && result.bodyType === 'text') {
    const ct = result.headers?.find(h => h.key.toLowerCase() === 'content-type')?.value ?? '';
    if (ct.includes('application/json')) result.bodyType = 'json';
    else if (ct.includes('application/javascript') || ct.includes('text/javascript')) result.bodyType = 'text';
    else if (ct.includes('application/xml') || ct.includes('text/xml')) result.bodyType = 'xml';
    else if (ct.includes('text/html')) result.bodyType = 'html';
    else if (ct.includes('application/x-www-form-urlencoded') && looksUrlencoded(result.body)) result.bodyType = 'urlencoded';
  }

  return result;
}

function looksUrlencoded(body: string) {
  if (!body || /[\s{}[\]"<>]/.test(body)) return false;
  return body.split('&').every(part => /^[^=&]+=[^=]*$/.test(part));
}

const IGNORED_VALUE_FLAGS = [
  '-c',
  '-D',
  '-E',
  '-o',
  '--cacert',
  '--capath',
  '--cert',
  '--cert-type',
  '--connect-timeout',
  '--connect-to',
  '--cookie-jar',
  '--dump-header',
  '--interface',
  '--key',
  '--key-type',
  '--limit-rate',
  '--local-port',
  '--output',
  '--output-dir',
  '--pass',
  '--proxy-user',
  '--request-target',
  '--resolve',
  '--retry',
  '--retry-delay',
  '--retry-max-time',
];

function normalizeCurlInput(input: string): string {
  return input
    .replace(/\\\r?\n\s*/g, ' ')
    .replace(/\^\s*\r?\n\s*/g, ' ')
    .replace(/`\s*\r?\n\s*/g, ' ')
    .trim();
}

function readOptionValue(tokens: string[], index: number, flags: string[]): { value: string; index: number } | null {
  const token = tokens[index];
  for (const flag of flags) {
    if (token === flag) {
      return tokens[index + 1] === undefined
        ? { value: '', index }
        : { value: tokens[index + 1], index: index + 1 };
    }
    if (flag.startsWith('--') && token.startsWith(`${flag}=`)) {
      return { value: token.slice(flag.length + 1), index };
    }
    if (/^-[A-Za-z]$/.test(flag) && token.startsWith(flag) && token.length > flag.length) {
      return { value: token.slice(flag.length), index };
    }
  }
  return null;
}

function cleanUrlToken(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

function looksLikeUrl(value: string): boolean {
  const clean = cleanUrlToken(value).trim();
  return /^[a-z][a-z\d+.-]*:\/\//i.test(clean)
    || /^localhost(?::|\/|$)/i.test(clean)
    || /^127(?:\.\d{1,3}){3}(?::|\/|$)/.test(clean)
    || /^\[[^\]]+\](?::|\/|$)/.test(clean)
    || /^[^\s/]+\.[^\s]+/.test(clean)
    || clean.startsWith('/')
    || clean.startsWith('{{');
}

function setUrlCandidate(result: ParsedCurl, value: string) {
  const clean = cleanUrlToken(value);
  if (!result.url || !looksLikeUrl(result.url)) {
    result.url = clean;
  }
}

function appendQueryParts(url: string, parts: string[]): string {
  const cleanParts = parts.map(part => part.trim()).filter(Boolean);
  if (!cleanParts.length) return url;
  const hashIndex = url.indexOf('#');
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const separator = base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?';
  return `${base}${separator}${cleanParts.join('&')}${hash}`;
}

function looksLikeCookieHeader(value: string): boolean {
  return value.trim().includes('=');
}

function parseDataUrlencode(value: string): { key: string; value: string; isFile: boolean } | null {
  const eq = value.indexOf('=');
  if (eq > 0) {
    return { key: value.slice(0, eq), value: value.slice(eq + 1), isFile: false };
  }
  const at = value.indexOf('@');
  if (at > 0) {
    return { key: value.slice(0, at), value: value.slice(at + 1), isFile: false };
  }
  return null;
}

const ANSI_C_ESCAPES: Record<string, string> = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  '\\': '\\', "'": "'", '"': '"', '?': '?',
};

function readAnsiCQuoted(input: string, start: number): { value: string; next: number } {
  let value = '';
  let i = start;
  while (i < input.length && input[i] !== "'") {
    if (input[i] !== '\\' || i + 1 >= input.length) {
      value += input[i];
      i++;
      continue;
    }
    const next = input[i + 1];
    if (next in ANSI_C_ESCAPES) {
      value += ANSI_C_ESCAPES[next];
      i += 2;
      continue;
    }
    const hex = next === 'x' ? /^[0-9a-fA-F]{1,2}/.exec(input.slice(i + 2)) : null;
    const unicode = next === 'u' ? /^[0-9a-fA-F]{1,4}/.exec(input.slice(i + 2)) : next === 'U' ? /^[0-9a-fA-F]{1,8}/.exec(input.slice(i + 2)) : null;
    const octal = /^[0-7]{1,3}/.exec(input.slice(i + 1));
    if (hex || unicode) {
      const digits = (hex ?? unicode)![0];
      value += String.fromCodePoint(Number.parseInt(digits, 16));
      i += 2 + digits.length;
    } else if (octal) {
      value += String.fromCharCode(Number.parseInt(octal[0], 8));
      i += 1 + octal[0].length;
    } else {
      value += `\\${next}`;
      i += 2;
    }
  }
  return { value, next: i < input.length ? i + 1 : i };
}

function tokenise(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  let token = '';
  let inToken = false;
  const push = () => {
    if (inToken) tokens.push(token);
    token = '';
    inToken = false;
  };
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      push();
      i++;
      continue;
    }
    inToken = true;
    if (ch === '$' && input[i + 1] === "'") {
      const quoted = readAnsiCQuoted(input, i + 2);
      token += quoted.value;
      i = quoted.next;
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < input.length && input[i] !== "'") {
        token += input[i];
        i++;
      }
      if (input[i] === "'") i++;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          i++;
          token += input[i];
        } else {
          token += input[i];
        }
        i++;
      }
      if (input[i] === '"') i++;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      token += input[i + 1];
      i += 2;
      continue;
    }
    token += ch;
    i++;
  }
  push();
  return tokens;
}
