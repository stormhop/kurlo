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
const MAX_INLINE_DEPTH = 64;

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
  return parseInlineContent(text, 0);
}

function parseInlineContent(text: string, depth: number): MdInline[] {
  if (depth >= MAX_INLINE_DEPTH) return [{ type: 'text', text }];
  const out: MdInline[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) out.push({ type: 'text', text: buffer });
    buffer = '';
  };
  let links: ReturnType<typeof indexLinkDelimiters> | undefined;
  let backticks: ReturnType<typeof indexBackticks> | undefined;
  const emphasisEnds = new Map<string, Int32Array>();
  let emphasisRunEnd = 0;
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
      backticks ??= indexBackticks(text);
      const run = text.slice(i, i + backticks.runs[i]);
      const next = i + run.length;
      const end = backticks.longest[next] >= run.length ? text.indexOf(run, next) : -1;
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
      const link = readLink(text, i + 1, links ??= indexLinkDelimiters(text));
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
      const link = readLink(text, i, links ??= indexLinkDelimiters(text));
      if (link) {
        const href = safeMarkdownURL(link.href);
        flush();
        const children = parseInlineContent(link.label, depth + 1);
        if (href) out.push({ type: 'link', href, children });
        else out.push(...children);
        i = link.end;
        continue;
      }
    }

    if (char === '<') {
      const auto = /^<(?:https?:\/\/|mailto:)/i.test(text.slice(i, i + 9))
        ? /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(text.slice(i))
        : null;
      if (auto) {
        flush();
        out.push({ type: 'link', href: auto[1], children: [{ type: 'text', text: auto[1].replace(/^mailto:/i, '') }] });
        i += auto[0].length;
        continue;
      }
    }

    if ((char === 'h' || char === 'H') && (i === 0 || /[\s(]/.test(text[i - 1]))) {
      const bare = /^https?:\/\//i.test(text.slice(i, i + 8))
        ? /^https?:\/\/[^\s<>]+/i.exec(text.slice(i))
        : null;
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
        out.push({ type: 'del', children: parseInlineContent(text.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      if (i >= emphasisRunEnd) {
        emphasisRunEnd = i + 1;
        while (text[emphasisRunEnd] === char) emphasisRunEnd++;
      }
      if (emphasisRunEnd === text.length) {
        buffer += text.slice(i);
        break;
      }
      const emphasis = readEmphasis(text, i, emphasisRunEnd, emphasisEnds);
      if (emphasis) {
        flush();
        const { length, end } = emphasis;
        const children = parseInlineContent(text.slice(i + length, end), depth + 1);
        const node: MdInline = length === 3
          ? { type: 'strong', children: [{ type: 'em', children }] }
          : length === 2 ? { type: 'strong', children } : { type: 'em', children };
        out.push(node);
        i = end + length;
        continue;
      }
    }

    buffer += char;
    i++;
  }
  flush();
  return out;
}

function indexBackticks(text: string) {
  const runs = new Uint32Array(text.length + 1);
  const longest = new Uint32Array(text.length + 1);
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === '`') runs[i] = runs[i + 1] + 1;
    longest[i] = Math.max(runs[i], longest[i + 1]);
  }
  return { runs, longest };
}

function indexLinkDelimiters(text: string) {
  const brackets = new Int32Array(text.length + 1);
  const parens = new Int32Array(text.length + 1);
  brackets[text.length] = parens[text.length] = -1;
  let nextBacktick = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    const char = text[i];
    brackets[i] = brackets[i + 1];
    if (char === ']') brackets[i] = i;
    else if (char === '[') {
      const close = brackets[i + 1];
      brackets[i] = close < 0 ? -1 : brackets[close + 1];
    } else if (char === '\\') {
      brackets[i] = brackets[Math.min(i + 2, text.length)];
    } else if (char === '`') {
      if (nextBacktick >= 0) brackets[i] = brackets[nextBacktick + 1];
      nextBacktick = i;
    }

    parens[i] = parens[i + 1];
    if (char === ')') parens[i] = i;
    else if (char === '(') {
      const close = parens[i + 1];
      parens[i] = close < 0 ? -1 : parens[close + 1];
    } else if (char === '\n') {
      parens[i] = -1;
    }
  }
  return { brackets, parens };
}

function readLink(text: string, open: number, { brackets, parens }: ReturnType<typeof indexLinkDelimiters>) {
  const close = brackets[open + 1];
  if (close < 0 || text[close + 1] !== '(') return null;
  const end = parens[close + 2];
  if (end < 0) return null;
  const inside = text.slice(close + 2, end).trim();
  const href = stripLinkTitle(inside);
  return { label: text.slice(open + 1, close), href, end: end + 1 };
}

function stripLinkTitle(text: string): string {
  const quote = text.at(-1);
  if (quote !== '"' && quote !== "'") return text;
  let title = -1;
  for (let i = text.length - 2; i > 0 && !/[\r\n\u2028\u2029]/.test(text[i]); i--) {
    if (text[i] === quote && /\s/.test(text[i - 1])) title = i;
  }
  return title < 0 ? text : text.slice(0, title).trimEnd();
}

function indexEmphasisEnds(text: string, marker: string) {
  const ends = new Int32Array(text.length + 1).fill(-1);
  const char = marker[0];
  for (let i = text.length - 1; i >= 0; i--) {
    if (!text.startsWith(marker, i)) {
      ends[i] = ends[i + 1];
      continue;
    }
    const next = text[i + marker.length];
    const closesWord = char !== '_' || !next || !/[\p{L}\p{N}]/u.test(next);
    ends[i] = i > 0 && !/\s/.test(text[i - 1]) && closesWord && next !== char
      ? i : ends[i + marker.length];
  }
  return ends;
}

function readEmphasis(text: string, start: number, runEnd: number, endsByMarker: Map<string, Int32Array>) {
  const char = text[start];
  const size = Math.min(runEnd - start, 3);
  const after = text[start + size];
  if (!after || /\s/.test(after)) return null;
  if (char === '_' && start > 0 && /[\p{L}\p{N}]/u.test(text[start - 1])) return null;
  for (const length of size === 3 ? [3, 2, 1] : [size]) {
    const marker = char.repeat(length);
    let ends = endsByMarker.get(marker);
    if (!ends) {
      ends = indexEmphasisEnds(text, marker);
      endsByMarker.set(marker, ends);
    }
    const search = start + length;
    let end = ends[text.startsWith(marker, search) ? search + length : search];
    if (end >= 0 && end < runEnd) end = ends[runEnd];
    if (end >= 0) return { length, end };
  }
  return null;
}
