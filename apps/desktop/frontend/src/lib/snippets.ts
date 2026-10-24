import { RAW_BODY_CONTENT_TYPES } from './constants';
import type { SnippetLanguage } from './stores/ui';
import type { RenderedSnippetLine } from './types/models';
import { methodColor, escapeHtml } from './utils';
import { shellQuote } from './curl';

export type SnippetRequest = {
  method: string; url: string;
  params: Array<{ key: string; value: string; enabled: boolean }>;
  headers: Array<{ key: string; value: string; enabled: boolean }>;
  auth: {
    type: string; token: string; username?: string; password?: string;
    keyName: string; keyValue: string; keyIn: string;
    awsAccessKey?: string; awsSecretKey?: string; awsSessionToken?: string; awsRegion?: string; awsService?: string;
  };
  bodyType: string; body: string; bodyFilePath?: string;
  formData: Array<{ key: string; value: string; enabled: boolean; isFile?: boolean; fileName?: string; contentType?: string }>;
};

function snippetRequestUrl(req: SnippetRequest) {
  const nextUrl = req.url || 'https://example.com';
  const paramsToAdd = req.params.filter(row => row.enabled && row.key);
  if (req.auth.type === 'apikey' && req.auth.keyIn === 'query' && req.auth.keyName) {
    paramsToAdd.push({ key: req.auth.keyName, value: req.auth.keyValue, enabled: true });
  }
  if (!paramsToAdd.length) return nextUrl;
  const joiner = nextUrl.includes('?') ? '&' : '?';
  return `${nextUrl}${joiner}${paramsToAdd.map(row => `${encodeURIComponent(row.key)}=${encodeURIComponent(row.value)}`).join('&')}`;
}

function base64(value: string) {
  try {
    return btoa(value);
  } catch {
    return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
  }
}

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

function snippetHeaders(req: SnippetRequest) {
  const multipart = req.bodyType === 'form' && formFields(req).length > 0;
  const headers = req.headers
    .filter(r => r.enabled && r.key && !(multipart && r.key.toLowerCase() === 'content-type'))
    .map(r => ({ key: r.key, value: r.value }));
  const hasContentType = headers.some(h => h.key.toLowerCase() === 'content-type');
  const rawContentType = RAW_BODY_CONTENT_TYPES[req.bodyType] ?? (req.bodyType === 'urlencoded' ? FORM_CONTENT_TYPE : req.bodyType === 'binary' && req.bodyFilePath ? 'application/octet-stream' : '');
  if (rawContentType && !hasContentType && snippetBodyKind(req) !== 'none') headers.push({ key: 'Content-Type', value: rawContentType });
  if ((req.auth.type === 'bearer' || req.auth.type === 'oauth2') && req.auth.token) {
    headers.push({ key: 'Authorization', value: `Bearer ${req.auth.token}` });
  }
  if (req.auth.type === 'basic' && (req.auth.username || req.auth.password)) {
    headers.push({ key: 'Authorization', value: `Basic ${base64(`${req.auth.username ?? ''}:${req.auth.password ?? ''}`)}` });
  }
  if (req.auth.type === 'apikey' && req.auth.keyIn === 'header' && req.auth.keyName) headers.push({ key: req.auth.keyName, value: req.auth.keyValue });
  return headers;
}

export function snippetAuthNotes(req: SnippetRequest): string[] {
  if (req.auth.type === 'digest') {
    return [`Digest auth: this request answers the server's challenge with the credentials for "${req.auth.username ?? ''}". Use your HTTP library's digest support — a fixed Authorization header will not work.`];
  }
  if (req.auth.type === 'oauth1') {
    return ['OAuth 1.0: the signature covers the timestamp and a fresh nonce, so it is computed per request. Use an OAuth 1.0 signing library here.'];
  }
  if (req.auth.type === 'aws') {
    return ['AWS Signature v4: the signature is computed per request from your access key. Use an AWS SDK or a signing helper here.'];
  }
  if (req.auth.type === 'oauth2' && req.auth.token) {
    return ['The bearer token below is the one Kurlo currently holds; it expires.'];
  }
  if (req.auth.type === 'oauth2') {
    return ['OAuth 2.0: fetch a token in Kurlo (or from your token endpoint) before running this.'];
  }
  return [];
}

