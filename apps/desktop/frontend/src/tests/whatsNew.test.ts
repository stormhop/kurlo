import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  formatSectionBlocks,
  isReleaseVersion,
  latestReleaseNotes,
  parseChangelog,
  releaseNoteKind,
  sectionIntro,
  releaseNotesFor,
  shouldShowWhatsNew,
  shouldSpotlightAgentMode,
  stripInlineMarkdown,
} from '../lib/whatsNew';

const CHANGELOG = `# Changelog

All notable changes are documented here.

---

## [1.1.0] - 2026-07-24

### Added
- Client certificates (mutual TLS).
- \`kurlo run\` — a CLI runner for CI.
  - Data-driven runs with \`--data\`.

### Fixed
- Query parameters keep their order on the wire.

---

## [1.0.0] - 2026-07-21

First public release.

### Requests
- All HTTP methods.
`;

describe('parseChangelog', () => {
  it('splits releases newest first and captures the date', () => {
    const sections = parseChangelog(CHANGELOG);
    expect(sections.map(s => s.version)).toEqual(['1.1.0', '1.0.0']);
    expect(sections[0].date).toBe('2026-07-24');
    expect(sections[1].date).toBe('2026-07-21');
  });

  it('keeps a release body free of the separator rules', () => {
    const [latest] = parseChangelog(CHANGELOG);
    expect(latest.body).toContain('### Added');
    expect(latest.body).toContain('### Fixed');
    expect(latest.body).not.toContain('---');
    expect(latest.body).not.toContain('## [1.0.0]');
  });

  it('handles an empty or headingless document', () => {
    expect(parseChangelog('')).toEqual([]);
    expect(parseChangelog('just prose, no headings')).toEqual([]);
  });

  it('accepts a heading without brackets or a date', () => {
    const sections = parseChangelog('## 2.0.0\n\n- Something\n');
    expect(sections[0]).toMatchObject({ version: '2.0.0', date: '' });
  });
});

describe('releaseNotesFor', () => {
  it('finds a version with or without a v prefix', () => {
    expect(releaseNotesFor(CHANGELOG, '1.1.0')?.version).toBe('1.1.0');
    expect(releaseNotesFor(CHANGELOG, 'v1.1.0')?.version).toBe('1.1.0');
  });

  it('returns null for an unknown or empty version', () => {
    expect(releaseNotesFor(CHANGELOG, '9.9.9')).toBeNull();
    expect(releaseNotesFor(CHANGELOG, '')).toBeNull();
  });
});

