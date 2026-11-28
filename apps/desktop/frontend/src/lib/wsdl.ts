import type { KVRow, SavedRequest } from './types/models';
import { DEFAULT_REQUEST_SETTINGS, mkRow } from './constants';
import { emptyAuthState, newRequestId } from './utils';
import { filesystemNameFromName } from './normalizers';
import { childElements, escapeXmlAttribute, escapeXmlText, firstChild, parseXml, resolveQName, type XmlElement } from './xml';

export const WSDL_NS = 'http://schemas.xmlsoap.org/wsdl/';
const WSDL2_NS = 'http://www.w3.org/ns/wsdl';
const SOAP11_BINDING_NS = 'http://schemas.xmlsoap.org/wsdl/soap/';
const SOAP12_BINDING_NS = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const SOAP11_ENVELOPE_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12_ENVELOPE_NS = 'http://www.w3.org/2003/05/soap-envelope';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema';
const MAX_DEPTH = 12;
const WSA_NS = 'http://www.w3.org/2005/08/addressing';
const WSAW_NS = 'http://www.w3.org/2006/05/addressing/wsdl';
const WSAM_NS = 'http://www.w3.org/2007/05/addressing/metadata';

export type SoapVersion = '1.1' | '1.2';

type QName = { ns: string; local: string };

type MessagePart = { name: string; element: QName | null; node: XmlElement };

type BindingOperation = {
  name: string;
  soapAction: string;
  style: 'document' | 'rpc';
  bodyNamespace: string;
  bodyParts: string[] | null;
  headers: Array<{ message: QName; part: string }>;
  inputMessage: QName | null;
  documentation: string;
  targetNamespace: string;
  addressingAction: string;
};

type SoapBinding = { version: SoapVersion; addressing: boolean; operations: BindingOperation[] };

export type WsdlOperation = {
  service: string;
  port: string;
  name: string;
  soapVersion: SoapVersion;
  address: string;
  soapAction: string;
  documentation: string;
  envelope: string;
};

export type WsdlDocument = {
  name: string;
  targetNamespace: string;
  documentation: string;
  operations: WsdlOperation[];
  unresolvedImports: number;
};

type SchemaIndex = {
  elements: Map<string, XmlElement>;
  types: Map<string, XmlElement>;
  groups: Map<string, XmlElement>;
  attributeGroups: Map<string, XmlElement>;
  byLocal: Map<string, XmlElement[]>;
  schemaOf: Map<XmlElement, XmlElement>;
};

const key = (name: QName) => `{${name.ns}}${name.local}`;

function documentationOf(element: XmlElement | undefined): string {
  if (!element) return '';
  const docs = element.children.filter(child => child.local === 'documentation' || child.local === 'annotation');
  return docs.map(doc => doc.local === 'annotation' ? documentationOf(doc) : collectText(doc)).join('\n').trim();
}

function collectText(element: XmlElement): string {
  return (element.text + element.children.map(collectText).join(' ')).replace(/\s+/g, ' ').trim();
}

function indexSchemas(schemas: XmlElement[]): SchemaIndex {
  const index: SchemaIndex = { elements: new Map(), types: new Map(), groups: new Map(), attributeGroups: new Map(), byLocal: new Map(), schemaOf: new Map() };
  for (const schema of schemas) {
    const targetNamespace = schema.attrs.targetNamespace ?? '';
    const visit = (node: XmlElement) => {
      index.schemaOf.set(node, schema);
      node.children.forEach(visit);
    };
    visit(schema);
    for (const child of schema.children) {
      if (child.ns !== XSD_NS || !child.attrs.name) continue;
      const name = { ns: targetNamespace, local: child.attrs.name };
      const target = child.local === 'element' ? index.elements
        : child.local === 'complexType' || child.local === 'simpleType' ? index.types
          : child.local === 'group' ? index.groups
            : child.local === 'attributeGroup' ? index.attributeGroups
              : null;
      if (!target) continue;
      target.set(key(name), child);
      const local = `${child.local}:${name.local}`;
      index.byLocal.set(local, [...(index.byLocal.get(local) ?? []), child]);
    }
  }
  return index;
}

