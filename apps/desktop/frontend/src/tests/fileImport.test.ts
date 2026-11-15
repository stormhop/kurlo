import { backend, TestApp } from './support/appIntegration';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SavedRequest } from '../lib/types/models';
import { detectImportSource } from '../lib/importSource';
import { addFileDropZone, blockExternalDropNavigation, dispatchFileDrop, installFileDrop } from '../lib/fileDrop';

const httpFile = `### Login
< {%
  request.variables.set("ts", Date.now());
%}
POST https://api.example.com/login

> {%
  client.global.set("token", response.body.token);
%}
`;

function newApp() {
  backend.state.savedStores = [];
  return new TestApp() as TestApp & Record<string, any>;
}

afterEach(() => {
  vi.mocked(backend.hasNativeImportDialog).mockReturnValue(false);
  vi.unstubAllGlobals();
});

describe('detectImportSource', () => {
  it('recognises formats by extension and content', () => {
    expect(detectImportSource('api.http', '')).toBe('httpfile');
    expect(detectImportSource('smoke.REST', '')).toBe('httpfile');
    expect(detectImportSource('item.bru', '')).toBe('bruno');
    expect(detectImportSource('spec.yaml', 'openapi: 3.0.0\ninfo:\n  title: A\n')).toBe('openapi');
    expect(detectImportSource('spec.json', '{"swagger":"2.0"}')).toBe('openapi');
    expect(detectImportSource('traffic.har', '{"log":{"entries":[]}}')).toBe('har');
    expect(detectImportSource('c.json', '{"info":{"_postman_id":"1","schema":"x"},"item":[]}')).toBe('postman');
    expect(detectImportSource('env.json', '{"name":"Dev","values":[],"_postman_variable_scope":"environment"}')).toBe('postman');
    expect(detectImportSource('i.json', '{"_type":"export","__export_format":4,"resources":[]}')).toBe('insomnia');
    expect(detectImportSource('notes.txt', 'hello')).toBeNull();
    expect(detectImportSource('data.json', '{"a":1}')).toBeNull();
  });
});

describe('file drop dispatch', () => {
  it('sends drops inside a zone to the zone and the rest to the fallback', () => {
    const inside = {} as Element;
    const outside = {} as Element;
    const zone = { contains: (node: Element | null) => node === inside } as HTMLElement;
    const properties = new Map<string, string>();
    vi.stubGlobal('document', {
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => properties.set(name, value),
          removeProperty: (name: string) => properties.delete(name),
        },
      },
    });
    const zoneDrop = vi.fn();
    const fallback = vi.fn();
    const runtime = { OnFileDrop: vi.fn(), OnFileDropOff: vi.fn() };
    const host = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const uninstall = installFileDrop(runtime, fallback, host as unknown as Window);
    const removeZone = addFileDropZone(zone, zoneDrop);

    expect(runtime.OnFileDrop).toHaveBeenCalledWith(expect.any(Function), true);
    expect(properties.get('--wails-drop-target')).toBe('drop');

    dispatchFileDrop(inside, ['/tmp/a.png']);
    dispatchFileDrop(outside, ['/tmp/api.http']);
    expect(zoneDrop).toHaveBeenCalledWith(['/tmp/a.png']);
    expect(fallback).toHaveBeenCalledWith(['/tmp/api.http']);

    removeZone();
    dispatchFileDrop(inside, ['/tmp/b.http']);
    expect(fallback).toHaveBeenLastCalledWith(['/tmp/b.http']);

    uninstall();
    expect(runtime.OnFileDropOff).toHaveBeenCalled();
    expect(host.removeEventListener).toHaveBeenCalledTimes(host.addEventListener.mock.calls.length);
    expect(properties.has('--wails-drop-target')).toBe(false);
    dispatchFileDrop(outside, ['/tmp/c.http']);
    expect(fallback).toHaveBeenCalledTimes(2);
  });
});

describe('blockExternalDropNavigation', () => {
  function dragEvent() {
    return { preventDefault: vi.fn(), dataTransfer: { dropEffect: 'none' } };
  }

  it('cancels the browser default only for drags that started outside the page', () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const host = {
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const unblock = blockExternalDropNavigation(host as unknown as Window);

    const fileOver = dragEvent();
    listeners.get('dragover')!(fileOver);
    const fileDrop = dragEvent();
    listeners.get('drop')!(fileDrop);
    expect(fileOver.preventDefault).toHaveBeenCalled();
    expect(fileOver.dataTransfer.dropEffect).toBe('copy');
    expect(fileDrop.preventDefault).toHaveBeenCalled();

    listeners.get('dragstart')!({});
    const rowOver = dragEvent();
    listeners.get('dragover')!(rowOver);
    const rowDrop = dragEvent();
    listeners.get('drop')!(rowDrop);
    expect(rowOver.preventDefault).not.toHaveBeenCalled();
    expect(rowDrop.preventDefault).not.toHaveBeenCalled();

    const nextFile = dragEvent();
    listeners.get('drop')!(nextFile);
    expect(nextFile.preventDefault).toHaveBeenCalled();

    listeners.get('dragstart')!({});
    listeners.get('dragend')!({});
    const afterCancel = dragEvent();
    listeners.get('dragover')!(afterCancel);
    expect(afterCancel.preventDefault).toHaveBeenCalled();

    unblock();
    expect(listeners.size).toBe(0);
  });
});

describe('importing .http files from disk', () => {
  it('uses the native dialog filtered to .http files and keeps the scripts', async () => {
    const app = newApp();
    vi.mocked(backend.hasNativeImportDialog).mockReturnValue(true);
    vi.mocked(backend.chooseImportFile).mockResolvedValueOnce({ path: '/work/auth.http', name: 'auth.http', content: httpFile, error: '' });
    const click = vi.fn();
    app._postmanImportInput = { click } as unknown as HTMLInputElement;

    app.selects.push('httpfile');
    await app.openPostmanImport();

    expect(backend.chooseImportFile).toHaveBeenCalledWith('httpfile');
    expect(click).not.toHaveBeenCalled();
    expect(app.collections.map((collection: { name: string }) => collection.name)).toEqual(['auth']);
    const [request] = app.requests as SavedRequest[];
    expect(`${request.method} ${request.url}`).toBe('POST https://api.example.com/login');
    expect(request.bodyContent).toBe('');
    expect(request.preRequestScriptJs).toBe('request.variables.set("ts", Date.now());');
    expect(request.testScriptJs).toBe('client.global.set("token", response.body.token);');
  });

  it('imports a dropped .http file and reports files it cannot import', async () => {
    const app = newApp();
    vi.mocked(backend.readImportFile).mockImplementation(async (path: string) => (
      path.endsWith('.http')
        ? { path, name: 'dropped.http', content: 'GET https://api.example.com/ping\n', error: '' }
        : { path, name: 'photo.png', content: '', error: 'photo.png is not a text file' }
    ));

    await app.importDroppedFiles(['/work/photo.png']);
    expect(app.collectionImportToast).toBe('Import failed: photo.png is not a text file');
    expect(app.collections).toHaveLength(0);

    await app.importDroppedFiles(['/work/dropped.http']);
    expect(app.collections.map((collection: { name: string }) => collection.name)).toEqual(['dropped']);
    expect((app.requests as SavedRequest[]).map(request => request.url)).toEqual(['https://api.example.com/ping']);
  });
});
