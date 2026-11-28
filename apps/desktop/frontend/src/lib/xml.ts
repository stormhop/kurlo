export type XmlElement = {
  name: string;
  local: string;
  ns: string;
  attrs: Record<string, string>;
  scope: Record<string, string>;
  children: XmlElement[];
  text: string;
};

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? match;
  });
}

export function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

function splitName(name: string): [string, string] {
  const colon = name.indexOf(':');
  return colon < 0 ? ['', name] : [name.slice(0, colon), name.slice(colon + 1)];
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

export function parseXml(source: string): XmlElement {
  const text = source.replace(/^\uFEFF/, '');
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let index = 0;
  const fail = (message: string, at = index): never => {
    throw new Error(`Invalid XML on line ${lineOf(text, at)}: ${message}`);
  };
  const skipTo = (marker: string, from: number, what: string) => {
    const end = text.indexOf(marker, from);
    if (end < 0) fail(`unclosed ${what}`, from);
    return end + marker.length;
  };

  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (open < 0) {
      if (stack.length) stack[stack.length - 1].text += decodeXmlEntities(text.slice(index));
      break;
    }
    if (open > index && stack.length) stack[stack.length - 1].text += decodeXmlEntities(text.slice(index, open));
    if (text.startsWith('<!--', open)) {
      index = skipTo('-->', open + 4, 'comment');
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      if (end < 0) fail('unclosed CDATA section', open);
      if (stack.length) stack[stack.length - 1].text += text.slice(open + 9, end);
      index = end + 3;
      continue;
    }
    if (text.startsWith('<?', open)) {
      index = skipTo('?>', open + 2, 'processing instruction');
      continue;
    }
    if (text.startsWith('<!', open)) {
      let depth = 0;
      let cursor = open + 2;
      for (; cursor < text.length; cursor += 1) {
        const char = text[cursor];
        if (char === '[') depth += 1;
        else if (char === ']') depth -= 1;
        else if (char === '>' && depth <= 0) break;
      }
      if (cursor >= text.length) fail('unclosed declaration', open);
      index = cursor + 1;
      continue;
    }
    if (text[open + 1] === '/') {
      const end = text.indexOf('>', open);
      if (end < 0) fail('unclosed end tag', open);
      const name = text.slice(open + 2, end).trim();
      const current = stack.pop();
      if (!current || current.name !== name) fail(`unexpected </${name}>`, open);
      index = end + 1;
      continue;
    }
    let end = open + 1;
    let quote = '';
    for (; end < text.length; end += 1) {
      const char = text[end];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
    }
    if (end >= text.length) fail('unclosed start tag', open);
    let body = text.slice(open + 1, end);
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);
    const name = body.match(/^[^\s/>]+/)?.[0] ?? '';
    if (!name) fail('missing element name', open);
    if (!stack.length && root) fail('more than one root element', open);
    const attrs: Record<string, string> = {};
    const parent = stack[stack.length - 1];
    const scope: Record<string, string> = { ...(parent?.scope ?? { xml: XML_NS }) };
    for (const match of body.slice(name.length).matchAll(ATTRIBUTE)) {
      const key = match[1];
      const value = decodeXmlEntities(match[3] ?? match[4] ?? '');
      attrs[key] = value;
      if (key === 'xmlns') scope[''] = value;
      else if (key.startsWith('xmlns:')) scope[key.slice(6)] = value;
    }
    const [prefix, local] = splitName(name);
    const element: XmlElement = { name, local, ns: scope[prefix] ?? '', attrs, scope, children: [], text: '' };
    if (parent) parent.children.push(element);
    else root = element;
    if (!selfClosing) stack.push(element);
    index = end + 1;
  }
  if (stack.length) fail(`<${stack[stack.length - 1].name}> is never closed`, text.length);
  if (!root) throw new Error('Invalid XML: the document has no root element');
  return root;
}

export function resolveQName(element: XmlElement, value: string | undefined): { ns: string; local: string } | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const [prefix, local] = splitName(trimmed);
  return { ns: element.scope[prefix] ?? '', local };
}

export function childElements(element: XmlElement, ns: string, local?: string): XmlElement[] {
  return element.children.filter(child => child.ns === ns && (local === undefined || child.local === local));
}

export function firstChild(element: XmlElement, ns: string, local: string): XmlElement | undefined {
  return element.children.find(child => child.ns === ns && child.local === local);
}
