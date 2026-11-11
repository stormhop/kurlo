type Selector =
  | { kind: 'name'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'slice'; start: number | null; end: number | null; step: number | null }
  | { kind: 'filter'; expr: FilterExpr };

type Segment = { descendant: boolean; selectors: Selector[] };

type RelPath = { root: '@' | '$'; segments: Segment[] };

type Comparable =
  | { kind: 'literal'; value: unknown }
  | { kind: 'path'; path: RelPath };

type FilterExpr =
  | { kind: 'or'; left: FilterExpr; right: FilterExpr }
  | { kind: 'and'; left: FilterExpr; right: FilterExpr }
  | { kind: 'not'; expr: FilterExpr }
  | { kind: 'exists'; path: RelPath }
  | { kind: 'compare'; op: CompareOp; left: Comparable; right: Comparable };

type CompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

export type JsonFilterQuery = { segments: Segment[]; definite: boolean };

export type JsonFilterResult =
  | { ok: true; matches: unknown[]; definite: boolean; text: string }
  | { ok: false; error: string };

const NAME_START = /[A-Za-z_$\u0080-￿]/;
const NAME_PART = /[A-Za-z0-9_$\-\u0080-￿]/;

class FilterSyntaxError extends Error {}

class Parser {
  private pos = 0;

  constructor(private readonly src: string) {}

  parseQuery(): JsonFilterQuery {
    this.skipSpace();
    if (this.src.trim() === '.') return { segments: [], definite: true };
    if (this.peek() === '$') this.pos += 1;
    else if (this.peek() !== '.' && this.peek() !== '[') {
      throw this.fail('Start the filter with $ or a dot, for example $.items[0] or .items[0]');
    }
    const segments = this.parseSegments(false);
    this.skipSpace();
    if (this.pos < this.src.length) {
      if (this.peek() === '|') throw this.fail('Pipes are not supported; write one path such as .items[].id');
      throw this.fail(`Unexpected "${this.src[this.pos]}"`);
    }
    const definite = segments.every(segment => !segment.descendant
      && segment.selectors.length === 1
      && (segment.selectors[0].kind === 'name' || segment.selectors[0].kind === 'index'));
    return { segments, definite };
  }

  private parseSegments(inFilter: boolean): Segment[] {
    const segments: Segment[] = [];
    for (;;) {
      if (!inFilter) this.skipSpace();
      const ch = this.peek();
      if (ch === '.' && this.src[this.pos + 1] === '.') {
        this.pos += 2;
        if (this.peek() === '[') segments.push({ descendant: true, selectors: this.parseBracket() });
        else segments.push({ descendant: true, selectors: [this.parseDotSelector()] });
      } else if (ch === '.') {
        this.pos += 1;
        if (this.peek() === '[') segments.push({ descendant: false, selectors: this.parseBracket() });
        else segments.push({ descendant: false, selectors: [this.parseDotSelector()] });
      } else if (ch === '[') {
        segments.push({ descendant: false, selectors: this.parseBracket() });
      } else {
        return segments;
      }
    }
  }

  private parseDotSelector(): Selector {
    if (this.peek() === '*') {
      this.pos += 1;
      return { kind: 'wildcard' };
    }
    const ch = this.peek();
    if (ch === '"' || ch === "'") return { kind: 'name', name: this.parseString() };
    if (!ch || !NAME_START.test(ch)) throw this.fail('Expected a field name after the dot');
    const start = this.pos;
    while (this.pos < this.src.length && NAME_PART.test(this.src[this.pos])) this.pos += 1;
    return { kind: 'name', name: this.src.slice(start, this.pos) };
  }

  private parseBracket(): Selector[] {
    this.expect('[');
    this.skipSpace();
    if (this.peek() === ']') {
      this.pos += 1;
      return [{ kind: 'wildcard' }];
    }
    const selectors: Selector[] = [];
    for (;;) {
      this.skipSpace();
      selectors.push(this.parseBracketSelector());
      this.skipSpace();
      if (this.peek() === ',') {
        this.pos += 1;
        continue;
      }
      this.expect(']');
      return selectors;
    }
  }

  private parseBracketSelector(): Selector {
    const ch = this.peek();
    if (ch === '*') {
      this.pos += 1;
      return { kind: 'wildcard' };
    }
    if (ch === '"' || ch === "'") return { kind: 'name', name: this.parseString() };
    if (ch === '?') {
      this.pos += 1;
      this.skipSpace();
      return { kind: 'filter', expr: this.parseOr() };
    }
    if (ch === ':' || ch === '-' || (ch !== undefined && /[0-9]/.test(ch))) return this.parseIndexOrSlice();
    throw this.fail('Expected an index, a quoted name, * or a ?() filter inside []');
  }