function lookup(index: SchemaIndex, map: Map<string, XmlElement>, kinds: string[], name: QName | null): XmlElement | undefined {
  if (!name) return undefined;
  const exact = map.get(key(name));
  if (exact) return exact;
  for (const kind of kinds) {
    const candidates = index.byLocal.get(`${kind}:${name.local}`);
    if (candidates?.length) return candidates[0];
  }
  return undefined;
}

function builtinSample(local: string): string {
  switch (local) {
    case 'boolean': return 'false';
    case 'int': case 'integer': case 'long': case 'short': case 'byte':
    case 'unsignedInt': case 'unsignedLong': case 'unsignedShort': case 'unsignedByte':
    case 'nonNegativeInteger': case 'nonPositiveInteger': case 'negativeInteger':
      return '0';
    case 'positiveInteger': return '1';
    case 'decimal': case 'double': case 'float': return '0.0';
    case 'date': return '2026-01-01';
    case 'dateTime': return '2026-01-01T00:00:00';
    case 'time': return '00:00:00';
    case 'duration': return 'P1D';
    case 'gYear': return '2026';
    case 'anyURI': return 'https://example.com';
    case 'base64Binary': case 'hexBinary': return '';
    case 'QName': return 'ns:name';
    default: return '?';
  }
}

class EnvelopeWriter {
  private prefixes = new Map<string, string>();
  private preferred: Record<string, string>;

  constructor(private index: SchemaIndex, definitions: XmlElement[]) {
    this.preferred = {};
    for (const [prefix, uri] of definitions.flatMap(entry => Object.entries(entry.scope))) {
      if (prefix && /^[A-Za-z_][\w.-]*$/.test(prefix) && !/^(soap|soap12|soapenv|wsdl|xsd?|xml|http|mime|soapenc|wsaw?|wsam|wsp|wsu|msc|tm)$/i.test(prefix) && !this.preferred[uri]) {
        this.preferred[uri] = prefix;
      }
    }
  }

  prefixFor(ns: string, fixed = ''): string {
    const existing = this.prefixes.get(ns);
    if (existing) return existing;
    const used = new Set(this.prefixes.values());
    let prefix = fixed || (this.preferred[ns] && !used.has(this.preferred[ns]) ? this.preferred[ns] : this.prefixes.size ? `ns${this.prefixes.size + 1}` : 'tns');
    while (used.has(prefix) || prefix === 'soap') prefix = `${prefix}_`;
    this.prefixes.set(ns, prefix);
    return prefix;
  }

  declarations(): string {
    return [...this.prefixes].map(([ns, prefix]) => ` xmlns:${prefix}="${escapeXmlAttribute(ns)}"`).join('');
  }

  qualified(name: string, ns: string): string {
    return ns ? `${this.prefixFor(ns)}:${name}` : name;
  }

  globalElement(decl: XmlElement, depth: number, seen: Set<XmlElement>): string[] {
    const schema = this.index.schemaOf.get(decl);
    return this.elementDecl(decl, depth, seen, schema?.attrs.targetNamespace ?? '');
  }

  elementDecl(decl: XmlElement, depth: number, seen: Set<XmlElement>, ns: string): string[] {
    const name = decl.attrs.name ?? '';
    const pad = '  '.repeat(depth);
    if (!name) return [];
    const tag = this.qualified(name, ns);
    if (seen.has(decl) || depth > MAX_DEPTH) return [`${pad}<${tag}/>`];
    const next = new Set(seen).add(decl);
    const value = decl.attrs.fixed ?? decl.attrs.default;
    const inlineComplex = firstChild(decl, XSD_NS, 'complexType');
    const inlineSimple = firstChild(decl, XSD_NS, 'simpleType');
    const typeName = resolveQName(decl, decl.attrs.type);
    let typeDecl: XmlElement | undefined = inlineComplex ?? inlineSimple;
    if (!typeDecl && typeName && typeName.ns !== XSD_NS) typeDecl = lookup(this.index, this.index.types, ['complexType', 'simpleType'], typeName);
    if (!typeDecl) {
      const sample = value ?? (typeName ? builtinSample(typeName.local) : '?');
      return [`${pad}<${tag}>${escapeXmlText(sample)}</${tag}>`];
    }
    if (typeDecl.local === 'simpleType') {
      return [`${pad}<${tag}>${escapeXmlText(value ?? this.simpleSample(typeDecl, new Set()))}</${tag}>`];
    }
    const content = this.complexContent(typeDecl, depth + 1, next);
    const attrs = content.attributes.length ? ' ' + content.attributes.join(' ') : '';
    if (content.text !== null) return [`${pad}<${tag}${attrs}>${escapeXmlText(value ?? content.text)}</${tag}>`];
    if (!content.lines.length) return [`${pad}<${tag}${attrs}/>`];
    return [`${pad}<${tag}${attrs}>`, ...content.lines, `${pad}</${tag}>`];
  }

