import { parseYaml } from './yaml';

export type ImportSource = 'bruno' | 'postman' | 'insomnia' | 'openapi' | 'har' | 'httpfile';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return parseYaml(text);
    } catch {
      return null;
    }
  }
}

function sourceFromDocument(document: unknown): ImportSource | null {
  if (!isRecord(document)) return null;
  if (typeof document.openapi === 'string' || typeof document.swagger === 'string') return 'openapi';
  if (isRecord(document.log) && Array.isArray(document.log.entries)) return 'har';
  if (document._type === 'export' || document.__export_format !== undefined) return 'insomnia';
  if (isRecord(document.info) && (document.info._postman_id !== undefined || /postman/i.test(String(document.info.schema ?? '')))) return 'postman';
  if (document._postman_variable_scope !== undefined || document._postman_exported_using !== undefined) return 'postman';
  return null;
}

export function detectImportSource(fileName: string, text: string): ImportSource | null {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (extension === 'http' || extension === 'rest') return 'httpfile';
  if (extension === 'bru') return 'bruno';
  const fromDocument = sourceFromDocument(parseDocument(text));
  if (fromDocument === 'insomnia' && !text.trimStart().startsWith('{')) return null;
  if (fromDocument) return fromDocument;
  if (extension === 'har') return 'har';
  return null;
}
