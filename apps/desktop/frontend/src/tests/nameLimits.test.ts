import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NAME_MAX_LENGTH, clampName, mkRow, shortName } from '../lib/constants';
import { dialogFeature } from '../lib/stores/features/dialogs';
import { environmentFeature } from '../lib/stores/features/environments';
import type { AppDialogState } from '../lib/types/dialog';
import type { Environment } from '../lib/types/models';

const SRC = join(import.meta.dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'tests' ? [] : walk(path);
    return [path];
  });
}

function dialogHost() {
  return {
    appDialog: null as AppDialogState | null,
    dialogInputValue: '',
    dialogSelectOpen: false,
    closeFloatingMenus: vi.fn(),
    dismissDialog: vi.fn(),
    submitDialog: vi.fn(),
    moveDialogSelection: vi.fn(),
  };
}

describe('name limits', () => {
  it('trims names and cuts them at the limit without splitting a character', () => {
    expect(clampName('  Staging  ')).toBe('Staging');
    expect(clampName('x'.repeat(NAME_MAX_LENGTH + 50))).toHaveLength(NAME_MAX_LENGTH);
    const emoji = `${'a'.repeat(NAME_MAX_LENGTH - 1)}😀`;
    expect(clampName(emoji)).toBe('a'.repeat(NAME_MAX_LENGTH - 1));
  });

  it('shortens names inside sentences with an ellipsis', () => {
    expect(shortName('Staging')).toBe('Staging');
    const short = shortName('e'.repeat(90));
    expect(short).toHaveLength(40);
    expect(short.endsWith('…')).toBe(true);
  });

  it('keeps the environment switcher from growing with the name', () => {
    const css = readFileSync(join(SRC, 'styles/workspace.css'), 'utf8');
    const rule = css.match(/\n\.environment-select \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/max-width:/);
  });

  it('opens the name dialog with the limit and returns a clamped name', async () => {
    const host = dialogHost();
    const pending = dialogFeature.openNameDialog.call(host, 'New environment', 'y'.repeat(300));
    expect(host.appDialog?.maxLength).toBe(NAME_MAX_LENGTH);
    expect(host.dialogInputValue).toHaveLength(NAME_MAX_LENGTH);
    host.appDialog?.resolve(`  ${'z'.repeat(400)}  `);
    expect(await pending).toBe('z'.repeat(NAME_MAX_LENGTH));
  });

  it('keeps other prompts such as Git URLs unlimited', async () => {
    const host = dialogHost();
    const pending = dialogFeature.openPromptDialog.call(host, 'Clone Git workspace');
    expect(host.appDialog?.maxLength).toBeUndefined();
    const url = `https://example.com/${'a'.repeat(300)}.git`;
    host.appDialog?.resolve(url);
    expect(await pending).toBe(url);
  });

  it('cuts an environment name that is too long when renaming', async () => {
    const environment: Environment = { id: 'env-1', workspaceId: 'ws-1', name: 'Dev', values: [mkRow()] };
    const host = {
      environments: [environment],
      autosave: false,
      guardWorkspaceWritable: () => true,
      editEnvironments(next: Environment[]) { host.environments = next; },
      saveEnvironment: vi.fn(),
    };
    await environmentFeature.renameEnvironment.call(host as never, 'env-1', `dev${'1'.repeat(500)}`);
    expect(host.environments[0].name).toHaveLength(NAME_MAX_LENGTH);
    expect(host.environments[0].name.startsWith('dev111')).toBe(true);
  });

  it('limits every field that names something', () => {
    const unlimited = new Set(['Path variable name', 'Variable name']);
    const offenders = walk(SRC).filter(file => file.endsWith('.svelte')).flatMap(file => {
      const source = readFileSync(file, 'utf8');
      return Array.from(source.matchAll(/<input\b(?:[^<>{}]|\{[^{}]*\})*?>/g))
        .filter(match => {
          const label = match[0].match(/aria-label="([^"]*)"/)?.[1] ?? '';
          return /\bname$/i.test(label) && !unlimited.has(label) && !/\bmaxlength=/.test(match[0]);
        })
        .map(match => `${relative(SRC, file)}:${source.slice(0, match.index).split('\n').length}`);
    });
    expect(offenders).toEqual([]);
  });
});
