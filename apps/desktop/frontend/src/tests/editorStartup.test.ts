import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');

describe('editor startup', () => {
  it('keeps CodeMirror out of the first load and warms it in the background', () => {
    const textEditing = readFileSync(join(SRC, 'lib/textEditing.ts'), 'utf8');
    expect(textEditing).toMatch(/import type \{ EditorView \} from '@codemirror\/view';/);
    expect(textEditing).not.toMatch(/^import \{ EditorView \}/m);

    const overlays = readFileSync(join(SRC, 'lib/components/AppOverlays.svelte'), 'utf8');
    expect(overlays).not.toMatch(/import WorkspaceYAMLEditor from/);
    expect(overlays).toMatch(/lazy\.WorkspaceYAMLEditorComponent/);

    const agent = readFileSync(join(SRC, 'lib/components/AgentWorkspace.svelte'), 'utf8');
    expect(agent).not.toMatch(/import AgentNotesEditor from/);
    expect(agent).toMatch(/lazy\.AgentNotesEditorComponent/);

    const app = readFileSync(join(SRC, 'App.svelte'), 'utf8');
    expect(app).toMatch(/lazy\.warmEditor\(\)/);
  });
});