  private simpleSample(decl: XmlElement, seen: Set<XmlElement>): string {
    if (seen.has(decl)) return '?';
    seen.add(decl);
    const restriction = firstChild(decl, XSD_NS, 'restriction');
    if (restriction) {
      const enumeration = firstChild(restriction, XSD_NS, 'enumeration');
      if (enumeration?.attrs.value !== undefined) return enumeration.attrs.value;
      return this.typeSample(restriction, restriction.attrs.base, seen);
    }
    const list = firstChild(decl, XSD_NS, 'list');
    if (list) return this.typeSample(list, list.attrs.itemType, seen);
    const union = firstChild(decl, XSD_NS, 'union');
    if (union) {
      const first = union.attrs.memberTypes?.trim().split(/\s+/)[0];
      return this.typeSample(union, first, seen);
    }
    return '?';
  }

  private typeSample(context: XmlElement, raw: string | undefined, seen: Set<XmlElement>): string {
    const name = resolveQName(context, raw);
    if (!name) {
      const inline = firstChild(context, XSD_NS, 'simpleType');
      return inline ? this.simpleSample(inline, seen) : '?';
    }
    if (name.ns === XSD_NS) return builtinSample(name.local);
    const found = lookup(this.index, this.index.types, ['simpleType', 'complexType'], name);
    return found?.local === 'simpleType' ? this.simpleSample(found, seen) : builtinSample(name.local);
  }

  private complexContent(decl: XmlElement, depth: number, seen: Set<XmlElement>): { lines: string[]; attributes: string[]; text: string | null } {
    const result = { lines: [] as string[], attributes: [] as string[], text: null as string | null };
    const simpleContent = firstChild(decl, XSD_NS, 'simpleContent');
    if (simpleContent) {
      const derivation = firstChild(simpleContent, XSD_NS, 'extension') ?? firstChild(simpleContent, XSD_NS, 'restriction');
      if (derivation) {
        result.text = this.typeSample(derivation, derivation.attrs.base, new Set());
        result.attributes.push(...this.attributes(derivation, seen));
      } else {
        result.text = '?';
      }
      return result;
    }
    const complexContent = firstChild(decl, XSD_NS, 'complexContent');
    if (complexContent) {
      const extension = firstChild(complexContent, XSD_NS, 'extension');
      const restriction = firstChild(complexContent, XSD_NS, 'restriction');
      if (extension) {
        const base = lookup(this.index, this.index.types, ['complexType'], resolveQName(extension, extension.attrs.base));
        if (base && base.local === 'complexType' && !seen.has(base)) {
          const inherited = this.complexContent(base, depth, new Set(seen).add(base));
          result.lines.push(...inherited.lines);
          result.attributes.push(...inherited.attributes);
        }
        result.lines.push(...this.particles(extension, depth, seen));
        result.attributes.push(...this.attributes(extension, seen));
      } else if (restriction) {
        result.lines.push(...this.particles(restriction, depth, seen));
        result.attributes.push(...this.attributes(restriction, seen));
      }
      return result;
    }
    result.lines.push(...this.particles(decl, depth, seen));
    result.attributes.push(...this.attributes(decl, seen));
    if (!result.lines.length && decl.attrs.mixed === 'true') result.text = '?';
    return result;
  }

  private particles(container: XmlElement, depth: number, seen: Set<XmlElement>): string[] {
    const lines: string[] = [];
    for (const child of container.children) {
      if (child.ns !== XSD_NS) continue;
      if (child.local === 'sequence' || child.local === 'all') lines.push(...this.particles(child, depth, seen));
      else if (child.local === 'choice') lines.push(...this.choice(child, depth, seen));
      else if (child.local === 'group') lines.push(...this.groupRef(child, depth, seen));
      else if (child.local === 'element') lines.push(...this.particleElement(child, depth, seen));
    }
    return lines;
  }