const COMMENT_PREFIX: Record<string, string> = {
  curl: '#', httpie: '#', python: '#', ruby: '#', php: '//', go: '//', java: '//',
  csharp: '//', javascript: '//', node: '//', axios: '//', swift: '//', kotlin: '//', rust: '//',
};

function withAuthNotes(language: SnippetLanguage, req: SnippetRequest, code: string) {
  const notes = snippetAuthNotes(req);
  if (!notes.length) return code;
  const prefix = COMMENT_PREFIX[language] ?? '#';
  return [...notes.map(note => `${prefix} ${note}`), code].join('\n');
}

type SnippetFormField = { key: string; value: string; isFile: boolean; fileName: string };

function formFields(req: SnippetRequest): SnippetFormField[] {
  return req.formData
    .filter(row => row.enabled && row.key)
    .map(row => ({
      key: row.key,
      value: row.value,
      isFile: Boolean(row.isFile),
      fileName: row.fileName || row.value.split(/[\\/]/).pop() || row.key,
    }));
}

function snippetBodyKind(req: SnippetRequest): 'none' | 'text' | 'multipart' | 'file' {
  if (req.bodyType === 'form') return formFields(req).length ? 'multipart' : 'none';
  if (req.bodyType === 'binary') return req.bodyFilePath ? 'file' : 'none';
  return snippetBody(req) ? 'text' : 'none';
}

function snippetBody(req: SnippetRequest) {
  if (['json', 'text', 'xml', 'html', 'javascript', 'graphql'].includes(req.bodyType)) return req.body;
  if (req.bodyType === 'urlencoded') {
    const sp = new URLSearchParams();
    for (const row of req.formData) if (row.enabled && row.key) sp.append(row.key, row.value);
    return sp.toString();
  }
  return '';
}

const js = JSON.stringify;

function withBracedUnicodeEscapes(literal: string) {
  return literal.replace(/\\(?:(\\)|u([0-9a-fA-F]{4}))/g, (match, backslash: string | undefined, hex: string | undefined) => (backslash ? match : `\\u{${hex}}`));
}

