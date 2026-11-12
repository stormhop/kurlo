type YamlLine = {
  indent: number;
  text: string;
  raw: string;
  blank?: boolean;
};

type QuoteScan = {
  quote: string;
  escaped: boolean;
  comment: number;
};

const BLOCK_HEADER = /^[|>][-+0-9]*$/;
const BLOCK_HEADER_LINE = /^(?:-\s+)*(?:[^\s].*?:\s+)?(?:&\S+\s+)?[|>][-+0-9]*$/;

function opensQuote(line: string, index: number) {
  const before = line.slice(0, index).trimEnd();
  return !before || ':-[{,?'.includes(before[before.length - 1]);
}

function scanQuotes(raw: string, openQuote: string): QuoteScan {
  let quote = openQuote;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === '\\' && quote === '"') escaped = true;
      else if (ch === quote) {
        if (quote === "'" && raw[i + 1] === "'") i += 1;
        else quote = '';
      }
      continue;
    }
    if ((ch === '"' || ch === "'") && opensQuote(raw, i)) {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return { quote, escaped, comment: i };
  }
  return { quote, escaped, comment: raw.length };
}

function leadingSpaces(raw: string) {
  return raw.match(/^ */)?.[0].length ?? 0;
}

function joinQuoted(rows: string[], start: number, first: string, firstScan: QuoteScan): [string, number] | null {
  let text = first.slice(0, firstScan.comment);
  let scan = firstScan;
  let cursor = start;
  while (scan.quote) {
    let breaks = 0;
    cursor += 1;
    while (cursor < rows.length && !rows[cursor].trim()) {
      breaks += 1;
      cursor += 1;
    }
    if (cursor >= rows.length) return null;
    const next = rows[cursor].replace(/^[ \t]+/, '');
    const separator = breaks ? '\n'.repeat(breaks) : ' ';
    text = scan.escaped ? text.slice(0, -1) + (breaks ? separator : '') : text.trimEnd() + separator;
    scan = scanQuotes(next, scan.quote);
    text += next.slice(0, scan.comment);
  }
  return [text, cursor];
}

function preprocess(source: string): YamlLine[] {
  const rows = source.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const out: YamlLine[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const first = rows[i].replace(/\t/g, '  ');
    const indent = leadingSpaces(first);
    const scan = scanQuotes(first, '');
    let raw = first.slice(0, scan.comment);
    if (scan.quote) {
      const joined = joinQuoted(rows, i, first, scan);
      if (joined) [raw, i] = joined;
      else raw = stripUnclosed(first);
    }
    const text = raw.trim();
    if (!text || text === '---' || text === '...') continue;
    out.push({ indent, text, raw });
    if (!BLOCK_HEADER_LINE.test(text)) continue;
    while (i + 1 < rows.length) {
      const row = rows[i + 1];
      if (row.trim() && leadingSpaces(row) <= indent) break;
      i += 1;
      out.push(row.trim()
        ? { indent: leadingSpaces(row), text: row.trim(), raw: row }
        : { indent: Number.POSITIVE_INFINITY, text: '', raw: '', blank: true });
    }
  }
  return out;
}

function stripUnclosed(raw: string) {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
      const quotes = raw.slice(0, i).replace(/\\./g, '').match(/"/g)?.length ?? 0;
      if (quotes % 2 === 0) return raw.slice(0, i);
    }
  }
  return raw;
}

const ESCAPES: Record<string, string> = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
};

function unescapeDoubleQuoted(body: string) {
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (match, code: string) =>
    code.length > 1 ? String.fromCodePoint(parseInt(code.slice(1), 16)) : ESCAPES[code] ?? match);
}

function unquote(value: string) {
  const text = value.trim();
  if (text.length > 1 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    const body = text.slice(1, -1);
    if (text[0] === '"') return unescapeDoubleQuoted(body);
    return body.replace(/''/g, "'");
  }
  return text;
}

function splitTopLevel(source: string, delimiter: string) {
  const parts: string[] = [];
  let quote = '';
  let escaped = false;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === '\\' && quote === '"') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === delimiter && depth === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function splitKeyValue(text: string): [string, string] | null {
  let quote = '';
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === '\\' && quote === '"') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ':' && depth === 0 && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
      return [unquote(text.slice(0, i)), text.slice(i + 1).trim()];
    }
  }
  return null;
}

function parseFlowObject(source: string) {
  const body = source.slice(1, -1).trim();
  const out: Record<string, unknown> = {};
  for (const part of splitTopLevel(body, ',')) {
    const pair = splitKeyValue(part);
    if (pair) out[pair[0]] = parseScalar(pair[1]);
  }
  return out;
}

function parseFlowArray(source: string) {
  const body = source.slice(1, -1).trim();
  return splitTopLevel(body, ',').map(parseScalar);
}

let anchors = new Map<string, unknown>();

const ANCHOR_PATTERN = /^&([^\s,[\]{}]+)(?:\s+|$)/;
const ALIAS_PATTERN = /^\*([^\s,[\]{}]+)$/;

function takeAnchor(rest: string): [string, string] {
  const match = ANCHOR_PATTERN.exec(rest);
  return match ? [match[1], rest.slice(match[0].length).trim()] : ['', rest];
}

function resolveAlias(name: string): unknown {
  if (!anchors.has(name)) throw new Error(`YAML alias *${name} refers to an unknown anchor`);
  const value = anchors.get(name);
  return value && typeof value === 'object' ? structuredClone(value) : value;
}

