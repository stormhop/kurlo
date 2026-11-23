import type { ResponseRenderMode } from './response-render';

export type FoldRegion = { start: number; end: number; depth: number };

const MARKUP_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

let cache: { source: string; mode: ResponseRenderMode; regions: Map<number, FoldRegion> } | null = null;

function jsonRegions(lines: string[]) {
  const regions: FoldRegion[] = [];
  const stack: Array<{ line: number; close: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (!text) continue;
    const first = text[0];
    if ((first === '}' || first === ']') && stack.length && stack[stack.length - 1].close === first) {
      const open = stack.pop()!;
      if (i > open.line) regions.push({ start: open.line, end: i, depth: stack.length });
    }
    const last = text[text.length - 1];
    if (last === '{' || last === '[') stack.push({ line: i, close: last === '{' ? '}' : ']' });
  }
  return regions;
}

function markupRegions(lines: string[]) {
  const regions: FoldRegion[] = [];
  const stack: Array<{ line: number; name: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (!text.startsWith('<') || /^<[!?]/.test(text)) continue;
    const closing = text.match(/^<\/\s*([A-Za-z0-9:_.-]+)/);
    if (closing) {
      const name = closing[1].toLowerCase();
      const index = stack.map(entry => entry.name).lastIndexOf(name);
      if (index === -1) continue;
      const open = stack[index];
      stack.length = index;
      if (i > open.line) regions.push({ start: open.line, end: i, depth: stack.length });
      continue;
    }
    const opening = text.match(/^<([A-Za-z][A-Za-z0-9:_.-]*)/);
    if (!opening) continue;
    const name = opening[1].toLowerCase();
    if (/\/>$/.test(text) || MARKUP_VOID_TAGS.has(name)) continue;
    if (new RegExp(`</\\s*${name.replace(/[.]/g, '\\.')}\\s*>\\s*$`, 'i').test(text)) continue;
    stack.push({ line: i, name });
  }
  return regions;
}

export function responseFoldRegions(source: string, mode: ResponseRenderMode): Map<number, FoldRegion> {
  if (cache && cache.source === source && cache.mode === mode) return cache.regions;
  const regions = new Map<number, FoldRegion>();
  if (source && mode !== 'text') {
    const lines = source.split(/\r\n|\r|\n/);
    const found = mode === 'json' ? jsonRegions(lines) : markupRegions(lines);
    for (const region of found) regions.set(region.start, region);
  }
  cache = { source, mode, regions };
  return regions;
}

export function visibleResponseLines(lineCount: number, regions: Map<number, FoldRegion>, folded: ReadonlySet<number>) {
  const visible: number[] = [];
  for (let i = 0; i < lineCount; i += 1) {
    visible.push(i);
    const region = folded.has(i) ? regions.get(i) : undefined;
    if (region) i = region.end;
  }
  return visible;
}

export function foldAllRegions(regions: Map<number, FoldRegion>) {
  const all = new Set<number>();
  for (const region of regions.values()) if (region.depth > 0) all.add(region.start);
  if (!all.size) for (const region of regions.values()) all.add(region.start);
  return all;
}

export function unfoldAround(line: number, regions: Map<number, FoldRegion>, folded: Set<number>): Set<number> {
  let changed = false;
  const next = new Set(folded);
  for (const start of folded) {
    const region = regions.get(start);
    if (region && line > region.start && line <= region.end) {
      next.delete(start);
      changed = true;
    }
  }
  return changed ? next : folded;
}
