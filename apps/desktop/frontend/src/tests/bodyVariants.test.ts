import { describe, expect, it } from 'vitest';
import { copyBodyVariant, normalizeBodyVariants, selectBodyVariant } from '../lib/bodyVariants';
import { requestBodyDefaultsFor } from '../lib/requestBodyDefaults';
import type { BodyVariant } from '../lib/types/models';
import { mkRow } from '../lib/constants';

describe('HTTP body variants', () => {
  it('keeps independent form rows and file references through a switch', () => {
    const editor = {
      ...requestBodyDefaultsFor('http'), activeBodyVariant: '', bodyVariants: [] as BodyVariant[],
    };
    editor.bodyType = 'form';
    editor.formRows = [{ ...mkRow(), key: 'invoice', value: 'fixtures/initial.pdf', isFile: true }];
    copyBodyVariant(editor, 'Original form');
    copyBodyVariant(editor, 'Updated form');
    editor.formRows[0].value = 'fixtures/edited.pdf';
    copyBodyVariant(editor, 'PDF only');
    editor.bodyType = 'binary';
    editor.bodyFilePath = 'fixtures/invoice.pdf';
    editor.bodyFileName = 'invoice.pdf';
    selectBodyVariant(editor, 'Original form');
    expect(editor.bodyType).toBe('form');
    expect(editor.formRows[0].value).toBe('fixtures/initial.pdf');
    selectBodyVariant(editor, 'Updated form');
    expect(editor.formRows[0].value).toBe('fixtures/edited.pdf');
    selectBodyVariant(editor, 'PDF only');
    expect(editor).toMatchObject({ bodyType: 'binary', bodyFilePath: 'fixtures/invoice.pdf', bodyFileName: 'invoice.pdf' });
  });

  it('keeps all five bodies intact when asked to create a sixth', () => {
    const editor = { ...requestBodyDefaultsFor('http'), activeBodyVariant: '', bodyVariants: [] as BodyVariant[] };
    for (const name of ['First', 'Second', 'Third', 'Fourth', 'Fifth']) copyBodyVariant(editor, name);
    copyBodyVariant(editor, 'Sixth');
    expect(editor.activeBodyVariant).toBe('Fifth');
    expect(editor.bodyVariants.map(body => body.name)).toEqual(['First', 'Second', 'Third', 'Fourth']);
  });

  it('keeps legacy requests unnamed and restores a compact body from YAML', () => {
    expect(normalizeBodyVariants({ bodyContent: 'legacy' })).toEqual({});
    const loaded = normalizeBodyVariants({
      activeBodyVariant: 'Empty', bodyVariants: [{ name: 'JSON', bodyType: 'json', bodyContent: '{}' } as BodyVariant],
    });
    expect(loaded.bodyVariants).toEqual([{
      name: 'JSON', bodyType: 'json', rawBodyType: 'json', bodyContent: '{}', bodyFileName: '', bodyFilePath: '', formRows: [],
    }]);
  });
});
