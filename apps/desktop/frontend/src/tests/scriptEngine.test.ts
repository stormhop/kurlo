import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeScript, routeImportedScripts, scriptFieldsForSend, withActiveScripts } from '../lib/scriptEngine';
import { preferencesFeature } from '../lib/stores/features/preferences';
import { normalizeSavedRequest } from '../lib/normalizers';
import type { SavedRequest, ScriptEngine } from '../lib/types/models';

const scripts = {
  preRequestScript: 'tengo-pre',
  testScript: 'tengo-test',
  preRequestScriptJs: 'js-pre',
  testScriptJs: 'js-test',
};

describe('scriptFieldsForSend', () => {
  it('sends the JS scripts when the engine is js', () => {
    expect(scriptFieldsForSend('js', scripts)).toEqual({
      preRequestScript: 'js-pre',
      testScript: 'js-test',
      scriptEngine: 'js',
    });
  });

  it('sends the Tengo scripts when the engine is tengo', () => {
    expect(scriptFieldsForSend('tengo', scripts)).toEqual({
      preRequestScript: 'tengo-pre',
      testScript: 'tengo-test',
      scriptEngine: 'tengo',
    });
  });

  it('falls back to empty strings when the active engine has no script', () => {
    expect(scriptFieldsForSend('js', { preRequestScript: 'x', testScript: 'y' })).toEqual({
      preRequestScript: '',
      testScript: '',
      scriptEngine: 'js',
    });
  });
});

describe('withActiveScripts (export)', () => {
  it('copies the JS scripts into the base fields when the engine is js', () => {
    const out = withActiveScripts(scripts, 'js');
    expect(out.preRequestScript).toBe('js-pre');
    expect(out.testScript).toBe('js-test');
  });

  it('keeps the Tengo scripts in the base fields when the engine is tengo', () => {
    const out = withActiveScripts(scripts, 'tengo');
    expect(out.preRequestScript).toBe('tengo-pre');
    expect(out.testScript).toBe('tengo-test');
  });
});

describe('activeScript', () => {
  it('routes to the engine-specific buffer', () => {
    expect(activeScript('js', 'tengo', 'js')).toBe('js');
    expect(activeScript('tengo', 'tengo', 'js')).toBe('tengo');
  });
});

describe('normalizeSavedRequest per-engine scripts', () => {
  it('preserves the JS script fields (so duplicate/copy/import keep them)', () => {
    const out = normalizeSavedRequest(
      { preRequestScript: 't-pre', testScript: 't-test', preRequestScriptJs: 'j-pre', testScriptJs: 'j-test' },
      [],
      'ws-1',
    );
    expect(out.preRequestScript).toBe('t-pre');
    expect(out.testScript).toBe('t-test');
    expect(out.preRequestScriptJs).toBe('j-pre');
    expect(out.testScriptJs).toBe('j-test');
  });

  it('defaults the JS script fields to empty strings', () => {
    const out = normalizeSavedRequest({}, [], 'ws-1');
    expect(out.preRequestScriptJs).toBe('');
    expect(out.testScriptJs).toBe('');
  });
});

describe('routeImportedScripts', () => {
  const imported = {
    id: 'r1',
    name: 'Imported',
    preRequestScript: 'console.log("pre")',
    testScript: 'pm.test("ok", () => pm.expect(1).to.eql(1))',
    preRequestScriptJs: '',
    testScriptJs: '',
  } as unknown as SavedRequest;

  it('moves imported scripts into the JS fields, whatever engine is active', () => {
    const out = routeImportedScripts(imported);
    expect(out.preRequestScriptJs).toBe('console.log("pre")');
    expect(out.testScriptJs).toBe('pm.test("ok", () => pm.expect(1).to.eql(1))');
    expect(out.preRequestScript).toBe('');
    expect(out.testScript).toBe('');
    expect(out.id).toBe('r1');
    expect(scriptFieldsForSend('tengo', out)).toEqual({ preRequestScript: '', testScript: '', scriptEngine: 'tengo' });
    expect(scriptFieldsForSend('js', out).preRequestScript).toBe('console.log("pre")');
  });

  it('is a no-op when there are no scripts to route', () => {
    const empty = { id: 'r2', preRequestScript: '', testScript: '', preRequestScriptJs: '', testScriptJs: '' } as unknown as SavedRequest;
    expect(routeImportedScripts(empty)).toBe(empty);
  });
});

describe('preferences script engine persistence', () => {
  const STORAGE_KEY = 'kurlo.scriptEngine.v1';
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { store = {}; },
      key: () => null,
      length: 0,
    } as Storage;
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('persists the chosen engine to localStorage', () => {
    const host = { scriptEngine: 'js' as ScriptEngine };
    preferencesFeature.setScriptEngine.call(host, 'tengo');
    expect(host.scriptEngine).toBe('tengo');
    expect(store[STORAGE_KEY]).toBe('tengo');
  });

  it('loads a stored engine, overriding the default', () => {
    store[STORAGE_KEY] = 'tengo';
    const host = { scriptEngine: 'js' as ScriptEngine };
    preferencesFeature.loadScriptEngine.call(host);
    expect(host.scriptEngine).toBe('tengo');
  });

  it('ignores an invalid stored value and keeps the default', () => {
    store[STORAGE_KEY] = 'python';
    const host = { scriptEngine: 'js' as ScriptEngine };
    preferencesFeature.loadScriptEngine.call(host);
    expect(host.scriptEngine).toBe('js');
  });

  it('does nothing when no engine has been stored', () => {
    const host = { scriptEngine: 'js' as ScriptEngine };
    preferencesFeature.loadScriptEngine.call(host);
    expect(host.scriptEngine).toBe('js');
  });

  it('keeps manual save as the default when no autosave preference has been stored', () => {
    const host = { autosave: false };
    preferencesFeature.loadAutosaveSettings.call(host as never);
    expect(host.autosave).toBe(false);
  });

  it('loads an explicit autosave preference', () => {
    store['kurlo.autosave.v1'] = 'true';
    const host = { autosave: false };
    preferencesFeature.loadAutosaveSettings.call(host as never);
    expect(host.autosave).toBe(true);
  });
});
