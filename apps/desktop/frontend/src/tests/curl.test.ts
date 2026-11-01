import { describe, expect, it } from 'vitest';
import { parseCurl, toCurl } from '../lib/curl';

describe('parseCurl', () => {
  it('does not infer a JSON body from Content-Type when curl has no data flag', () => {
    const parsed = parseCurl(`curl \\
      'https://example.test/products' \\
      -H 'X-API-Key: ' \\
      -H 'MerchantId: 11' \\
      -H 'Secret: redacted' \\
      -H 'Content-Type: application/json'`);

    expect(parsed.url).toBe('https://example.test/products');
    expect(parsed.method).toBe('GET');
    expect(parsed.body).toBeUndefined();
    expect(parsed.bodyType).toBeUndefined();
    expect(parsed.headers).toContainEqual({ key: 'Content-Type', value: 'application/json' });
  });

  it('keeps Cookie headers from multiline curl input', () => {
    const parsed = parseCurl(`curl \\
      'https://api.hornybox.ru/api/public/steam-gift/detail/content/slay-the-spire-2' \\
      -H 'Cookie: __ddg10_=1774623151; __ddg1_=kr413tNEMRYMIRZHGNUG; __ddg8_=p9DbfJGnLAXgtc4r; __ddg9_=136.169.214.33'`);

    expect(parsed.url).toBe('https://api.hornybox.ru/api/public/steam-gift/detail/content/slay-the-spire-2');
    expect(parsed.headers).toContainEqual({
      key: 'Cookie',
      value: '__ddg10_=1774623151; __ddg1_=kr413tNEMRYMIRZHGNUG; __ddg8_=p9DbfJGnLAXgtc4r; __ddg9_=136.169.214.33',
    });
  });

  it('parses curl cookie data from -b without replacing the URL', () => {
    const parsed = parseCurl(`curl \\
      'http://localhost:4200/api/assets/resource/by/path/L2Fzc2V0cy9pY29ucy/icon.svg' \\
      -H 'Accept: application/json, text/plain, */*' \\
      -b 'sid=abc; app_lang=ru; refresh=def' \\
      -H 'Referer: http://localhost:4200/main/icons/summary'`);

    expect(parsed.url).toBe('http://localhost:4200/api/assets/resource/by/path/L2Fzc2V0cy9pY29ucy/icon.svg');
    expect(parsed.headers).toContainEqual({ key: 'Cookie', value: 'sid=abc; app_lang=ru; refresh=def' });
  });

  it('ignores -b cookie jar file paths when importing headers', () => {
    const parsed = parseCurl(`curl 'https://example.test/products' -b './cookies.txt'`);

    expect(parsed.url).toBe('https://example.test/products');
    expect(parsed.headers).toEqual([]);
  });

  it('keeps the request URL when option values appear after it', () => {
    const parsed = parseCurl(`curl 'https://example.test/products' \\
      --output '/tmp/products.json' \\
      --proxy 'http://proxy.local:8080'`);

    expect(parsed.url).toBe('https://example.test/products');
  });

  it('parses attached option values copied from compact curl commands', () => {
    const parsed = parseCurl(`curl --request=PATCH --url=https://example.test/products/1 \\
      --header='Content-Type: application/json' \\
      --data-raw='{"name":"Ada"}'`);

    expect(parsed.url).toBe('https://example.test/products/1');
    expect(parsed.method).toBe('PATCH');
    expect(parsed.bodyType).toBe('json');
    expect(parsed.body).toBe('{"name":"Ada"}');
    expect(parsed.headers).toContainEqual({ key: 'Content-Type', value: 'application/json' });
  });

  it('supports Windows cmd line continuations', () => {
    const parsed = parseCurl('curl "https://example.test/products" ^\r\n  -H "Accept: application/json" ^\r\n  -A "KurloTest/1.0"');

    expect(parsed.url).toBe('https://example.test/products');
    expect(parsed.headers).toContainEqual({ key: 'Accept', value: 'application/json' });
    expect(parsed.headers).toContainEqual({ key: 'User-Agent', value: 'KurloTest/1.0' });
  });

  it('imports curl -G data as query params instead of a request body', () => {
    const parsed = parseCurl(`curl -G 'https://example.test/search?existing=1' \\
      --data-urlencode 'q=hello world' \\
      -d 'page=2'`);

    expect(parsed.url).toBe('https://example.test/search?existing=1&q=hello world&page=2');
    expect(parsed.method).toBe('GET');
    expect(parsed.body).toBeUndefined();
    expect(parsed.bodyType).toBeUndefined();
    expect(parsed.formData).toEqual([]);
  });

  it('handles CRLF line continuations from copied curl commands', () => {
    const parsed = parseCurl("curl \\\r\n  'https://example.test/products' \\\r\n  -H 'Cookie: sid=abc'");

    expect(parsed.url).toBe('https://example.test/products');
    expect(parsed.headers).toContainEqual({ key: 'Cookie', value: 'sid=abc' });
  });

  it('detects JSON body only when a data flag is present', () => {
    const parsed = parseCurl(`curl 'https://example.test/products' \\
      -H 'Content-Type: application/json' \\
      --data-raw '{"CategoryId":68}'`);

    expect(parsed.method).toBe('POST');
    expect(parsed.bodyType).toBe('json');
    expect(parsed.body).toBe('{"CategoryId":68}');
  });

  it('maps JavaScript content-type bodies to text bodies', () => {
    const parsed = parseCurl(`curl 'https://example.test/script' \\
      -H 'Content-Type: application/javascript' \\
      --data-raw 'console.log("ok")'`);

    expect(parsed.method).toBe('POST');
    expect(parsed.bodyType).toBe('text');
    expect(parsed.body).toBe('console.log("ok")');
  });

  it('keeps --data-binary file paths as binary request files', () => {
    const parsed = parseCurl(`curl 'https://example.test/upload' --data-binary '@/tmp/payload.bin'`);

    expect(parsed.method).toBe('POST');
    expect(parsed.bodyType).toBe('binary');
    expect(parsed.bodyFilePath).toBe('/tmp/payload.bin');
    expect(parsed.body).toBeUndefined();
  });

  it('parses repeated --data-urlencode flags as urlencoded rows', () => {
    const parsed = parseCurl(`curl 'https://example.test/form' \\
      --data-urlencode 'name=Jane Doe' \\
      --data-urlencode 'city=New York'`);

    expect(parsed.method).toBe('POST');
    expect(parsed.bodyType).toBe('urlencoded');
    expect(parsed.formData).toEqual([
      { key: 'name', value: 'Jane Doe', isFile: false },
      { key: 'city', value: 'New York', isFile: false },
    ]);
  });

  it('parses shell-escaped single quotes and escaped double quotes', () => {
    const parsed = parseCurl(`curl 'https://example.test/it'\\''s?q=coffee' -H "X-Note: say \\"hello\\""`);

    expect(parsed.url).toBe("https://example.test/it's?q=coffee");
    expect(parsed.headers).toContainEqual({ key: 'X-Note', value: 'say "hello"' });
  });
});

