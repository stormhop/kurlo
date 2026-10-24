export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'del'; children: MdInline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: MdInline[] }
  | { type: 'image'; src: string; alt: string }
  | { type: 'break' };

export type MdAlign = 'left' | 'center' | 'right' | '';

export type MdBlock =
  | { type: 'heading'; level: number; children: MdInline[] }
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { type: 'quote'; children: MdBlock[] }
  | { type: 'table'; align: MdAlign[]; head: MdInline[][]; rows: MdInline[][][] }
  | { type: 'hr' };

export type MdListItem = { checked: boolean | null; children: MdBlock[] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const EMPTY_LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]*$/;
const TABLE_DIVIDER = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function safeMarkdownURL(raw: string, allowImageData = false): string {
  const url = raw.trim().replace(/^<(.*)>$/, '$1');
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (allowImageData && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(url)) return url;
  return '';
}

export function parseMarkdown(source: string): MdBlock[] {
  return parseBlocks(String(source ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}

function isBlank(line: string) {
  return !line.trim();
}

function startsBlock(line: string, next: string | undefined) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line)
    || (line.includes('|') && next !== undefined && TABLE_DIVIDER.test(next) && next.includes('-'));
}

function parseBlocks(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const indent = line.length - line.trimStart().length;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i].slice(Math.min(indent, lines[i].length - lines[i].trimStart().length)));
        i++;
      }
      i++;
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const quoted = QUOTE.exec(lines[i]);
        if (!quoted && startsBlock(lines[i], lines[i + 1])) break;
        body.push(quoted ? quoted[1] : lines[i]);
        i++;
      }
      blocks.push({ type: 'quote', children: parseBlocks(body) });
      continue;
    }

    if (LIST_ITEM.test(line) || EMPTY_LIST_ITEM.test(line)) {
      const parsed = parseList(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(cell => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        return (left && right ? 'center' : right ? 'right' : left ? 'left' : '') as MdAlign;
      });
      i += 2;
      const rows: MdInline[][][] = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        const cells = splitRow(lines[i]);
        rows.push(head.map((_, index) => parseInline(cells[index] ?? '')));
        i++;
      }
      blocks.push({ type: 'table', align: head.map((_, index) => align[index] ?? ''), head: head.map(cell => parseInline(cell)), rows });
      continue;
    }

    const body: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && (!body.length || !startsBlock(lines[i], lines[i + 1]))) {
      body.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', children: parseInline(body.join('\n')) });
  }
  return blocks;
}