  private choice(choice: XmlElement, depth: number, seen: Set<XmlElement>): string[] {
    const options = choice.children.filter(child => child.ns === XSD_NS && ['element', 'sequence', 'group', 'choice'].includes(child.local));
    if (!options.length) return [];
    const pad = '  '.repeat(depth);
    const names = options.map(option => option.attrs.name ?? resolveQName(option, option.attrs.ref)?.local ?? option.local);
    const first = options[0];
    const lines = first.local === 'element' ? this.particleElement(first, depth, seen)
      : first.local === 'group' ? this.groupRef(first, depth, seen)
        : first.local === 'choice' ? this.choice(first, depth, seen)
          : this.particles(first, depth, seen);
    return options.length > 1 ? [`${pad}<!--Choice of: ${names.join(', ')}-->`, ...lines] : lines;
  }

  private groupRef(ref: XmlElement, depth: number, seen: Set<XmlElement>): string[] {
    const group = ref.attrs.ref ? lookup(this.index, this.index.groups, ['group'], resolveQName(ref, ref.attrs.ref)) : ref;
    if (!group || seen.has(group)) return [];
    return this.particles(group, depth, new Set(seen).add(group));
  }

  private particleElement(decl: XmlElement, depth: number, seen: Set<XmlElement>): string[] {
    if (decl.attrs.maxOccurs === '0') return [];
    const pad = '  '.repeat(depth);
    const optional = decl.attrs.minOccurs === '0' ? [`${pad}<!--Optional:-->`] : [];
    if (decl.attrs.ref) {
      const target = lookup(this.index, this.index.elements, ['element'], resolveQName(decl, decl.attrs.ref));
      if (!target) {
        const name = resolveQName(decl, decl.attrs.ref)!;
        const tag = this.qualified(name.local, name.ns);
        return [...optional, `${pad}<${tag}>?</${tag}>`];
      }
      return [...optional, ...this.globalElement(target, depth, seen)];
    }
    const schema = this.index.schemaOf.get(decl);
    const form = decl.attrs.form ?? schema?.attrs.elementFormDefault ?? 'unqualified';
    const ns = form === 'qualified' ? schema?.attrs.targetNamespace ?? '' : '';
    return [...optional, ...this.elementDecl(decl, depth, seen, ns)];
  }

  private attributes(container: XmlElement, seen: Set<XmlElement>): string[] {
    const result: string[] = [];
    for (const child of container.children) {
      if (child.ns !== XSD_NS) continue;
      if (child.local === 'attributeGroup') {
        const group = lookup(this.index, this.index.attributeGroups, ['attributeGroup'], resolveQName(child, child.attrs.ref));
        if (group && !seen.has(group)) result.push(...this.attributes(group, new Set(seen).add(group)));
        continue;
      }
      if (child.local !== 'attribute' || child.attrs.use === 'prohibited') continue;
      const refName = resolveQName(child, child.attrs.ref);
      const name = child.attrs.name ?? refName?.local;
      if (!name) continue;
      const inline = firstChild(child, XSD_NS, 'simpleType');
      const value = child.attrs.fixed ?? child.attrs.default
        ?? (inline ? this.simpleSample(inline, new Set()) : this.typeSample(child, child.attrs.type, new Set()));
      const attrName = refName && refName.ns ? this.qualified(name, refName.ns) : name;
      result.push(`${attrName}="${escapeXmlAttribute(value)}"`);
    }
    return result;
  }
}

function addressingActionOf(input: XmlElement): string {
  for (const [name, value] of Object.entries(input.attrs)) {
    const colon = name.indexOf(':');
    if (colon < 0 || name.slice(colon + 1) !== 'Action') continue;
    const ns = input.scope[name.slice(0, colon)];
    if (ns === WSAW_NS || ns === WSAM_NS) return value;
  }
  return '';
}

function declaresAddressing(node: XmlElement): boolean {
  if ((node.ns === WSAW_NS && node.local === 'UsingAddressing') || (node.ns === WSAM_NS && node.local === 'Addressing')) return true;
  return node.children.some(declaresAddressing);
}

function policyIds(node: XmlElement, ids: Map<string, XmlElement>) {
  if (node.local === 'Policy') {
    const id = Object.entries(node.attrs).find(([name]) => name === 'Id' || name.endsWith(':Id'))?.[1];
    if (id) ids.set(id, node);
  }
  node.children.forEach(child => policyIds(child, ids));
}

