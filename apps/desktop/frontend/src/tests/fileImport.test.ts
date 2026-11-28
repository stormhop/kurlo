import { backend, TestApp } from './support/appIntegration';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SavedRequest } from '../lib/types/models';
import { detectImportSource } from '../lib/importSource';
import { fileUrlFromPath, pathFromFileUrl } from '../lib/stores/features/importExport';
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

    dispatchFileDrop(outside, ['']);
    dispatchFileDrop(inside, ['', '  ']);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(zoneDrop).toHaveBeenCalledTimes(1);
    dispatchFileDrop(outside, ['', '/tmp/d.http']);
    expect(fallback).toHaveBeenLastCalledWith(['/tmp/d.http']);

    removeZone();
    dispatchFileDrop(inside, ['/tmp/b.http']);
    expect(fallback).toHaveBeenLastCalledWith(['/tmp/b.http']);

    uninstall();
    expect(runtime.OnFileDropOff).toHaveBeenCalled();
    expect(host.removeEventListener).toHaveBeenCalledTimes(host.addEventListener.mock.calls.length);
    expect(properties.has('--wails-drop-target')).toBe(false);
    dispatchFileDrop(outside, ['/tmp/c.http']);
    expect(fallback).toHaveBeenCalledTimes(3);
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

describe('importing an AsyncAPI document', () => {
  it('builds a Kafka collection and links the spec as the message schema', async () => {
    const app = newApp();
    vi.mocked(backend.hasNativeImportDialog).mockReturnValue(true);
    const spec = 'asyncapi: 3.0.0\ninfo:\n  title: Orders\nservers:\n  dev:\n    host: localhost:9092\n    protocol: kafka\nchannels:\n  orders:\n    address: orders\n    messages:\n      created:\n        payload:\n          type: object\n          properties:\n            id: { type: integer, example: 7 }\noperations:\n  placeOrder:\n    action: receive\n    channel:\n      $ref: \'#/channels/orders\'\n';
    vi.mocked(backend.chooseImportFile).mockResolvedValueOnce({ path: '/work/specs/orders.yaml', name: 'orders.yaml', content: spec, error: '' });

    app.selects.push('asyncapi');
    await app.openPostmanImport();

    expect(backend.chooseImportFile).toHaveBeenCalledWith('asyncapi');
    expect(app.collections.map((collection: { name: string }) => collection.name)).toEqual(['Orders']);
    const [request] = app.requests as SavedRequest[];
    expect(request).toMatchObject({ name: 'placeOrder', requestType: 'kafka', url: '{{brokers}}', bodyContent: '{\n  "id": 7\n}' });
    expect(request.kafka).toMatchObject({ mode: 'produce', topic: 'orders', schemaPath: 'specs/orders.yaml' });
    expect(app.collections[0].defaults.variables.map((row: { key: string; value: string }) => [row.key, row.value])).toEqual([['brokers', 'localhost:9092']]);
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

  it('keeps slashes in imported Postman request names', async () => {
    const app = newApp();
    vi.mocked(backend.hasNativeImportDialog).mockReturnValue(true);
    vi.mocked(backend.chooseImportFile).mockResolvedValueOnce({
      path: '/work/billing.postman_collection.json',
      name: 'billing.postman_collection.json',
      content: JSON.stringify({
        info: { name: 'Billing API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [{ name: 'Billing / Invoices', request: { method: 'GET', url: 'https://api.example.com/invoices' } }],
      }),
      error: '',
    });

    app.selects.push('postman');
    await app.openPostmanImport();

    const [request] = app.requests as SavedRequest[];
    expect(request.name).toBe('Billing / Invoices');
    expect(request.folderPath).toEqual([]);
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

const pingWsdl = `<?xml version="1.0"?>
<definitions name="Ping" xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:ping" targetNamespace="urn:ping">
  <message name="PingIn"><part name="text" type="xsd:string"/></message>
  <portType name="PingPort"><operation name="Ping"><input message="tns:PingIn"/></operation></portType>
  <binding name="PingBinding" type="tns:PingPort">
    <soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Ping"><soap:operation soapAction="urn:ping#Ping"/><input><soap:body use="literal" namespace="urn:ping"/></input></operation>
  </binding>
  <service name="PingService"><port name="PingPort" binding="tns:PingBinding"><soap:address location="https://soap.example.com/ping"/></port></service>
</definitions>`;

describe('importing a WSDL', () => {
  it('builds a SOAP collection from the import dialog', async () => {
    const app = newApp();
    vi.mocked(backend.hasNativeImportDialog).mockReturnValue(true);
    vi.mocked(backend.chooseImportFile).mockResolvedValueOnce({ path: '/work/ping.wsdl', name: 'ping.wsdl', content: pingWsdl, error: '' });

    app.selects.push('wsdl');
    await app.openPostmanImport();

    expect(backend.chooseImportFile).toHaveBeenCalledWith('wsdl');
    expect(app.collectionImportToast).toBe('Imported 1 request');
    expect(app.collections.map((collection: { name: string }) => collection.name)).toEqual(['Ping']);
    const [request] = app.requests as SavedRequest[];
    expect(request).toMatchObject({ name: 'Ping', requestType: 'http', method: 'POST', url: 'https://soap.example.com/ping', bodyType: 'xml', requestTab: 'body' });
    expect(request.headers.map(row => `${row.key}: ${row.value}`)).toEqual(['Content-Type: text/xml; charset=utf-8', 'SOAPAction: "urn:ping#Ping"']);
    expect(request.bodyContent).toContain('<tns:Ping>\n      <text>?</text>\n    </tns:Ping>');
    expect(backend.state.savedStores.at(-1)).toBeTruthy();
  });

  it('imports a dropped WSDL file', async () => {
    const app = newApp();
    vi.mocked(backend.readImportFile).mockResolvedValueOnce({ path: '/work/Service.xml', name: 'Service.xml', content: pingWsdl, error: '' });

    await app.importDroppedFiles(['/work/Service.xml']);

    expect(app.collections.map((collection: { name: string }) => collection.name)).toEqual(['Ping']);
    expect((app.requests as SavedRequest[]).map(request => request.name)).toEqual(['Ping']);
  });

  it('fetches a WSDL from a URL', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest).mockResolvedValueOnce({ statusCode: 200, status: '200 OK', body: pingWsdl, headers: [{ key: 'Content-Type', value: 'text/xml' }] } as never);

    app.selects.push('wsdl-url');
    app.prompts.push('soap.example.com/ping.asmx?wsdl');
    app.toggles.push(true);
    await app.openPostmanImport();

    const sent = vi.mocked(backend.sendHttpRequest).mock.calls.at(-1)![0];
    expect(sent).toMatchObject({ method: 'GET', url: 'https://soap.example.com/ping.asmx?wsdl', enableSSLVerification: false });
    expect(sent.headers[0].value).toContain('application/wsdl+xml');
    expect(app.collectionImportToast).toBe('Imported 1 request');
    expect((app.requests as SavedRequest[]).map(request => request.url)).toEqual(['https://soap.example.com/ping']);
  });

  it('shows why a WSDL from a URL could not be imported', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest).mockResolvedValueOnce({ statusCode: 200, status: '200 OK', body: '<html><body>Service</body></html>', headers: [] } as never);

    app.selects.push('wsdl-url');
    app.prompts.push('https://soap.example.com/ping.asmx');
    await app.openPostmanImport();

    expect(app.alerts.at(-1)).toMatchObject({ title: 'Import from URL failed', message: expect.stringContaining('WSDL 1.1') });
    expect(app.collections).toHaveLength(0);
  });
});

const splitRoot = `<definitions name="Split" xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="urn:split" targetNamespace="urn:split">
  <import namespace="urn:split" location="parts/messages.wsdl"/>
  <service name="Split"><port name="P" binding="tns:B"><soap:address location="https://soap.example.com/split"/></port></service>
</definitions>`;
const splitMessages = `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:split" targetNamespace="urn:split">
  <types><xsd:schema targetNamespace="urn:split" elementFormDefault="qualified"><xsd:element name="Hello"><xsd:complexType><xsd:sequence><xsd:element name="who" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element></xsd:schema></types>
  <message name="HelloIn"><part name="p" element="tns:Hello"/></message>
  <portType name="T"><operation name="Hello"><input message="tns:HelloIn"/></operation></portType>
  <binding name="B" type="tns:T"><soap:binding transport="http://schemas.xmlsoap.org/soap/http"/><operation name="Hello"><soap:operation soapAction="urn:split#Hello"/><input><soap:body use="literal"/></input></operation></binding>
</definitions>`;

describe('importing a WSDL that imports other files', () => {
  it('reads imported files next to a WSDL on disk', async () => {
    const app = newApp();
    vi.mocked(backend.readImportFile).mockImplementation(async (path: string) => (
      path === '/work/my wsdl/split.wsdl'
        ? { path, name: 'split.wsdl', content: splitRoot, error: '' }
        : path === '/work/my wsdl/parts/messages.wsdl'
          ? { path, name: 'messages.wsdl', content: splitMessages, error: '' }
          : { path, name: '', content: '', error: `${path} not found` }
    ));

    await app.importDroppedFiles(['/work/my wsdl/split.wsdl']);

    const [request] = app.requests as SavedRequest[];
    expect(request.name).toBe('Hello');
    expect(request.bodyContent).toContain('<tns:Hello>\n      <tns:who>?</tns:who>\n    </tns:Hello>');
  });

  it('reports a missing imported file', async () => {
    const app = newApp();
    vi.mocked(backend.readImportFile).mockImplementation(async (path: string) => (
      path.endsWith('split.wsdl') ? { path, name: 'split.wsdl', content: splitRoot, error: '' } : { path, name: '', content: '', error: 'no such file' }
    ));

    await app.importDroppedFiles(['/work/split.wsdl']);

    expect(app.collectionImportToast).toBe('Import failed: Kurlo could not load parts/messages.wsdl, which the WSDL imports: no such file');
    expect(app.collections).toHaveLength(0);
  });

  it('fetches the imports of a WSDL from a URL', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest)
      .mockResolvedValueOnce({ statusCode: 200, status: '200 OK', body: splitRoot, headers: [] } as never)
      .mockResolvedValueOnce({ statusCode: 200, status: '200 OK', body: splitMessages, headers: [] } as never);

    app.selects.push('wsdl-url');
    app.prompts.push('https://soap.example.com/svc/split.wsdl');
    await app.openPostmanImport();

    const urls = vi.mocked(backend.sendHttpRequest).mock.calls.slice(-2).map(([sent]) => sent.url);
    expect(urls).toEqual(['https://soap.example.com/svc/split.wsdl', 'https://soap.example.com/svc/parts/messages.wsdl']);
    expect(app.collectionImportToast).toBe('Imported 1 request');
  });

  it('turns file paths into file URLs and back', () => {
    expect(fileUrlFromPath('/work/my wsdl/a#b.wsdl')).toBe('file:///work/my%20wsdl/a%23b.wsdl');
    expect(pathFromFileUrl(new URL('parts/x.xsd', fileUrlFromPath('/work/my wsdl/a#b.wsdl')).toString())).toBe('/work/my wsdl/parts/x.xsd');
    expect(fileUrlFromPath('C:\\Services\\calc.wsdl')).toBe('file:///C:/Services/calc.wsdl');
    expect(pathFromFileUrl(new URL('types.xsd', fileUrlFromPath('C:\\Services\\calc.wsdl')).toString())).toBe('C:/Services/types.xsd');
  });
});