function parseList(lines: string[], start: number): { block: MdBlock; next: number } {
  const first = LIST_ITEM.exec(lines[start]) ?? EMPTY_LIST_ITEM.exec(lines[start]);
  const ordered = /\d/.test(first?.[2] ?? '');
  const startNumber = ordered ? parseInt(first?.[2] ?? '1', 10) : 1;
  const items: MdListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]) ?? EMPTY_LIST_ITEM.exec(lines[i]);
    if (!match || /\d/.test(match[2]) !== ordered) break;
    const contentIndent = match[1].length + match[2].length + 1;
    const body: string[] = [match[3] ?? ''];
    i++;
    let sawBlank = false;
    while (i < lines.length) {
      const current = lines[i];
      if (isBlank(current)) {
        sawBlank = true;
        body.push('');
        i++;
        continue;
      }
      const indent = current.length - current.trimStart().length;
      if (indent >= Math.min(contentIndent, 4)) {
        body.push(current.slice(Math.min(indent, contentIndent)));
        sawBlank = false;
        i++;
        continue;
      }
      if (!sawBlank && !LIST_ITEM.test(current) && !EMPTY_LIST_ITEM.test(current) && !startsBlock(current, lines[i + 1])) {
        body.push(current.trim());
        i++;
        continue;
      }
      break;
    }
    while (body.length && isBlank(body[body.length - 1])) body.pop();
    let checked: boolean | null = null;
    const task = /^\[([ xX])\][ \t]+/.exec(body[0] ?? '');
    if (task) {
      checked = task[1] !== ' ';
      body[0] = body[0].slice(task[0].length);
    }
    items.push({ checked, children: parseBlocks(body) });
    if (sawBlank && i < lines.length && !LIST_ITEM.test(lines[i])) break;
  }
  return { block: { type: 'list', ordered, start: startNumber, items }, next: i };
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let index = 0; index < row.length; index++) {
    const char = row[index];
    if (char === '\\' && row[index + 1] === '|') {
      current += '|';
      index++;
    } else if (char === '`') {
      inCode = !inCode;
      current += char;
    } else if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) out.push({ type: 'text', text: buffer });
    buffer = '';
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i];

    if (char === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(text[i + 1])) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }

    if (char === '\n') {
      const hard = / {2,}$/.test(buffer) || buffer.endsWith('\\');
      buffer = buffer.replace(/ +$/, '').replace(/\\$/, '');
      if (hard) {
        flush();
        out.push({ type: 'break' });
      } else {
        buffer += ' ';
      }
      i++;
      continue;
    }

    if (char === '`') {
      const run = /^`+/.exec(text.slice(i))![0];
      const end = text.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        const code = text.slice(i + run.length, end).replace(/\n/g, ' ');
        out.push({ type: 'code', text: code.length > 2 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code });
        i = end + run.length;
        continue;
      }
      buffer += run;
      i += run.length;
      continue;
    }

    if (char === '!' && text[i + 1] === '[') {
      const link = readLink(text, i + 1);
      if (link) {
        const src = safeMarkdownURL(link.href, true);
        flush();
        if (src) out.push({ type: 'image', src, alt: link.label });
        else out.push({ type: 'text', text: link.label });
        i = link.end;
        continue;
      }
    }

    if (char === '[') {
      const link = readLink(text, i);
      if (link) {
        const href = safeMarkdownURL(link.href);
        flush();
        const children = parseInline(link.label);
        if (href) out.push({ type: 'link', href, children });
        else out.push(...children);
        i = link.end;
        continue;
      }
    }

    if (char === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(text.slice(i));
      if (auto) {
        flush();
        out.push({ type: 'link', href: auto[1], children: [{ type: 'text', text: auto[1].replace(/^mailto:/i, '') }] });
        i += auto[0].length;
        continue;
      }
    }

    if ((char === 'h' || char === 'H') && (i === 0 || /[\s(]/.test(text[i - 1]))) {
      const bare = /^https?:\/\/[^\s<>]+/i.exec(text.slice(i));
      if (bare) {
        const url = bare[0].replace(/[.,;:!?)\]'"]+$/, '');
        flush();
        out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
        i += url.length;
        continue;
      }
    }

    if (char === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: 'del', children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      const emphasis = readEmphasis(text, i);
      if (emphasis) {
        flush();
        out.push(emphasis.node);
        i = emphasis.end;
        continue;
      }
    }

    buffer += char;
    i++;
  }
  flush();
  return out;
}

function readLink(text: string, open: number): { label: string; href: string; end: number } | null {
  let depth = 0;
  let close = -1;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '`') {
      const end = text.indexOf('`', index + 1);
      if (end > 0) index = end;
      continue;
    }
    if (char === '[') depth++;
    if (char === ']') {
      depth--;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0 || text[close + 1] !== '(') return null;
  let parens = 0;
  for (let index = close + 1; index < text.length; index++) {
    const char = text[index];
    if (char === '\n') return null;
    if (char === '(') parens++;
    if (char === ')') {
      parens--;
      if (parens === 0) {
        const inside = text.slice(close + 2, index).trim();
        const href = inside.replace(/\s+(".*"|'.*')$/, '');
        return { label: text.slice(open + 1, close), href, end: index + 1 };
      }
    }
  }
  return null;
}

function readEmphasis(text: string, start: number): { node: MdInline; end: number } | null {
  const char = text[start];
  const run = text.slice(start).match(char === '*' ? /^\*+/ : /^_+/)![0];
  const size = Math.min(run.length, 3);
  const after = text[start + size];
  if (!after || /\s/.test(after)) return null;
  if (char === '_' && start > 0 && /[\p{L}\p{N}]/u.test(text[start - 1])) return null;
  for (const length of size === 3 ? [3, 2, 1] : [size]) {
    const marker = char.repeat(length);
    let search = start + length;
    while (search < text.length) {
      const end = text.indexOf(marker, search);
      if (end < 0) break;
      const before = text[end - 1];
      const next = text[end + length];
      const closesWord = char !== '_' || !next || !/[\p{L}\p{N}]/u.test(next);
      if (end > start + length && before && !/\s/.test(before) && closesWord && text[end + length] !== char) {
        const inner = text.slice(start + length, end);
        const children = parseInline(inner);
        const node: MdInline = length === 3
          ? { type: 'strong', children: [{ type: 'em', children }] }
          : length === 2 ? { type: 'strong', children } : { type: 'em', children };
        return { node, end: end + length };
      }
      search = end + length;
    }
  }
  return null;
}
