export type GitDiffRow = {
  kind: 'file' | 'hunk' | 'added' | 'removed' | 'context' | 'note';
  text: string;
  line: number | null;
};

const FILE_HEADER = /^(diff --git |diff --cc |index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |--- |\+\+\+ |Binary files )/;
const FILE_START = /^diff --(?:git|cc) (?:"?a\/)?(.*?)"?(?: "?b\/(.*?)"?)?$/;
const HUNK_HEADER = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@+ ?(.*)$/;

export function gitDiffRows(diff: string): GitDiffRow[] {
  const rows: GitDiffRow[] = [];
  const lines = diff.split('\n');
  const multiFile = lines.filter(line => line.startsWith('diff --git ') || line.startsWith('diff --cc ')).length > 1;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      const previous = rows[rows.length - 1];
      if ((previous && previous.kind !== 'file') || Math.max(oldLine, newLine) > 1) rows.push({ kind: 'hunk', text: hunk[3].trim(), line: null });
      continue;
    }
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
      inHunk = false;
      if (multiFile) {
        const match = FILE_START.exec(line);
        rows.push({ kind: 'file', text: match?.[2] || match?.[1] || line, line: null });
      }
      continue;
    }
    if (!inHunk) {
      if (!FILE_HEADER.test(line) && line.trim()) rows.push({ kind: 'note', text: line, line: null });
      continue;
    }
    if (line.startsWith('\\')) {
      rows.push({ kind: 'note', text: line.replace(/^\\\s*/, ''), line: null });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'added', text: line.slice(1), line: newLine++ });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'removed', text: line.slice(1), line: oldLine++ });
    } else if (line.startsWith(' ') || line === '') {
      rows.push({ kind: 'context', text: line.slice(1), line: newLine });
      oldLine++;
      newLine++;
    }
  }
  while (rows.length && rows[rows.length - 1].kind === 'context' && rows[rows.length - 1].text === '') rows.pop();
  return rows;
}
