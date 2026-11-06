
export type ChangelogSection = {
  version: string;
  date: string;
  body: string;
};

const VERSION_HEADING = /^##\s+\[?([^\]\s]+)\]?(?:\s*[-–]\s*(.+))?\s*$/;

export function parseChangelog(markdown: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | null = null;

  for (const line of String(markdown || '').replace(/\r\n?/g, '\n').split('\n')) {
    const heading = line.match(VERSION_HEADING);
    if (heading) {
      if (current) sections.push(finishSection(current));
      current = { version: heading[1].trim(), date: (heading[2] ?? '').trim(), body: '' };
      continue;
    }
    if (current && line.trim() === '---') continue;
    if (current) current.body += line + '\n';
  }
  if (current) sections.push(finishSection(current));
  return sections;
}

function finishSection(section: ChangelogSection): ChangelogSection {
  return { ...section, body: section.body.trim() };
}

export function normalizeVersion(version: string): string {
  return String(version || '').trim().replace(/^v/i, '');
}

export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    normalizeVersion(value)
      .split('.')
      .map(part => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isReleaseVersion(version: string): boolean {
  const normalized = normalizeVersion(version);
  return normalized !== '' && normalized !== 'dev' && /^\d/.test(normalized);
}

export function releaseNotesFor(markdown: string, version: string): ChangelogSection | null {
  const wanted = normalizeVersion(version);
  if (!wanted) return null;
  return parseChangelog(markdown).find(section => normalizeVersion(section.version) === wanted) ?? null;
}

export function latestReleaseNotes(markdown: string): ChangelogSection | null {
  return parseChangelog(markdown).find(section => /^\d/.test(normalizeVersion(section.version))) ?? null;
}

export function shouldShowWhatsNew(current: string, lastSeen: string | null, hasNotes: boolean): boolean {
  if (!isReleaseVersion(current)) return false;
  if (!hasNotes) return false;
  if (!lastSeen) return false;
  return compareVersions(current, lastSeen) > 0;
}

export const AGENT_MODE_VERSION = '3.0.0';

export function shouldSpotlightAgentMode(current: string, lastSeen: string | null): boolean {
  if (!isReleaseVersion(current) || !lastSeen || !isReleaseVersion(lastSeen)) return false;
  return compareVersions(lastSeen, AGENT_MODE_VERSION) < 0 && compareVersions(current, AGENT_MODE_VERSION) >= 0;
}

export type WhatsNewItem = { text: string; children: string[] };
export type WhatsNewBlock = { heading: string; items: WhatsNewItem[] };

export function formatSectionBlocks(body: string): WhatsNewBlock[] {
  const blocks: WhatsNewBlock[] = [];
  let current: WhatsNewBlock | null = null;

  const lastItem = () => (current && current.items.length ? current.items[current.items.length - 1] : null);

  for (const raw of String(body || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    const heading = line.match(/^#{2,4}\s+(.+?)\s*$/);
    if (heading) {
      current = { heading: heading[1], items: [] };
      blocks.push(current);
      continue;
    }

    const bullet = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (bullet) {
      if (!current) {
        current = { heading: '', items: [] };
        blocks.push(current);
      }
      const text = bullet[2].trim();
      const parent = lastItem();
      if (bullet[1].length > 0 && parent) {
        parent.children.push(text);
      } else {
        current.items.push({ text, children: [] });
      }
      continue;
    }

    const parent = lastItem();
    if (parent) {
      if (parent.children.length > 0) {
        parent.children[parent.children.length - 1] += ` ${line.trim()}`;
      } else {
        parent.text += ` ${line.trim()}`;
      }
    }
  }

  return blocks.filter(block => block.items.length > 0);
}

export function stripInlineMarkdown(text: string): string {
  return String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

export function releaseNoteKind(heading: string): string {
  const key = heading.trim().toLowerCase();
  if (key.startsWith('add') || key.startsWith('new')) return 'added';
  if (key.startsWith('fix')) return 'fixed';
  if (key.startsWith('chang') || key.startsWith('improv')) return 'changed';
  if (key.startsWith('remov') || key.startsWith('deprecat') || key.startsWith('break')) return 'removed';
  return '';
}

export function sectionIntro(body: string): string {
  const lines: string[] = [];
  for (const raw of String(body || '').split('\n')) {
    const line = raw.trim();
    if (/^#{2,4}\s/.test(line) || /^[-*]\s/.test(line)) break;
    if (line) lines.push(line);
  }
  return lines.join(' ');
}
