import type { BodyVariant, SavedRequest } from './types/models';
import { cloneRowsForStore, normalizeBodyTypeForUi, normalizeRawBodyTypeForUi, restoreRows } from './utils';

type BodyFields = Pick<SavedRequest, Exclude<keyof BodyVariant, 'name'>>;
type BodyEditor = BodyFields & { activeBodyVariant: string; bodyVariants: BodyVariant[] };

export const MAX_BODY_VARIANTS = 5;

export function bodyVariantLimitReached(editor: Pick<BodyEditor, 'activeBodyVariant' | 'bodyVariants'>) {
  return editor.bodyVariants.length + Number(Boolean(editor.activeBodyVariant)) >= MAX_BODY_VARIANTS;
}

function namedBody(name: string, body: Partial<BodyFields>, bodyType: BodyVariant['bodyType']): BodyVariant {
  return {
    name,
    bodyType,
    rawBodyType: normalizeRawBodyTypeForUi(body.rawBodyType ?? bodyType),
    bodyContent: typeof body.bodyContent === 'string' ? body.bodyContent : '',
    bodyFilePath: typeof body.bodyFilePath === 'string' ? body.bodyFilePath : '',
    bodyFileName: typeof body.bodyFileName === 'string' ? body.bodyFileName : '',
    formRows: cloneRowsForStore(Array.isArray(body.formRows) ? body.formRows : []),
  };
}

export function normalizeBodyVariants(request: Partial<SavedRequest>): Partial<Pick<SavedRequest, 'activeBodyVariant' | 'bodyVariants'>> {
  const active = request.activeBodyVariant?.trim();
  if (!active) return {};
  const names = new Set([active]);
  const variants: BodyVariant[] = [];
  for (const item of request.bodyVariants ?? []) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const bodyType = normalizeBodyTypeForUi(item?.bodyType);
    if (!name || names.has(name) || bodyType === 'graphql') continue;
    names.add(name);
    variants.push(namedBody(name, item, bodyType));
  }
  return { activeBodyVariant: active, bodyVariants: variants };
}

export function copyBodyVariant(editor: BodyEditor, name: string) {
  const { bodyType } = editor;
  if (bodyType === 'graphql' || bodyVariantLimitReached(editor)) return;
  if (editor.activeBodyVariant) {
    editor.bodyVariants = [...editor.bodyVariants, namedBody(editor.activeBodyVariant, editor, bodyType)];
  }
  editor.activeBodyVariant = name;
}

export function selectBodyVariant(editor: BodyEditor, name: string, discardCurrent = false) {
  const next = editor.bodyVariants.find(body => body.name === name);
  const { bodyType } = editor;
  if (!next || bodyType === 'graphql') return;
  editor.bodyVariants = discardCurrent
    ? editor.bodyVariants.filter(body => body.name !== name)
    : editor.bodyVariants.map(body => body.name === name ? namedBody(editor.activeBodyVariant, editor, bodyType) : body);
  editor.activeBodyVariant = next.name;
  editor.bodyType = next.bodyType;
  editor.rawBodyType = next.rawBodyType;
  editor.bodyContent = next.bodyContent;
  editor.bodyFilePath = next.bodyFilePath;
  editor.bodyFileName = next.bodyFileName;
  editor.formRows = restoreRows(next.formRows);
}