function bindingUsesAddressing(binding: XmlElement, policies: Map<string, XmlElement>): boolean {
  return binding.children.some(child => {
    if (declaresAddressing(child)) return true;
    if (child.local !== 'PolicyReference') return false;
    const policy = policies.get((child.attrs.URI ?? '').replace(/^#/, ''));
    return Boolean(policy && declaresAddressing(policy));
  });
}

function readBindingOperation(operation: XmlElement, soapNs: string, defaultStyle: 'document' | 'rpc', portOperation: XmlElement | undefined, targetNamespace: string): BindingOperation {
  const soapOperation = firstChild(operation, soapNs, 'operation');
  const input = firstChild(operation, WSDL_NS, 'input');
  const body = input ? firstChild(input, soapNs, 'body') : undefined;
  const style = (soapOperation?.attrs.style ?? defaultStyle) === 'rpc' ? 'rpc' : 'document';
  const headers = input ? childElements(input, soapNs, 'header').map(header => ({
    message: resolveQName(header, header.attrs.message),
    part: header.attrs.part ?? '',
  })).filter((header): header is { message: QName; part: string } => Boolean(header.message && header.part)) : [];
  const portInput = portOperation ? firstChild(portOperation, WSDL_NS, 'input') : undefined;
  return {
    name: operation.attrs.name ?? '',
    soapAction: soapOperation?.attrs.soapAction ?? '',
    style,
    bodyNamespace: body?.attrs.namespace ?? '',
    bodyParts: body?.attrs.parts !== undefined ? body.attrs.parts.trim().split(/\s+/).filter(Boolean) : null,
    headers,
    inputMessage: portInput ? resolveQName(portInput, portInput.attrs.message) : null,
    addressingAction: (portInput && addressingActionOf(portInput)) || soapOperation?.attrs.soapAction || '',
    documentation: documentationOf(portOperation) || documentationOf(operation),
    targetNamespace,
  };
}

function readMessages(messages: Map<string, MessagePart[]>, definitions: XmlElement) {
  const targetNamespace = definitions.attrs.targetNamespace ?? '';
  for (const message of childElements(definitions, WSDL_NS, 'message')) {
    const parts = childElements(message, WSDL_NS, 'part').map(part => ({
      name: part.attrs.name ?? '',
      element: resolveQName(part, part.attrs.element),
      node: part,
    }));
    messages.set(key({ ns: targetNamespace, local: message.attrs.name ?? '' }), parts);
  }
}

function findByName(map: Map<string, MessagePart[]>, name: QName | null): MessagePart[] {
  if (!name) return [];
  const exact = map.get(key(name));
  if (exact) return exact;
  for (const [entry, parts] of map) if (entry.endsWith(`}${name.local}`)) return parts;
  return [];
}

function renderPart(writer: EnvelopeWriter, index: SchemaIndex, part: MessagePart, depth: number): string[] {
  if (part.element) {
    const decl = lookup(index, index.elements, ['element'], part.element);
    if (decl) return writer.globalElement(decl, depth, new Set());
    const tag = writer.qualified(part.element.local, part.element.ns);
    return [`${'  '.repeat(depth)}<${tag}>?</${tag}>`];
  }
  const decl: XmlElement = { name: 'element', local: 'element', ns: XSD_NS, attrs: { name: part.name, type: part.node.attrs.type ?? 'xsd:string' }, scope: { ...part.node.scope, xsd: XSD_NS }, children: [], text: '' };
  return writer.elementDecl(decl, depth, new Set(), '');
}

function buildEnvelope(definitions: XmlElement[], index: SchemaIndex, messages: Map<string, MessagePart[]>, operation: BindingOperation, version: SoapVersion, addressing: { to: string } | null): string {
  const writer = new EnvelopeWriter(index, definitions);
  const envelopeNs = version === '1.2' ? SOAP12_ENVELOPE_NS : SOAP11_ENVELOPE_NS;
  const parts = findByName(messages, operation.inputMessage);
  const bodyParts = operation.bodyParts ? parts.filter(part => operation.bodyParts!.includes(part.name)) : parts;
  const headerParts = operation.headers.flatMap(header => findByName(messages, header.message).filter(part => part.name === header.part));
  let bodyLines: string[];
  if (operation.style === 'rpc') {
    const ns = operation.bodyNamespace || operation.targetNamespace;
    const wrapper = writer.qualified(operation.name, ns);
    const inner = bodyParts.flatMap(part => renderPart(writer, index, part, 3));
    bodyLines = inner.length ? ['    <' + wrapper + '>', ...inner, '    </' + wrapper + '>'] : [`    <${wrapper}/>`];
  } else {
    bodyLines = bodyParts.flatMap(part => renderPart(writer, index, part, 2));
  }
  const headerLines = headerParts.flatMap(part => renderPart(writer, index, part, 2));
  if (addressing) {
    const wsa = writer.prefixFor(WSA_NS, 'wsa');
    headerLines.unshift(
      `    <${wsa}:Action soap:mustUnderstand="1">${escapeXmlText(operation.addressingAction)}</${wsa}:Action>`,
      `    <${wsa}:To soap:mustUnderstand="1">${escapeXmlText(addressing.to)}</${wsa}:To>`,
    );
  }
  const header = headerLines.length ? ['  <soap:Header>', ...headerLines, '  </soap:Header>'] : ['  <soap:Header/>'];
  const body = bodyLines.length ? ['  <soap:Body>', ...bodyLines, '  </soap:Body>'] : ['  <soap:Body/>'];
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<soap:Envelope xmlns:soap="${envelopeNs}"${writer.declarations()}>`,
    ...header,
    ...body,
    '</soap:Envelope>',
    '',
  ].join('\n');
}

export type WsdlSources = { base: string; documents: Map<string, string>; redirects?: Map<string, string> };

export type WsdlLoader = (url: string) => Promise<string | { text: string; url: string }>;

const MAX_IMPORTED_DOCUMENTS = 100;

function resolveLocation(location: string, base: string): string {
  try {
    return new URL(location, base || undefined).toString();
  } catch {
    return location;
  }
}

function importedLocations(root: XmlElement): string[] {
  const found: string[] = [];
  const visit = (node: XmlElement) => {
    if (node.ns === WSDL_NS && node.local === 'import' && node.attrs.location) found.push(node.attrs.location);
    if (node.ns === XSD_NS && ['import', 'include', 'redefine'].includes(node.local) && node.attrs.schemaLocation) found.push(node.attrs.schemaLocation);
    node.children.forEach(visit);
  };
  visit(root);
  return found;
}

function isRemote(url: string): boolean {
  return /^https?:/i.test(url);
}

export async function loadWsdlImports(text: string, base: string, load: WsdlLoader): Promise<WsdlSources> {
  const documents = new Map<string, string>();
  const redirects = new Map<string, string>();
  const queue: Array<{ text: string; base: string }> = [{ text, base }];
  const seen = new Set([base]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const location of importedLocations(parseXml(current.text))) {
      const url = resolveLocation(location, current.base);
      if (seen.has(url)) continue;
      seen.add(url);
      if (isRemote(base) && !isRemote(url)) throw new Error(`The WSDL imports ${location}, which is not an http or https address.`);
      if (documents.size >= MAX_IMPORTED_DOCUMENTS) throw new Error(`The WSDL imports more than ${MAX_IMPORTED_DOCUMENTS} files.`);
      let imported: string;
      let finalUrl = url;
      try {
        const loaded = await load(url);
        imported = typeof loaded === 'string' ? loaded : loaded.text;
        if (typeof loaded !== 'string' && loaded.url && loaded.url !== url) {
          finalUrl = loaded.url;
          redirects.set(url, finalUrl);
          seen.add(finalUrl);
        }
      } catch (err) {
        throw new Error(`Kurlo could not load ${location}, which the WSDL imports: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      try {
        parseXml(imported);
      } catch (err) {
        throw new Error(`${location}, which the WSDL imports, is not valid XML: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      documents.set(finalUrl, imported);
      queue.push({ text: imported, base: finalUrl });
    }
  }
  return { base, documents, redirects };
}

function collectDocuments(root: XmlElement, sources: WsdlSources | undefined) {
  const definitions: XmlElement[] = [];
  const schemas: XmlElement[] = [];
  const visited = new Set<string>();
  let unresolved = 0;
  const open = (location: string, base: string): { node: XmlElement; url: string } | null => {
    const requested = resolveLocation(location, base);
    const url = sources?.redirects?.get(requested) ?? requested;
    const text = sources?.documents.get(url);
    if (text === undefined) {
      unresolved += 1;
      return null;
    }
    if (visited.has(url)) return null;
    visited.add(url);
    return { node: parseXml(text), url };
  };
  const addSchema = (schema: XmlElement, base: string, chameleonNamespace?: string) => {
    if (schema.attrs.targetNamespace === undefined && chameleonNamespace !== undefined) schema.attrs.targetNamespace = chameleonNamespace;
    schemas.push(schema);
    for (const child of schema.children) {
      if (child.ns !== XSD_NS || !['import', 'include', 'redefine'].includes(child.local) || !child.attrs.schemaLocation) continue;
      const opened = open(child.attrs.schemaLocation, base);
      if (!opened || opened.node.ns !== XSD_NS || opened.node.local !== 'schema') continue;
      addSchema(opened.node, opened.url, child.local === 'import' ? undefined : schema.attrs.targetNamespace ?? '');
    }
  };
  const addDefinitions = (node: XmlElement, base: string) => {
    definitions.push(node);
    for (const types of childElements(node, WSDL_NS, 'types')) {
      for (const schema of childElements(types, XSD_NS, 'schema')) addSchema(schema, base);
    }
    for (const entry of childElements(node, WSDL_NS, 'import')) {
      if (!entry.attrs.location) continue;
      const opened = open(entry.attrs.location, base);
      if (!opened) continue;
      if (opened.node.ns === WSDL_NS && opened.node.local === 'definitions') addDefinitions(opened.node, opened.url);
      else if (opened.node.ns === XSD_NS && opened.node.local === 'schema') addSchema(opened.node, opened.url);
    }
  };
  if (sources) visited.add(sources.base);
  addDefinitions(root, sources?.base ?? '');
  return { definitions, schemas, unresolved };
}

export function parseWsdlDocument(text: string, sources?: WsdlSources): WsdlDocument {
  const root = parseXml(text);
  if (root.ns === WSDL2_NS) throw new Error('WSDL 2.0 is not supported yet. Export the service as WSDL 1.1 and import that file.');
  if (root.ns !== WSDL_NS || root.local !== 'definitions') throw new Error('Expected a WSDL 1.1 document with a <wsdl:definitions> root');
  const { definitions, schemas, unresolved } = collectDocuments(root, sources);
  const index = indexSchemas(schemas);
  const messages = new Map<string, MessagePart[]>();
  const portTypes = new Map<string, Map<string, XmlElement>>();
  const bindings = new Map<string, SoapBinding>();
  const policies = new Map<string, XmlElement>();
  for (const document of definitions) policyIds(document, policies);
  for (const document of definitions) {
    const targetNamespace = document.attrs.targetNamespace ?? '';
    readMessages(messages, document);
    for (const portType of childElements(document, WSDL_NS, 'portType')) {
      const operations = new Map(childElements(portType, WSDL_NS, 'operation').map(operation => [operation.attrs.name ?? '', operation] as const));
      portTypes.set(key({ ns: targetNamespace, local: portType.attrs.name ?? '' }), operations);
    }
  }
  for (const document of definitions) {
    const targetNamespace = document.attrs.targetNamespace ?? '';
    for (const binding of childElements(document, WSDL_NS, 'binding')) {
      const soapNs = firstChild(binding, SOAP12_BINDING_NS, 'binding') ? SOAP12_BINDING_NS : firstChild(binding, SOAP11_BINDING_NS, 'binding') ? SOAP11_BINDING_NS : '';
      if (!soapNs) continue;
      const soapBinding = firstChild(binding, soapNs, 'binding')!;
      const style = soapBinding.attrs.style === 'rpc' ? 'rpc' : 'document';
      const portTypeName = resolveQName(binding, binding.attrs.type);
      const portOperations = portTypeName ? portTypes.get(key(portTypeName)) ?? [...portTypes].find(([entry]) => entry.endsWith(`}${portTypeName.local}`))?.[1] : undefined;
      const operations = childElements(binding, WSDL_NS, 'operation').map(operation => readBindingOperation(operation, soapNs, style, portOperations?.get(operation.attrs.name ?? ''), targetNamespace));
      bindings.set(key({ ns: targetNamespace, local: binding.attrs.name ?? '' }), { version: soapNs === SOAP12_BINDING_NS ? '1.2' : '1.1', addressing: bindingUsesAddressing(binding, policies), operations });
    }
  }
  const operations: WsdlOperation[] = [];
  for (const service of definitions.flatMap(document => childElements(document, WSDL_NS, 'service'))) {
    for (const port of childElements(service, WSDL_NS, 'port')) {
      const bindingName = resolveQName(port, port.attrs.binding);
      const binding = bindingName ? bindings.get(key(bindingName)) ?? [...bindings].find(([entry]) => entry.endsWith(`}${bindingName.local}`))?.[1] : undefined;
      if (!binding) continue;
      const address = firstChild(port, binding.version === '1.2' ? SOAP12_BINDING_NS : SOAP11_BINDING_NS, 'address')
        ?? firstChild(port, SOAP11_BINDING_NS, 'address') ?? firstChild(port, SOAP12_BINDING_NS, 'address');
      for (const operation of binding.operations) {
        operations.push({
          service: service.attrs.name ?? '',
          port: port.attrs.name ?? '',
          name: operation.name,
          soapVersion: binding.version,
          address: address?.attrs.location ?? '',
          soapAction: operation.soapAction,
          documentation: operation.documentation,
          envelope: buildEnvelope(definitions, index, messages, operation, binding.version, binding.addressing ? { to: address?.attrs.location ?? '' } : null),
        });
      }
    }
  }
  if (!operations.length) {
    throw new Error(unresolved
      ? 'No SOAP operations found. The service is declared in files this WSDL imports, which Kurlo could not read: import it from its URL, or keep the imported files next to it.'
      : 'No SOAP operations found in the WSDL');
  }
  return {
    name: root.attrs.name ?? '',
    targetNamespace: root.attrs.targetNamespace ?? '',
    documentation: documentationOf(root),
    operations,
    unresolvedImports: unresolved,
  };
}

export function wsdlCollectionName(wsdl: WsdlDocument, fileName: string): string {
  const services = [...new Set(wsdl.operations.map(operation => operation.service).filter(Boolean))];
  return wsdl.name || (services.length === 1 ? services[0] : '') || fileName.replace(/\?wsdl$/i, '').replace(/\.(wsdl|xml)$/i, '') || 'SOAP Service';
}

export function wsdlNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).at(-1) ?? '';
    return last.replace(/\.(wsdl|xml|asmx|svc)$/i, '') || parsed.hostname;
  } catch {
    return '';
  }
}

function header(key: string, value: string): KVRow {
  return { ...mkRow(), key, value, enabled: true };
}

export function soapHeaders(version: SoapVersion, soapAction: string): KVRow[] {
  if (version === '1.2') {
    return [header('Content-Type', `application/soap+xml; charset=utf-8${soapAction ? `; action="${soapAction}"` : ''}`)];
  }
  return [header('Content-Type', 'text/xml; charset=utf-8'), header('SOAPAction', `"${soapAction}"`)];
}

export function wsdlRequests(wsdl: WsdlDocument, collectionId: string, collectionName: string): SavedRequest[] {
  const services = new Set(wsdl.operations.map(operation => operation.service));
  const ports = new Set(wsdl.operations.map(operation => `${operation.service}\u0000${operation.port}`));
  return wsdl.operations.map(operation => {
    const id = newRequestId();
    const folderPath = ports.size <= 1 ? [] : services.size > 1 ? [operation.service, operation.port].filter(Boolean) : [operation.port].filter(Boolean);
    const notes = [operation.documentation, `SOAP ${operation.soapVersion} · ${operation.service}${operation.port ? ` / ${operation.port}` : ''}`].filter(Boolean).join('\n\n');
    return {
      id,
      name: operation.name,
      filesystemName: filesystemNameFromName(operation.name, id),
      collectionId,
      collection: collectionName,
      folderPath,
      requestType: 'http',
      method: 'POST',
      url: operation.address,
      requestTab: 'body',
      params: [],
      headers: soapHeaders(operation.soapVersion, operation.soapAction),
      auth: emptyAuthState(),
      bodyType: 'xml',
      rawBodyType: 'xml',
      bodyContent: operation.envelope,
      bodyFilePath: '',
      bodyFileName: '',
      formRows: [],
      preRequestScriptJs: '',
      testScriptJs: '',
      requestNotes: notes,
      settings: { ...DEFAULT_REQUEST_SETTINGS },
    };
  });
}