  private parseIndexOrSlice(): Selector {
    const parts: Array<number | null> = [];
    let colons = 0;
    for (;;) {
      this.skipSpace();
      parts.push(this.optionalInteger());
      this.skipSpace();
      if (this.peek() === ':' && colons < 2) {
        this.pos += 1;
        colons += 1;
        continue;
      }
      break;
    }
    if (colons === 0) {
      if (parts[0] === null) throw this.fail('Expected an index');
      return { kind: 'index', index: parts[0] };
    }
    const step = parts[2] ?? null;
    if (step === 0) throw this.fail('A slice step cannot be 0');
    return { kind: 'slice', start: parts[0] ?? null, end: parts[1] ?? null, step };
  }

  private optionalInteger(): number | null {
    const match = /^-?\d+/.exec(this.src.slice(this.pos));
    if (!match) return null;
    this.pos += match[0].length;
    return Number(match[0]);
  }

  private parseOr(): FilterExpr {
    let left = this.parseAnd();
    for (;;) {
      this.skipSpace();
      if (!this.src.startsWith('||', this.pos)) return left;
      this.pos += 2;
      left = { kind: 'or', left, right: this.parseAnd() };
    }
  }

  private parseAnd(): FilterExpr {
    let left = this.parseUnary();
    for (;;) {
      this.skipSpace();
      if (!this.src.startsWith('&&', this.pos)) return left;
      this.pos += 2;
      left = { kind: 'and', left, right: this.parseUnary() };
    }
  }

  private parseUnary(): FilterExpr {
    this.skipSpace();
    if (this.peek() === '!' && this.src[this.pos + 1] !== '=') {
      this.pos += 1;
      return { kind: 'not', expr: this.parseUnary() };
    }
    if (this.peek() === '(') {
      this.pos += 1;
      const expr = this.parseOr();
      this.skipSpace();
      this.expect(')');
      return expr;
    }
    const left = this.parseComparable();
    this.skipSpace();
    const op = this.parseCompareOp();
    if (!op) {
      if (left.kind !== 'path') throw this.fail('A value on its own is not a condition; compare it, for example @.price > 10');
      return { kind: 'exists', path: left.path };
    }
    this.skipSpace();
    return { kind: 'compare', op, left, right: this.parseComparable() };
  }

  private parseCompareOp(): CompareOp | null {
    for (const op of ['==', '!=', '<=', '>=', '<', '>'] as const) {
      if (this.src.startsWith(op, this.pos)) {
        this.pos += op.length;
        return op;
      }
    }
    if (this.peek() === '=') throw this.fail('Use == to compare');
    return null;
  }

  private parseComparable(): Comparable {
    this.skipSpace();
    const ch = this.peek();
    if (ch === '@' || ch === '$') {
      this.pos += 1;
      return { kind: 'path', path: { root: ch, segments: this.parseSegments(true) } };
    }
    if (ch === '"' || ch === "'") return { kind: 'literal', value: this.parseString() };
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (number) {
      this.pos += number[0].length;
      return { kind: 'literal', value: Number(number[0]) };
    }
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.src.startsWith(word, this.pos) && !NAME_PART.test(this.src[this.pos + word.length] ?? '')) {
        this.pos += word.length;
        return { kind: 'literal', value };
      }
    }
    throw this.fail('Expected @, a number, a quoted string, true, false or null');
  }

  private parseString(): string {
    const quote = this.src[this.pos];
    this.pos += 1;
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === quote) {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        const next = this.src[this.pos + 1];
        if (next === undefined) break;
        const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"', "'": "'" };
        if (next === 'u') {
          const hex = this.src.slice(this.pos + 2, this.pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.fail('Invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 6;
          continue;
        }
        if (!(next in escapes)) throw this.fail(`Invalid escape \\${next}`);
        out += escapes[next];
        this.pos += 2;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw this.fail('Unclosed quote');
  }

  private skipSpace() {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos += 1;
  }

  private peek(): string | undefined {
    return this.src[this.pos];
  }

  private expect(ch: string) {
    if (this.src[this.pos] !== ch) {
      throw this.fail(this.pos >= this.src.length ? `Missing "${ch}"` : `Expected "${ch}" but found "${this.src[this.pos]}"`);
    }
    this.pos += 1;
  }

  private fail(message: string) {
    return new FilterSyntaxError(`${message} (at character ${Math.min(this.pos, this.src.length) + 1})`);
  }
}

export function parseJsonFilter(query: string): JsonFilterQuery {
  return new Parser(query).parseQuery();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function children(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isObject(value)) return Object.values(value);
  return [];
}

function descendants(value: unknown, out: unknown[]) {
  out.push(value);
  for (const child of children(value)) descendants(child, out);
}

function normalizeIndex(index: number, length: number) {
  return index < 0 ? length + index : index;
}

function sliceIndices(selector: Extract<Selector, { kind: 'slice' }>, length: number): number[] {
  const step = selector.step ?? 1;
  const bound = (value: number) => (value >= 0 ? Math.min(value, length) : Math.max(length + value, step > 0 ? 0 : -1));
  const out: number[] = [];
  if (step > 0) {
    const start = selector.start === null ? 0 : Math.max(bound(selector.start), 0);
    const end = selector.end === null ? length : bound(selector.end);
    for (let i = start; i < end; i += step) out.push(i);
  } else {
    const start = selector.start === null ? length - 1 : Math.min(bound(selector.start), length - 1);
    const end = selector.end === null ? -1 : bound(selector.end);
    for (let i = start; i > end; i += step) out.push(i);
  }
  return out;
}

function applySelector(selector: Selector, value: unknown, root: unknown, out: unknown[]) {
  switch (selector.kind) {
    case 'name':
      if (isObject(value) && Object.prototype.hasOwnProperty.call(value, selector.name)) out.push(value[selector.name]);
      return;
    case 'index':
      if (Array.isArray(value)) {
        const index = normalizeIndex(selector.index, value.length);
        if (index >= 0 && index < value.length) out.push(value[index]);
      }
      return;
    case 'wildcard':
      out.push(...children(value));
      return;
    case 'slice':
      if (Array.isArray(value)) for (const index of sliceIndices(selector, value.length)) out.push(value[index]);
      return;
    case 'filter':
      for (const child of children(value)) if (testFilter(selector.expr, child, root)) out.push(child);
  }
}

function evaluateSegments(segments: Segment[], start: unknown, root: unknown): unknown[] {
  let nodes = [start];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const node of nodes) {
      const targets: unknown[] = [];
      if (segment.descendant) descendants(node, targets);
      else targets.push(node);
      for (const target of targets) for (const selector of segment.selectors) applySelector(selector, target, root, next);
    }
    nodes = next;
  }
  return nodes;
}