describe('latestReleaseNotes', () => {
  it('returns the newest release', () => {
    expect(latestReleaseNotes(CHANGELOG)?.version).toBe('1.1.0');
  });

  it('skips a non-numeric heading like Unreleased', () => {
    const withUnreleased = `## [Unreleased]\n\n- work in progress\n\n---\n\n## [1.2.0] - 2026-08-01\n\n- shipped\n`;
    expect(latestReleaseNotes(withUnreleased)?.version).toBe('1.2.0');
  });

  it('returns null when there are no releases', () => {
    expect(latestReleaseNotes('# Changelog\n\nnothing yet\n')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders releases numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.1.0', '1.1.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0);
    expect(compareVersions('v2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('treats missing components as zero', () => {
    expect(compareVersions('1.1', '1.1.0')).toBe(0);
    expect(compareVersions('2', '1.9.9')).toBeGreaterThan(0);
  });
});

describe('isReleaseVersion', () => {
  it('rejects dev and empty builds', () => {
    expect(isReleaseVersion('dev')).toBe(false);
    expect(isReleaseVersion('')).toBe(false);
    expect(isReleaseVersion('1.1.0')).toBe(true);
    expect(isReleaseVersion('v1.1.0')).toBe(true);
  });
});

describe('shouldShowWhatsNew', () => {
  it('shows after an upgrade', () => {
    expect(shouldShowWhatsNew('1.1.0', '1.0.0', true)).toBe(true);
  });

  it('stays quiet on a fresh install', () => {
    expect(shouldShowWhatsNew('1.1.0', null, true)).toBe(false);
  });

  it('stays quiet on a relaunch of the same version', () => {
    expect(shouldShowWhatsNew('1.1.0', '1.1.0', true)).toBe(false);
  });

  it('stays quiet on a downgrade', () => {
    expect(shouldShowWhatsNew('1.0.0', '1.1.0', true)).toBe(false);
  });

  it('stays quiet on dev builds and when the version has no notes', () => {
    expect(shouldShowWhatsNew('dev', '1.0.0', true)).toBe(false);
    expect(shouldShowWhatsNew('1.1.0', '1.0.0', false)).toBe(false);
  });
});

describe('formatSectionBlocks', () => {
  it('groups bullets under their heading', () => {
    const blocks = formatSectionBlocks(parseChangelog(CHANGELOG)[0].body);
    expect(blocks.map(b => b.heading)).toEqual(['Added', 'Fixed']);
    expect(blocks[0].items[0].text).toBe('Client certificates (mutual TLS).');
    expect(blocks[1].items.map(i => i.text)).toEqual(['Query parameters keep their order on the wire.']);
  });

  it('keeps a nested bullet as a child of its parent', () => {
    const blocks = formatSectionBlocks(parseChangelog(CHANGELOG)[0].body);
    expect(blocks[0].items[1]).toEqual({
      text: '`kurlo run` — a CLI runner for CI.',
      children: ['Data-driven runs with `--data`.'],
    });
  });

  it('joins a wrapped continuation line onto the bullet above it', () => {
    const blocks = formatSectionBlocks('### Added\n- A long entry that\nwraps across lines.\n');
    expect(blocks[0].items).toEqual([{ text: 'A long entry that wraps across lines.', children: [] }]);
  });

  it('drops headings that have no bullets', () => {
    expect(formatSectionBlocks('### Empty\n\n### Real\n- one\n')).toEqual([
      { heading: 'Real', items: [{ text: 'one', children: [] }] },
    ]);
  });

  it('keeps bullets that precede any heading', () => {
    const blocks = formatSectionBlocks('- standalone note\n');
    expect(blocks).toEqual([{ heading: '', items: [{ text: 'standalone note', children: [] }] }]);
  });
});

describe('stripInlineMarkdown', () => {
  it('removes code ticks, bold, and link syntax', () => {
    expect(stripInlineMarkdown('`kurlo run` is **new**, see [docs](https://x.dev)'))
      .toBe('kurlo run is new, see docs');
  });
});

describe('release notes from a tag annotation', () => {
  it('accepts second-level headings', () => {
    const blocks = formatSectionBlocks('## Added\n- Environment matrix\n## Fixed\n- Tab names');
    expect(blocks.map(b => b.heading)).toEqual(['Added', 'Fixed']);
    expect(blocks[1].items.map(item => item.text)).toEqual(['Tab names']);
  });

  it('classifies headings for the section dot', () => {
    expect(releaseNoteKind('Added')).toBe('added');
    expect(releaseNoteKind('Fixed')).toBe('fixed');
    expect(releaseNoteKind('Changed')).toBe('changed');
    expect(releaseNoteKind('Deprecated')).toBe('removed');
    expect(releaseNoteKind('Security')).toBe('');
  });
});

describe('sectionIntro', () => {
  it('reads the prose above the first heading', () => {
    expect(sectionIntro('Kurlo 2.0 is a new look.\nIt needs macOS 12.\n\n### Added\n- Palette')).toBe('Kurlo 2.0 is a new look. It needs macOS 12.');
  });

  it('is empty when a section starts with a heading or a bullet', () => {
    expect(sectionIntro('### Added\n- Palette')).toBe('');
    expect(sectionIntro('- Palette')).toBe('');
  });
});

describe('shouldSpotlightAgentMode', () => {
  it('spotlights Agent mode when an update crosses 3.0.0', () => {
    expect(shouldSpotlightAgentMode('3.0.0', '2.6.1')).toBe(true);
    expect(shouldSpotlightAgentMode('v3.0.2', '2.5.0')).toBe(true);
    expect(shouldSpotlightAgentMode('3.1.0', '2.6.1')).toBe(true);
  });

  it('keeps the usual notes once 3.0 was seen', () => {
    expect(shouldSpotlightAgentMode('3.0.1', '3.0.0')).toBe(false);
    expect(shouldSpotlightAgentMode('3.1.0', '3.0.4')).toBe(false);
  });

  it('stays quiet on a first install, a downgrade and development builds', () => {
    expect(shouldSpotlightAgentMode('3.0.0', null)).toBe(false);
    expect(shouldSpotlightAgentMode('2.6.1', '2.6.0')).toBe(false);
    expect(shouldSpotlightAgentMode('dev', '2.6.1')).toBe(false);
    expect(shouldSpotlightAgentMode('3.0.0', 'dev')).toBe(false);
  });
});