const kotlinString = (value: string) => js(value).replace(/\$/g, '\\$');
const rubyString = (value: string) => js(value).replace(/#(?=[{$@])/g, '\\#');
const phpString = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const swiftString = (value: string) => withBracedUnicodeEscapes(js(value));
const rustString = (value: string) => withBracedUnicodeEscapes(js(value));

const STANDARD_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function buildFetchSnippet(req: SnippetRequest) {
  const headers = snippetHeaders(req);
  const kind = snippetBodyKind(req);
  const lines: string[] = [];
  if (kind === 'file' || (kind === 'multipart' && formFields(req).some(field => field.isFile))) lines.push("import { openAsBlob } from 'node:fs';", '');
  if (kind === 'multipart') {
    lines.push('const form = new FormData();');
    for (const field of formFields(req)) {
      lines.push(field.isFile
        ? `form.append(${js(field.key)}, await openAsBlob(${js(field.value)}), ${js(field.fileName)});`
        : `form.append(${js(field.key)}, ${js(field.value)});`);
    }
    lines.push('');
  }
  lines.push(`const response = await fetch(${js(snippetRequestUrl(req))}, {`, `  method: ${js(req.method)},`);
  if (headers.length) { lines.push('  headers: {'); for (const h of headers) lines.push(`    ${js(h.key)}: ${js(h.value)},`); lines.push('  },'); }
  if (kind === 'text') lines.push(`  body: ${js(snippetBody(req))},`);
  if (kind === 'multipart') lines.push('  body: form,');
  if (kind === 'file') lines.push(`  body: await openAsBlob(${js(req.bodyFilePath ?? '')}),`);
  lines.push('});', 'const data = await response.text();', 'console.log(data);');
  return lines.join('\n');
}

function buildPythonSnippet(req: SnippetRequest) {
  const headers = snippetHeaders(req);
  const kind = snippetBodyKind(req);
  const lines = ['import requests', '', `url = ${js(snippetRequestUrl(req))}`];
  if (headers.length) { lines.push('headers = {'); for (const h of headers) lines.push(`    ${js(h.key)}: ${js(h.value)},`); lines.push('}'); }
  const args: string[] = [];
  if (headers.length) args.push('headers=headers');
  if (kind === 'text') { lines.push(`payload = ${js(snippetBody(req))}`); args.push('data=payload'); }
  if (kind === 'file') { lines.push(`payload = open(${js(req.bodyFilePath ?? '')}, "rb")`); args.push('data=payload'); }
  if (kind === 'multipart') {
    const fields = formFields(req);
    const text = fields.filter(field => !field.isFile);
    const files = fields.filter(field => field.isFile);
    if (text.length) { lines.push('data = ['); for (const field of text) lines.push(`    (${js(field.key)}, ${js(field.value)}),`); lines.push(']'); args.push('data=data'); }
    if (files.length) { lines.push('files = ['); for (const field of files) lines.push(`    (${js(field.key)}, (${js(field.fileName)}, open(${js(field.value)}, "rb"))),`); lines.push(']'); args.push('files=files'); }
  }
  lines.push('', `response = requests.request(${js(req.method)}, url${args.map(arg => `, ${arg}`).join('')})`, 'print(response.text)');
  return lines.join('\n');
}

function buildHttpieSnippet(req: SnippetRequest) {
  const headers = snippetHeaders(req);
  const kind = snippetBodyKind(req);
  const parts = ['http'];
  if (kind === 'text' && req.bodyType === 'urlencoded') parts.push('--form');
  else if (kind === 'text') parts.push(`--raw ${shellQuote(snippetBody(req))}`);
  if (kind === 'multipart') parts.push('--multipart');
  parts.push(req.method, shellQuote(snippetRequestUrl(req)));
  for (const h of headers) {
    if (kind === 'multipart' && h.key.toLowerCase() === 'content-type') continue;
    parts.push(shellQuote(`${h.key}:${h.value}`));
  }
  if (kind === 'text' && req.bodyType === 'urlencoded') {
    for (const row of req.formData) if (row.enabled && row.key) parts.push(shellQuote(`${row.key}=${row.value}`));
  }
  if (kind === 'multipart') {
    for (const field of formFields(req)) parts.push(shellQuote(field.isFile ? `${field.key}@${field.value}` : `${field.key}=${field.value}`));
  }
  const command = parts.join(' \\\n  ');
  return kind === 'file' ? `${command} \\\n  < ${shellQuote(req.bodyFilePath ?? '')}` : command;
}

function buildGoSnippet(req: SnippetRequest) {
  const headers = snippetHeaders(req);
  const kind = snippetBodyKind(req);
  const imports = ['fmt', 'io', 'net/http'];
  if (kind === 'text') imports.push('strings');
  if (kind === 'file') imports.push('os');
  if (kind === 'multipart') imports.push('bytes', 'mime/multipart', ...(formFields(req).some(field => field.isFile) ? ['os'] : []));
  const lines = ['package main', '', 'import (', ...[...new Set(imports)].sort().map(name => `  "${name}"`), ')', '', 'func main() {'];
  if (kind === 'text') lines.push(`  payload := strings.NewReader(${js(snippetBody(req))})`);
  else if (kind === 'file') lines.push(`  payload, err := os.Open(${js(req.bodyFilePath ?? '')})`, '  if err != nil { panic(err) }', '  defer payload.Close()');
  else if (kind === 'multipart') {
    lines.push('  payload := &bytes.Buffer{}', '  writer := multipart.NewWriter(payload)');
    for (const field of formFields(req)) {
      if (field.isFile) {
        lines.push('  {', `    file, err := os.Open(${js(field.value)})`, '    if err != nil { panic(err) }', `    part, err := writer.CreateFormFile(${js(field.key)}, ${js(field.fileName)})`, '    if err != nil { panic(err) }', '    if _, err := io.Copy(part, file); err != nil { panic(err) }', '    file.Close()', '  }');
      } else {
        lines.push(`  if err := writer.WriteField(${js(field.key)}, ${js(field.value)}); err != nil { panic(err) }`);
      }
    }
    lines.push('  if err := writer.Close(); err != nil { panic(err) }');
  } else lines.push('  var payload io.Reader');
  lines.push(`  req, err := http.NewRequest(${js(req.method)}, ${js(snippetRequestUrl(req))}, payload)`, '  if err != nil { panic(err) }');
  for (const h of headers) lines.push(`  req.Header.Set(${js(h.key)}, ${js(h.value)})`);
  if (kind === 'multipart') lines.push('  req.Header.Set("Content-Type", writer.FormDataContentType())');
  lines.push('  res, err := http.DefaultClient.Do(req)', '  if err != nil { panic(err) }', '  defer res.Body.Close()', '  data, err := io.ReadAll(res.Body)', '  if err != nil { panic(err) }', '  fmt.Println(string(data))', '}');
  return lines.join('\n');
}

function okHttpMultipart(req: SnippetRequest, kotlin: boolean) {
  const str = kotlin ? kotlinString : js;
  const parts = formFields(req).map(field => field.isFile
    ? kotlin
      ? `    .addFormDataPart(${str(field.key)}, ${str(field.fileName)}, File(${str(field.value)}).asRequestBody("application/octet-stream".toMediaType()))`
      : `    .addFormDataPart(${str(field.key)}, ${str(field.fileName)}, RequestBody.create(new File(${str(field.value)}), MediaType.parse("application/octet-stream")))`
    : `    .addFormDataPart(${str(field.key)}, ${str(field.value)})`);
  return [kotlin ? 'val body = MultipartBody.Builder()' : 'RequestBody body = new MultipartBody.Builder()', '    .setType(MultipartBody.FORM)', ...parts, kotlin ? '    .build()' : '    .build();'];
}

function buildJavaSnippet(req: SnippetRequest) {
  const headers = snippetHeaders(req);
  const kind = snippetBodyKind(req);
  const ctHeader = headers.find(h => h.key.toLowerCase() === 'content-type')?.value || 'text/plain';
  const lines = ['OkHttpClient client = new OkHttpClient();'];
  if (kind === 'text') lines.push(`RequestBody body = RequestBody.create(${js(snippetBody(req))}, MediaType.parse(${js(ctHeader)}));`);
  else if (kind === 'file') lines.push(`RequestBody body = RequestBody.create(new File(${js(req.bodyFilePath ?? '')}), MediaType.parse(${js(ctHeader)}));`);
  else if (kind === 'multipart') lines.push(...okHttpMultipart(req, false));
  else lines.push('RequestBody body = null;');
  lines.push('Request request = new Request.Builder()', `    .url(${js(snippetRequestUrl(req))})`);
  for (const h of headers) lines.push(`    .addHeader(${js(h.key)}, ${js(h.value)})`);
  lines.push(`    .method(${js(req.method)}, body)`, '    .build();', 'try (Response response = client.newCall(request).execute()) {', '    System.out.println(response.body().string());', '}');
  return lines.join('\n');
}

function buildCSharpSnippet(req: SnippetRequest) {
  const headers = snippetHeaders(req);
  const kind = snippetBodyKind(req);
  const ct = headers.find(h => h.key.toLowerCase() === 'content-type')?.value || 'text/plain';
  const lines = ['using System.Net.Http.Headers;', 'using System.Text;', '', 'using var client = new HttpClient();', `using var request = new HttpRequestMessage(new HttpMethod(${js(req.method)}), ${js(snippetRequestUrl(req))});`];
  for (const h of headers) { if (h.key.toLowerCase() !== 'content-type') lines.push(`request.Headers.TryAddWithoutValidation(${js(h.key)}, ${js(h.value)});`); }
  if (kind === 'text') lines.push(`request.Content = new StringContent(${js(snippetBody(req))}, Encoding.UTF8, ${js(ct)});`);
  if (kind === 'file') lines.push(`request.Content = new StreamContent(File.OpenRead(${js(req.bodyFilePath ?? '')}));`, `request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${js(ct)});`);
  if (kind === 'multipart') {
    lines.push('var form = new MultipartFormDataContent();');
    for (const field of formFields(req)) {
      lines.push(field.isFile
        ? `form.Add(new StreamContent(File.OpenRead(${js(field.value)})), ${js(field.key)}, ${js(field.fileName)});`
        : `form.Add(new StringContent(${js(field.value)}), ${js(field.key)});`);
    }
    lines.push('request.Content = form;');
  }
  lines.push('using var response = await client.SendAsync(request);', 'Console.WriteLine(await response.Content.ReadAsStringAsync());');
  return lines.join('\n');
}

function buildPhpSnippet(req: SnippetRequest) {
  const headers = snippetHeaders(req);
  const kind = snippetBodyKind(req);
  const lines = ['$curl = curl_init();', 'curl_setopt_array($curl, [', `  CURLOPT_URL => ${phpString(snippetRequestUrl(req))},`, '  CURLOPT_RETURNTRANSFER => true,', `  CURLOPT_CUSTOMREQUEST => ${phpString(req.method)},`];
  if (kind === 'text') lines.push(`  CURLOPT_POSTFIELDS => ${phpString(snippetBody(req))},`);
  if (kind === 'file') lines.push(`  CURLOPT_POSTFIELDS => file_get_contents(${phpString(req.bodyFilePath ?? '')}),`);
  if (kind === 'multipart') {
    lines.push('  CURLOPT_POSTFIELDS => [');
    for (const field of formFields(req)) {
      lines.push(field.isFile
        ? `    ${phpString(field.key)} => new CURLFile(${phpString(field.value)}, '', ${phpString(field.fileName)}),`
        : `    ${phpString(field.key)} => ${phpString(field.value)},`);
    }
    lines.push('  ],');
  }
  if (headers.length) { lines.push('  CURLOPT_HTTPHEADER => ['); for (const h of headers) lines.push(`    ${phpString(`${h.key}: ${h.value}`)},`); lines.push('  ],'); }
  lines.push(']);', '$response = curl_exec($curl);', 'curl_close($curl);', 'echo $response;');
  return lines.join('\n');
}

function buildRubySnippet(req: SnippetRequest) {
  const headers = snippetHeaders(req);
  const kind = snippetBodyKind(req);
  const methodName = req.method[0] + req.method.slice(1).toLowerCase();
  const lines = ["require 'net/http'", "require 'uri'", '', `uri = URI(${rubyString(snippetRequestUrl(req))})`];
  lines.push(STANDARD_METHODS.includes(req.method)
    ? `request = Net::HTTP::${methodName}.new(uri)`
    : `request = Net::HTTPGenericRequest.new(${rubyString(req.method)}, ${kind === 'none' ? 'false' : 'true'}, true, uri)`);
  for (const h of headers) lines.push(`request[${rubyString(h.key)}] = ${rubyString(h.value)}`);
  if (kind === 'text') lines.push(`request.body = ${rubyString(snippetBody(req))}`);
  if (kind === 'file') lines.push(`request.body = File.binread(${rubyString(req.bodyFilePath ?? '')})`);
  if (kind === 'multipart') {
    const fields = formFields(req).map(field => field.isFile
      ? `[${rubyString(field.key)}, File.open(${rubyString(field.value)}), { filename: ${rubyString(field.fileName)} }]`
      : `[${rubyString(field.key)}, ${rubyString(field.value)}]`);
    lines.push(`request.set_form([${fields.join(', ')}], 'multipart/form-data')`);
  }
  lines.push('response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") { |http| http.request(request) }', 'puts response.body');
  return lines.join('\n');
}

function multipartQuoted(value: string) {
  return value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');
}

function buildSwiftSnippet(req: SnippetRequest) {
  const headers = snippetHeaders(req);
  const kind = snippetBodyKind(req);
  const lines = ['import Foundation', '', `var request = URLRequest(url: URL(string: ${swiftString(snippetRequestUrl(req))})!)`, `request.httpMethod = ${swiftString(req.method)}`];
  for (const h of headers) lines.push(`request.setValue(${swiftString(h.value)}, forHTTPHeaderField: ${swiftString(h.key)})`);
  if (kind === 'text') lines.push(`request.httpBody = ${swiftString(snippetBody(req))}.data(using: .utf8)`);
  if (kind === 'file') lines.push(`request.httpBody = try Data(contentsOf: URL(fileURLWithPath: ${swiftString(req.bodyFilePath ?? '')}))`);
  if (kind === 'multipart') {
    lines.push('let boundary = UUID().uuidString', 'var body = Data()');
    for (const field of formFields(req)) {
      const disposition = `Content-Disposition: form-data; name="${multipartQuoted(field.key)}"${field.isFile ? `; filename="${multipartQuoted(field.fileName)}"` : ''}\r\n\r\n`;
      lines.push(`body.append(("--\\(boundary)\\r\\n" + ${swiftString(disposition)}).data(using: .utf8)!)`);
      lines.push(field.isFile
        ? `body.append(try Data(contentsOf: URL(fileURLWithPath: ${swiftString(field.value)})))`
        : `body.append(${swiftString(field.value)}.data(using: .utf8)!)`);
      lines.push('body.append("\\r\\n".data(using: .utf8)!)');
    }
    lines.push('body.append("--\\(boundary)--\\r\\n".data(using: .utf8)!)', 'request.setValue("multipart/form-data; boundary=\\(boundary)", forHTTPHeaderField: "Content-Type")', 'request.httpBody = body');
  }
  lines.push('let (data, _) = try await URLSession.shared.data(for: request)', 'print(String(data: data, encoding: .utf8) ?? "")');
  return lines.join('\n');
}

function buildKotlinSnippet(req: SnippetRequest) {
  const headers = snippetHeaders(req);
  const kind = snippetBodyKind(req);
  const ct = headers.find(h => h.key.toLowerCase() === 'content-type')?.value || 'text/plain';
  const lines = ['val client = OkHttpClient()'];
  if (kind === 'text') lines.push(`val body = ${kotlinString(snippetBody(req))}.toRequestBody(${kotlinString(ct)}.toMediaType())`);
  else if (kind === 'file') lines.push(`val body = File(${kotlinString(req.bodyFilePath ?? '')}).asRequestBody(${kotlinString(ct)}.toMediaType())`);
  else if (kind === 'multipart') lines.push(...okHttpMultipart(req, true));
  else lines.push('val body: RequestBody? = null');
  lines.push('val request = Request.Builder()', `    .url(${kotlinString(snippetRequestUrl(req))})`);
  for (const h of headers) lines.push(`    .addHeader(${kotlinString(h.key)}, ${kotlinString(h.value)})`);
  lines.push(`    .method(${kotlinString(req.method)}, body)`, '    .build()', 'client.newCall(request).execute().use { response ->', '    println(response.body?.string())', '}');
  return lines.join('\n');
}

function buildAxiosSnippet(req: SnippetRequest) {
  const headers = snippetHeaders(req);
  const kind = snippetBodyKind(req);
  const url = snippetRequestUrl(req);
  const lines = ["import axios from 'axios';"];
  if (kind === 'file' || (kind === 'multipart' && formFields(req).some(field => field.isFile))) lines.push("import { openAsBlob } from 'node:fs';");
  lines.push('');
  if (kind === 'multipart') {
    lines.push('const form = new FormData();');
    for (const field of formFields(req)) {
      lines.push(field.isFile
        ? `form.append(${js(field.key)}, await openAsBlob(${js(field.value)}), ${js(field.fileName)});`
        : `form.append(${js(field.key)}, ${js(field.value)});`);
    }
    lines.push('');
  }
  const config: string[] = [];
  config.push(`  method: ${js(req.method.toLowerCase())},`);
  config.push(`  url: ${js(url)},`);
  if (headers.length) {
    config.push('  headers: {');
    for (const h of headers) config.push(`    ${js(h.key)}: ${js(h.value)},`);
    config.push('  },');
  }
  if (kind === 'text') config.push(`  data: ${js(snippetBody(req))},`);
  if (kind === 'file') config.push(`  data: await openAsBlob(${js(req.bodyFilePath ?? '')}),`);
  if (kind === 'multipart') config.push('  data: form,');
  lines.push('const response = await axios({');
  lines.push(...config);
  lines.push('});');
  lines.push('console.log(response.data);');
  return lines.join('\n');
}

function buildRustSnippet(req: SnippetRequest) {
  const headers = snippetHeaders(req);
  const kind = snippetBodyKind(req);
  const method = STANDARD_METHODS.includes(req.method)
    ? `reqwest::Method::${req.method}`
    : `reqwest::Method::from_bytes(${rustString(req.method)}.as_bytes())?`;
  const lines = ['let client = reqwest::Client::new();'];
  if (kind === 'multipart') {
    lines.push('let form = reqwest::multipart::Form::new()');
    for (const field of formFields(req)) {
      lines.push(field.isFile
        ? `    .part(${rustString(field.key)}, reqwest::multipart::Part::bytes(std::fs::read(${rustString(field.value)})?).file_name(${rustString(field.fileName)}))`
        : `    .text(${rustString(field.key)}, ${rustString(field.value)})`);
    }
    lines[lines.length - 1] += ';';
  }
  lines.push(`let response = client.request(${method}, ${rustString(snippetRequestUrl(req))})`);
  for (const h of headers) lines.push(`    .header(${rustString(h.key)}, ${rustString(h.value)})`);
  if (kind === 'text') lines.push(`    .body(${rustString(snippetBody(req))})`);
  if (kind === 'file') lines.push(`    .body(std::fs::read(${rustString(req.bodyFilePath ?? '')})?)`);
  if (kind === 'multipart') lines.push('    .multipart(form)');
  lines.push('    .send().await?;', 'println!("{}", response.text().await?);');
  return lines.join('\n');
}

export function buildSnippet(language: SnippetLanguage, req: SnippetRequest, curlFn: (r: SnippetRequest) => string): string {
  return withAuthNotes(language, req, buildSnippetBody(language, req, curlFn));
}

function buildSnippetBody(language: SnippetLanguage, req: SnippetRequest, curlFn: (r: SnippetRequest) => string): string {
  switch (language) {
    case 'go': return buildGoSnippet(req);
    case 'javascript': case 'node': return buildFetchSnippet(req);
    case 'python': return buildPythonSnippet(req);
    case 'java': return buildJavaSnippet(req);
    case 'csharp': return buildCSharpSnippet(req);
    case 'php': return buildPhpSnippet(req);
    case 'ruby': return buildRubySnippet(req);
    case 'swift': return buildSwiftSnippet(req);
    case 'kotlin': return buildKotlinSnippet(req);
    case 'rust': return buildRustSnippet(req);
    case 'httpie': return buildHttpieSnippet(req);
    case 'axios': return buildAxiosSnippet(req);
    default: return curlFn(req);
  }
}

function snippetTokenClass(token: string, language: SnippetLanguage) {
  if (/^['"]/.test(token)) return 'snippet-string';
  if (/^https?:\/\//.test(token)) return 'snippet-url';
  if (/^--?[A-Za-z0-9-]+$/.test(token)) return 'snippet-flag';
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(token)) return `snippet-method ${methodColor(token)}`;
  if (/^(curl|http|fetch|await|const|let|var|import|from|package|func|defer|if|err|nil|panic|return|requests|response|url|headers|payload|OkHttpClient|Request|RequestBody|HttpClient|HttpRequestMessage|HttpMethod|curl_init|curl_setopt_array|require|Net|HTTP|Foundation|URLRequest|URLSession|reqwest|Client|new|use|val|try|using|axios|method|data)$/.test(token)) return 'snippet-keyword';
  if (/^\d+$/.test(token)) return 'snippet-number';
  if (token === '\\') return 'snippet-punctuation';
  if (language === 'python' && /^(True|False|None)$/.test(token)) return 'snippet-keyword';
  return '';
}

function highlightSnippetLine(line: string, language: SnippetLanguage) {
  const tokenRE = /('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|https?:\/\/[^\s'"\\]+|--?[A-Za-z0-9-]+|\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|\b[A-Za-z_][A-Za-z0-9_]*\b|\d+|\\)/g;
  let html = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRE.exec(line)) !== null) {
    if (match.index > last) html += escapeHtml(line.slice(last, match.index));
    const token = match[0];
    const cls = snippetTokenClass(token, language);
    html += cls ? `<span class="${cls}">${escapeHtml(token)}</span>` : escapeHtml(token);
    last = match.index + token.length;
  }
  if (last < line.length) html += escapeHtml(line.slice(last));
  return html || '&nbsp;';
}

export function renderSnippetLines(source: string, language: SnippetLanguage): RenderedSnippetLine[] {
  return source.split(/\r\n|\r|\n/).map((line, idx) => ({
    number: idx + 1,
    html: highlightSnippetLine(line, language),
  }));
}
