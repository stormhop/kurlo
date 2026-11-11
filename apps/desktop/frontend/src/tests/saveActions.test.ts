import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPONENTS = join(import.meta.dirname, '..', 'lib', 'components');
const SCREENS = ['RequestBar', 'LoadTestWorkspace', 'EnvironmentWorkspace', 'GlobalsWorkspace', 'CollectionWorkspace', 'WorkspaceOverview'];

describe('save and revert buttons', () => {
  it.each(SCREENS)('%s uses the shared Save and Revert buttons', screen => {
    const source = readFileSync(join(COMPONENTS, `${screen}.svelte`), 'utf8');
    expect(source).toMatch(/<SaveActions\b/);
    expect(source).not.toMatch(/>\s*(Save|Saved|Revert)\s*<\/button>/);
    expect(source).not.toMatch(/\{saved \? 'Saved' : 'Save'\}/);
  });

  it('keeps an accessible name on Save when its label is hidden', () => {
    const source = readFileSync(join(COMPONENTS, 'SaveActions.svelte'), 'utf8');
    expect(source).toMatch(/aria-label=\{saveDirty \? 'Save' : 'Saved'\}/);
    expect(source).toMatch(/aria-label="Revert unsaved changes"/);
  });
});