function remember<T>(anchor: string, value: T): T {
  if (anchor) anchors.set(anchor, value);
  return value;
}

function mergeSources(value: unknown): Record<string, unknown>[] {
  const sources = Array.isArray(value) ? value : [value];
  return sources.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (!text) return '';
  const alias = ALIAS_PATTERN.exec(text);
  if (alias) return resolveAlias(alias[1]);
  if (text === 'null' || text === 'Null' || text === '~') return null;
  if (text === 'true' || text === 'True') return true;
  if (text === 'false' || text === 'False') return false;
  if (text.startsWith('{') && text.endsWith('}')) return parseFlowObject(text);
  if (text.startsWith('[') && text.endsWith(']')) return parseFlowArray(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return unquote(text);
  if (/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(text)) return Number(text);
  return text;
}

function collectBlockScalar(lines: YamlLine[], index: number, parentIndent: number, folded: boolean): [string, number] {
  let minIndent = Number.POSITIVE_INFINITY;
  let cursor = index;
  while (cursor < lines.length && lines[cursor].indent > parentIndent) {
    minIndent = Math.min(minIndent, lines[cursor].indent);
    cursor += 1;
  }
  const collected = lines.slice(index, cursor).map(line => (line.blank ? '' : line.raw.slice(minIndent)));
  while (collected.length && !collected[collected.length - 1]) collected.pop();
  if (!folded) return [collected.join('\n'), cursor];
  let text = '';
  let breaks = 0;
  for (const line of collected) {
    if (!line.trim()) {
      breaks += 1;
      continue;
    }
    if (text) text += breaks ? '\n'.repeat(breaks) : ' ';
    text += line.trim();
    breaks = 0;
  }
  return [text, cursor];
}

function collectPlainScalar(lines: YamlLine[], index: number, indent: number, first: string): [unknown, number] {
  let text = first;
  let cursor = index;
  while (cursor < lines.length && lines[cursor].indent > indent && !lines[cursor].blank) {
    text += ` ${lines[cursor].text}`;
    cursor += 1;
  }
  return [parseScalar(text), cursor];
}

function isDash(text: string) {
  return text === '-' || text.startsWith('- ');
}

function parseBlock(lines: YamlLine[], index: number, minIndent: number): [unknown, number] {
  if (index >= lines.length || lines[index].indent < minIndent) return [{}, index];
  const indent = lines[index].indent;
  if (isDash(lines[index].text)) return parseSequence(lines, index, indent);
  return parseMap(lines, index, indent);
}

function parseMap(lines: YamlLine[], index: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  const merged: Record<string, unknown>[] = [];
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent < indent || isDash(line.text)) break;
    if (line.indent > indent) {
      cursor += 1;
      continue;
    }
    const pair = splitKeyValue(line.text);
    if (!pair) {
      cursor += 1;
      continue;
    }
    const [key, restWithAnchor] = pair;
    const [anchor, rest] = takeAnchor(restWithAnchor);
    let value: unknown;
    if (!rest) {
      const next = lines[cursor + 1];
      [value, cursor] = next && next.indent === indent && isDash(next.text)
        ? parseSequence(lines, cursor + 1, indent)
        : parseBlock(lines, cursor + 1, indent + 1);
    } else if (BLOCK_HEADER.test(rest)) {
      [value, cursor] = collectBlockScalar(lines, cursor + 1, indent, rest[0] === '>');
    } else {
      [value, cursor] = collectPlainScalar(lines, cursor + 1, indent, rest);
    }
    remember(anchor, value);
    if (key === '<<') merged.push(...mergeSources(value));
    else out[key] = value;
  }
  return [merged.length ? Object.assign({}, ...merged.reverse(), out) : out, cursor];
}

function parseSequence(lines: YamlLine[], index: number, indent: number): [unknown[], number] {
  const out: unknown[] = [];
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent < indent || line.indent > indent || !isDash(line.text)) break;
    const [anchor, rest] = takeAnchor(line.text.slice(2).trim());
    if (!rest) {
      const [value, next] = parseBlock(lines, cursor + 1, indent + 1);
      out.push(remember(anchor, value));
      cursor = next;
      continue;
    }
    if (BLOCK_HEADER.test(rest)) {
      const [value, next] = collectBlockScalar(lines, cursor + 1, indent, rest[0] === '>');
      out.push(remember(anchor, value));
      cursor = next;
      continue;
    }

    const nested = isDash(rest);
    if (!nested && !splitKeyValue(rest)) {
      const [value, next] = collectPlainScalar(lines, cursor + 1, indent, rest);
      out.push(remember(anchor, value));
      cursor = next;
      continue;
    }

    const itemIndent = indent + line.text.length - line.text.slice(1).trimStart().length;
    lines[cursor] = { indent: itemIndent, text: rest, raw: `${' '.repeat(itemIndent)}${rest}` };
    const [item, next] = nested ? parseSequence(lines, cursor, itemIndent) : parseMap(lines, cursor, itemIndent);
    lines[cursor] = line;
    out.push(remember(anchor, item));
    cursor = next;
  }
  return [out, cursor];
}

export function parseYaml(source: string): unknown {
  const lines = preprocess(source);
  if (!lines.length) return {};
  anchors = new Map();
  try {
    const [value] = parseBlock(lines, 0, 0);
    return value;
  } finally {
    anchors = new Map();
  }
}
