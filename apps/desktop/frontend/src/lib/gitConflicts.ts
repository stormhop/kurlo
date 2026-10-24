export type ConflictSide = 'ours' | 'theirs';

export type GitConflictHunk = {
  index: number;
  startLine: number;
  endLine: number;
  marker: string;
  ours: string[];
  theirs: string[];
  base: string[];
  raw: string[];
};

export type GitConflictBlock =
  | { kind: 'text'; startLine: number; endLine: number; raw: string[] }
  | ({ kind: 'conflict' } & GitConflictHunk);

function isConflictStart(line: string) {
  return line.startsWith('<<<<<<<');
}

function isConflictBaseMarker(line: string) {
  return line.startsWith('|||||||');
}

function isConflictSeparator(line: string) {
  return line.startsWith('=======');
}

function isConflictEnd(line: string) {
  return line.startsWith('>>>>>>>');
}

export function parseGitConflictBlocks(content: string): GitConflictBlock[] {
  const lines = content.split('\n');
  const blocks: GitConflictBlock[] = [];
  let textBuffer: string[] = [];
  let textStartLine = 1;
  let hunkIndex = 0;

  const flushText = () => {
    if (!textBuffer.length) return;
    blocks.push({
      kind: 'text',
      startLine: textStartLine,
      endLine: textStartLine + textBuffer.length - 1,
      raw: textBuffer,
    });
    textBuffer = [];
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!isConflictStart(line)) {
      if (!textBuffer.length) textStartLine = lineIndex + 1;
      textBuffer.push(line);
      continue;
    }

    const start = lineIndex;
    let baseMarker = -1;
    let separator = -1;
    let end = -1;
    for (let scan = start + 1; scan < lines.length; scan += 1) {
      if (baseMarker < 0 && separator < 0 && isConflictBaseMarker(lines[scan])) {
        baseMarker = scan;
        continue;
      }
      if (separator < 0 && isConflictSeparator(lines[scan])) {
        separator = scan;
        continue;
      }
      if (separator >= 0 && isConflictEnd(lines[scan])) {
        end = scan;
        break;
      }
    }

    if (separator < 0 || end < 0) {
      if (!textBuffer.length) textStartLine = lineIndex + 1;
      textBuffer.push(line);
      continue;
    }

    flushText();
    blocks.push({
      kind: 'conflict',
      index: hunkIndex,
      startLine: start + 1,
      endLine: end + 1,
      marker: line.replace(/^<<<<<<<\s*/, '').trim() || 'HEAD',
      ours: lines.slice(start + 1, baseMarker >= 0 ? baseMarker : separator),
      theirs: lines.slice(separator + 1, end),
      base: baseMarker >= 0 ? lines.slice(baseMarker + 1, separator) : [],
      raw: lines.slice(start, end + 1),
    });
    hunkIndex += 1;
    lineIndex = end;
  }

  flushText();
  return blocks;
}

export function gitConflictHunks(content: string): GitConflictHunk[] {
  return parseGitConflictBlocks(content)
    .filter((block): block is GitConflictBlock & { kind: 'conflict' } => block.kind === 'conflict')
    .map(({ kind: _kind, ...hunk }) => hunk);
}

export function replaceGitConflictHunk(content: string, hunkIndex: number, side: ConflictSide) {
  return parseGitConflictBlocks(content)
    .flatMap((block) => {
      if (block.kind === 'text') return block.raw;
      if (block.index !== hunkIndex) return block.raw;
      return side === 'ours' ? block.ours : block.theirs;
    })
    .join('\n');
}

export function replaceAllGitConflictHunks(content: string, side: ConflictSide) {
  return parseGitConflictBlocks(content)
    .flatMap((block) => {
      if (block.kind === 'text') return block.raw;
      return side === 'ours' ? block.ours : block.theirs;
    })
    .join('\n');
}