const NOTHING = Symbol('nothing');

function comparableValue(comparable: Comparable, current: unknown, root: unknown): unknown {
  if (comparable.kind === 'literal') return comparable.value;
  const nodes = evaluateSegments(comparable.path.segments, comparable.path.root === '@' ? current : root, root);
  return nodes.length === 1 ? nodes[0] : NOTHING;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

function compare(op: CompareOp, a: unknown, b: unknown): boolean {
  if (op === '==') return a === NOTHING || b === NOTHING ? a === b : deepEqual(a, b);
  if (op === '!=') return !compare('==', a, b);
  const comparable = (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string');
  if (!comparable) return op === '<=' || op === '>=' ? compare('==', a, b) : false;
  const x = a as number | string;
  const y = b as number | string;
  if (op === '<') return x < y;
  if (op === '<=') return x <= y;
  if (op === '>') return x > y;
  return x >= y;
}

function testFilter(expr: FilterExpr, current: unknown, root: unknown): boolean {
  switch (expr.kind) {
    case 'or':
      return testFilter(expr.left, current, root) || testFilter(expr.right, current, root);
    case 'and':
      return testFilter(expr.left, current, root) && testFilter(expr.right, current, root);
    case 'not':
      return !testFilter(expr.expr, current, root);
    case 'exists':
      return evaluateSegments(expr.path.segments, expr.path.root === '@' ? current : root, root).length > 0;
    case 'compare':
      return compare(expr.op, comparableValue(expr.left, current, root), comparableValue(expr.right, current, root));
  }
}

export function evaluateJsonFilter(query: JsonFilterQuery, document: unknown): unknown[] {
  return evaluateSegments(query.segments, document, document);
}

const parsedBodies = new Map<string, { ok: true; value: unknown } | { ok: false }>();

function parseBody(body: string): { ok: true; value: unknown } | { ok: false } {
  const cached = parsedBodies.get(body);
  if (cached) return cached;
  let result: { ok: true; value: unknown } | { ok: false };
  try {
    result = { ok: true, value: JSON.parse(body) };
  } catch {
    result = { ok: false };
  }
  parsedBodies.clear();
  parsedBodies.set(body, result);
  return result;
}

export function formatJsonFilterMatches(matches: unknown[], definite: boolean): string {
  if (definite) return matches.length ? JSON.stringify(matches[0], null, 2) : '';
  return JSON.stringify(matches, null, 2);
}

export function applyJsonFilter(body: string, query: string): JsonFilterResult {
  let parsedQuery: JsonFilterQuery;
  try {
    parsedQuery = parseJsonFilter(query.trim());
  } catch (error) {
    return { ok: false, error: error instanceof FilterSyntaxError ? error.message : 'Invalid filter' };
  }
  const document = parseBody(body);
  if (!document.ok) return { ok: false, error: 'The response body is not valid JSON' };
  const matches = evaluateJsonFilter(parsedQuery, document.value);
  return { ok: true, matches, definite: parsedQuery.definite, text: formatJsonFilterMatches(matches, parsedQuery.definite) };
}