describe('toCurl', () => {
  it('exports urlencoded rows without pre-encoding them', () => {
    const curl = toCurl({
      method: 'POST',
      url: 'https://example.test/form',
      params: [],
      headers: [],
      auth: { type: 'none' },
      bodyType: 'urlencoded',
      body: '',
      formData: [
        { key: 'name', value: 'Jane Doe', enabled: true },
        { key: 'city', value: 'New York', enabled: true },
      ],
    });

    expect(curl).toContain("--data-urlencode 'name=Jane Doe'");
    expect(curl).toContain("--data-urlencode 'city=New York'");
    expect(curl).not.toContain('Jane%20Doe');
  });

  it('quotes binary paths as one curl argument', () => {
    const curl = toCurl({
      method: 'POST',
      url: 'https://example.test/upload',
      params: [],
      headers: [],
      auth: { type: 'none' },
      bodyType: 'binary',
      body: '',
      bodyFilePath: '/tmp/payload with spaces.bin',
      formData: [],
    });

    expect(curl).toContain("--data-binary '@/tmp/payload with spaces.bin'");
  });

  it('exports API key query auth into the URL', () => {
    const curl = toCurl({
      method: 'GET',
      url: 'https://example.test/search',
      params: [{ key: 'q', value: 'coffee', enabled: true }],
      headers: [],
      auth: { type: 'apikey', keyName: 'api_key', keyValue: 'secret', keyIn: 'query' },
      bodyType: 'none',
      body: '',
      formData: [],
    });

    expect(curl).toContain("'https://example.test/search?q=coffee&api_key=secret'");
  });

  it('ignores disabled Content-Type headers when adding JSON curl defaults', () => {
    const curl = toCurl({
      method: 'POST',
      url: 'https://example.test/items',
      params: [],
      headers: [{ key: 'Content-Type', value: 'text/plain', enabled: false }],
      auth: { type: 'none' },
      bodyType: 'json',
      body: '{"id":1}',
      formData: [],
    });

    expect(curl).toContain("-H 'Content-Type: application/json'");
  });
});

describe('auth in generated commands', () => {
  const base = {
    method: 'GET', url: 'https://api.example.test/v1/things',
    params: [], headers: [], bodyType: 'none', body: '', formData: [],
  };

  it('sends Digest credentials through curl --digest', () => {
    const out = toCurl({ ...base, auth: { type: 'digest', username: 'ada', password: 'hunter2' } });
    expect(out).toContain('--digest');
    expect(out).toContain("-u 'ada:hunter2'");
  });

  it('sends an OAuth 2.0 access token as a bearer header', () => {
    const out = toCurl({ ...base, auth: { type: 'oauth2', token: 'AT-123' } });
    expect(out).toContain("Authorization: Bearer AT-123");
  });

  it('lets curl sign an AWS SigV4 request itself', () => {
    const out = toCurl({
      ...base,
      auth: { type: 'aws', awsAccessKey: 'AK', awsSecretKey: 'SK', awsSessionToken: 'ST', awsRegion: 'eu-west-1', awsService: 's3' },
    });
    expect(out).toContain("--aws-sigv4 'aws:amz:eu-west-1:s3'");
    expect(out).toContain("-u 'AK:SK'");
    expect(out).toContain('x-amz-security-token: ST');
  });
});

