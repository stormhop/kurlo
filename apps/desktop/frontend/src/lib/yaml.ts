type YamlLine = {
  indent: number;
  text: string;
  raw: string;
};

function stripComment(raw: string) {
  let quote = '';
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
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
    if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
  }
  return raw;
}

function preprocess(source: string): YamlLine[] {
  return source
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/)
    .map(raw => {
      const withoutComment = stripComment(raw).replace(/\t/g, '  ');
      const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
      return { indent, text: withoutComment.trim(), raw: withoutComment };
    })
    .filter(line => line.text && line.text !== '---' && line.text !== '...');
}

function unquote(value: string) {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const body = text.slice(1, -1);
    if (text[0] === '"') {
      return body
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\');
    }
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
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function collectBlockScalar(lines: YamlLine[], index: number, parentIndent: number, folded: boolean): [string, number] {
  const collected: string[] = [];
  let minIndent = Number.POSITIVE_INFINITY;
  let cursor = index;
  while (cursor < lines.length && lines[cursor].indent > parentIndent) {
    minIndent = Math.min(minIndent, lines[cursor].indent);
    cursor += 1;
  }
  cursor = index;
  while (cursor < lines.length && lines[cursor].indent > parentIndent) {
    collected.push(lines[cursor].raw.slice(Number.isFinite(minIndent) ? minIndent : lines[cursor].indent));
    cursor += 1;
  }
  return [folded ? collected.map(line => line.trim()).join(' ') : collected.join('\n'), cursor];
}

function parseBlock(lines: YamlLine[], index: number, minIndent: number): [unknown, number] {
  if (index >= lines.length || lines[index].indent < minIndent) return [{}, index];
  const indent = lines[index].indent;
  if (lines[index].text.startsWith('- ')) return parseSequence(lines, index, indent);
  return parseMap(lines, index, indent);
}

function parseMap(lines: YamlLine[], index: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  const merged: Record<string, unknown>[] = [];
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent < indent || line.text.startsWith('- ')) break;
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
      [value, cursor] = parseBlock(lines, cursor + 1, indent + 1);
    } else if (rest === '|' || rest === '|-' || rest === '|+') {
      [value, cursor] = collectBlockScalar(lines, cursor + 1, indent, false);
    } else if (rest === '>' || rest === '>-' || rest === '>+') {
      [value, cursor] = collectBlockScalar(lines, cursor + 1, indent, true);
    } else {
      value = parseScalar(rest);
      cursor += 1;
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
    if (line.indent < indent || line.indent > indent || !line.text.startsWith('- ')) break;
    const [anchor, rest] = takeAnchor(line.text.slice(2).trim());
    if (!rest) {
      const [value, next] = parseBlock(lines, cursor + 1, indent + 1);
      out.push(remember(anchor, value));
      cursor = next;
      continue;
    }
    if (rest === '|' || rest === '|-' || rest === '|+') {
      const [value, next] = collectBlockScalar(lines, cursor + 1, indent, false);
      out.push(remember(anchor, value));
      cursor = next;
      continue;
    }
    if (rest === '>' || rest === '>-' || rest === '>+') {
      const [value, next] = collectBlockScalar(lines, cursor + 1, indent, true);
      out.push(remember(anchor, value));
      cursor = next;
      continue;
    }

    const pair = splitKeyValue(rest);
    if (!pair) {
      out.push(remember(anchor, parseScalar(rest)));
      cursor += 1;
      continue;
    }

    let item: Record<string, unknown> = {};
    const [extra, next] = parseBlock(lines, cursor + 1, indent + 1);
    const extraMap = extra && typeof extra === 'object' && !Array.isArray(extra) ? extra as Record<string, unknown> : {};
    const [valueAnchor, valueText] = takeAnchor(pair[1]);
    const value = valueText ? remember(valueAnchor, parseScalar(valueText)) : remember(valueAnchor, extra);
    if (pair[0] === '<<') {
      item = Object.assign({}, ...mergeSources(value).reverse(), valueText ? extraMap : {});
    } else if (valueText) {
      Object.assign(item, extraMap, { [pair[0]]: value });
    } else {
      item[pair[0]] = value;
    }
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