describe('multipart part content types', () => {
  it("parses curl's ;type= suffix on a file part", () => {
    const parsed = parseCurl(`curl 'https://example.test/upload' -F 'avatar=@/tmp/a.png;type=image/png'`);

    expect(parsed.bodyType).toBe('form');
    expect(parsed.formData).toEqual([
      { key: 'avatar', value: '/tmp/a.png', isFile: true, contentType: 'image/png' },
    ]);
  });

  it('parses ;type= on a text part and leaves a plain part alone', () => {
    const parsed = parseCurl(`curl 'https://example.test/upload' -F 'meta={"a":1};type=application/json' -F 'note=hi'`);

    expect(parsed.formData).toEqual([
      { key: 'meta', value: '{"a":1}', isFile: false, contentType: 'application/json' },
      { key: 'note', value: 'hi', isFile: false },
    ]);
  });

  it('exports the part content type back as ;type=', () => {
    const curl = toCurl({
      method: 'POST',
      url: 'https://example.test/upload',
      params: [],
      headers: [],
      auth: { type: 'none' },
      bodyType: 'form',
      body: '',
      formData: [
        { key: 'avatar', value: '/tmp/a.png', enabled: true, isFile: true, contentType: 'image/png' },
        { key: 'note', value: 'hi', enabled: true },
      ],
    });

    expect(curl).toContain("-F 'avatar=@/tmp/a.png;type=image/png'");
    expect(curl).toContain("-F 'note=hi'");
  });
});

describe('parseCurl data flags', () => {
  it('sends -d key=value pairs as a urlencoded form, like curl does', () => {
    const parsed = parseCurl(`curl -X POST https://a.io/x -d 'a=1' -d 'b=two%20words'`);
    expect(parsed).toMatchObject({ method: 'POST', bodyType: 'urlencoded', body: 'a=1&b=two%20words', headers: [] });
  });

  it('keeps any other -d body raw and adds the urlencoded Content-Type curl would send', () => {
    const parsed = parseCurl(`curl https://a.io/x -d '{"a":1}'`);
    expect(parsed).toMatchObject({ method: 'POST', bodyType: 'text', body: '{"a":1}' });
    expect(parsed.headers).toEqual([{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }]);
  });

  it('respects an explicit Content-Type with -d', () => {
    const parsed = parseCurl(`curl https://a.io/x -H 'content-type: application/json' -d '{"a":1}'`);
    expect(parsed).toMatchObject({ bodyType: 'json', body: '{"a":1}' });
    expect(parsed.headers).toHaveLength(1);
  });

  it('reads --json as a JSON POST with its headers', () => {
    const parsed = parseCurl(`curl https://a.io/x --json '{"a":1}'`);
    expect(parsed).toMatchObject({ method: 'POST', bodyType: 'json', body: '{"a":1}' });
    expect(parsed.headers).toEqual([
      { key: 'Content-Type', value: 'application/json' },
      { key: 'Accept', value: 'application/json' },
    ]);
  });

  it('turns -d @file into a file body', () => {
    expect(parseCurl(`curl -XPOST https://a.io/x -d@body.json`)).toMatchObject({ method: 'POST', bodyType: 'binary', bodyFilePath: 'body.json' });
    expect(parseCurl(`curl https://a.io/x --json @payload.json`)).toMatchObject({ bodyType: 'binary', bodyFilePath: 'payload.json' });
  });

  it('decodes ANSI-C quoted strings from Copy as cURL (bash)', () => {
    const parsed = parseCurl(`curl 'https://a.io/x' -H 'content-type: application/json' --data-raw $'{"name":"it\\'s","note":"line1\\\\nline2\\u00e9\\x41"}'`);
    expect(parsed.body).toBe(`{"name":"it's","note":"line1\\nline2éA"}`);
    expect(parsed.bodyType).toBe('json');
  });

  it('merges -b cookies into an existing Cookie header', () => {
    const parsed = parseCurl(`curl https://a.io/x -H "Cookie: a=1; b=2" -b 'c=3'`);
    expect(parsed.headers).toEqual([{ key: 'Cookie', value: 'a=1; b=2; c=3' }]);
  });
});

describe('parseCurl --data-raw', () => {
  it('keeps a body that opens with @ as text instead of reading a file', () => {
    const parsed = parseCurl(`curl -X PATCH https://a.test --data-raw '@handle mentioned'`);
    expect(parsed.bodyType).toBe('text');
    expect(parsed.body).toBe('@handle mentioned');
    expect(parsed.bodyFilePath).toBeUndefined();
  });

  it('still reads a file for -d @path', () => {
    const parsed = parseCurl(`curl https://a.test -d @payload.json`);
    expect(parsed.bodyType).toBe('binary');
    expect(parsed.bodyFilePath).toBe('payload.json');
  });
});
