import { yamlLanguage } from '@codemirror/lang-yaml';
import { DocInput, syntaxTree } from '@codemirror/language';
import { EditorState, Prec, StateEffect, Text } from '@codemirror/state';
import { Decoration, ViewPlugin, WidgetType, type EditorView, type ViewUpdate } from '@codemirror/view';
import { TreeFragment, type ChangedRange, type SyntaxNode, type Tree } from '@lezer/common';

const envelopeFields = new Map([
  ['version', 'version identifies the Kurlo file format.'],
  ['order', 'order is managed by the collection.'],
  ['request', 'request contains the request definition.'],
]);

const requestFields = new Map([
  ['id', 'id links this request to its saved examples, history and secrets.'],
  ['collectionId', 'Move the request in the sidebar to change its collection.'],
  ['filesystemName', 'filesystemName identifies the request file on disk.'],
]);

type ManagedField = { key: string; from: number; to: number; value: string; hint: string };

export function unquoteYamlScalar(text: string) {
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return String(JSON.parse(text)); } catch { return text; }
  }
  return text;
}

function managedFields(doc: Text, tree: Tree) {
  const fields: ManagedField[] = [];
  const document = tree.topNode.getChild('Document');
  const root = document?.getChild('BlockMapping') ?? document?.getChild('FlowMapping');

  function readMapping(mapping: SyntaxNode, envelope: boolean) {
    const descriptions = envelope ? envelopeFields : requestFields;
    for (const pair of mapping.getChildren('Pair')) {
      const keyNode = pair.getChild('Key');
      const colon = pair.getChild(':');
      if (!keyNode || !colon) continue;
      const key = unquoteYamlScalar(doc.sliceString(keyNode.from, keyNode.to));
      const hint = descriptions.get(key);
      if (!hint) continue;
      let value = colon.nextSibling;
      while (value?.name === 'Comment') value = value.nextSibling;
      const isRequest = envelope && key === 'request';
      const isMapping = value?.name === 'BlockMapping' || value?.name === 'FlowMapping';
      const scalar = value && !isRequest ? doc.sliceString(value.from, value.to) : '';
      fields.push({
        key, from: keyNode.from, to: isRequest ? colon.to : value?.to ?? colon.to,
        value: isRequest && isMapping ? 'mapping' : envelope ? scalar : unquoteYamlScalar(scalar),
        hint: 'Managed by Kurlo. ' + hint,
      });
      if (isRequest && value && isMapping) readMapping(value, false);
    }
  }
  if (root) readMapping(root, true);
  return fields;
}

const blocked = StateEffect.define<string>();

function insideKey(node: SyntaxNode | null) {
  while (node && node.name !== 'Pair') {
    if (node.name === 'Key') return true;
    node = node.parent;
  }
  return false;
}

class FieldLock extends WidgetType {
  constructor(readonly hint: string) { super(); }
  eq(other: FieldLock) { return this.hint === other.hint; }
  toDOM() {
    const lock = document.createElement('span');
    lock.className = 'cm-kurlo-field-lock';
    lock.title = this.hint;
    lock.setAttribute('aria-hidden', 'true');
    return lock;
  }
}

export function requestFileEditor(savedContent: () => string, onHint: (message: string) => void) {
  let lastSaved: string | undefined;
  let originals = new Map<string, string>();

  function currentFields(state: EditorState) {
    const saved = savedContent();
    if (saved !== lastSaved) {
      lastSaved = saved;
      const doc = Text.of(saved.split(/\r\n?|\n/));
      const fields = managedFields(doc, yamlLanguage.parser.parse(new DocInput(doc)));
      originals = new Map(fields.map(field => [field.key, field.value]));
    }
    return managedFields(state.doc, syntaxTree(state));
  }

  function marks(view: EditorView) {
    const locked = currentFields(view.state).filter(field => originals.get(field.key) === field.value);
    return Decoration.set(locked.flatMap(field => [
      Decoration.mark({
        class: 'cm-kurlo-managed-field',
        attributes: { title: field.hint, 'aria-description': field.hint },
      }).range(field.from, field.to),
      Decoration.widget({ widget: new FieldLock(field.hint), side: 1 }).range(field.to),
    ]), true);
  }

  return [
    Prec.high(yamlLanguage),
    ViewPlugin.fromClass(class {
      decorations;
      constructor(view: EditorView) { this.decorations = marks(view); }
      update(update: ViewUpdate) {
        if (update.docChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.decorations = marks(update.view);
        }
        if (update.docChanged || update.selectionSet) onHint('');
        for (const tr of update.transactions) {
          for (const effect of tr.effects) if (effect.is(blocked)) onHint(effect.value);
        }
      }
    }, { decorations: plugin => plugin.decorations }),
    EditorState.transactionFilter.of(tr => {
      if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move'))) return tr;
      const before = currentFields(tr.startState);
      const touched = before.filter(field => originals.get(field.key) === field.value && tr.changes.touchesRange(field.from, field.to));
      const changes: ChangedRange[] = [];
      const previousTree = syntaxTree(tr.startState);
      let editsKey = false;
      tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        changes.push({ fromA, toA, fromB, toB });
        if (!touched.length && !editsKey) {
          editsKey = inserted.toString().includes(':') ||
            insideKey(previousTree.resolveInner(fromA, 1)) || insideKey(previousTree.resolveInner(toA, -1));
        }
      });
      if (!touched.length && !editsKey) return tr;
      const fragments = TreeFragment.applyChanges(TreeFragment.addTree(previousTree), changes);
      const tree = yamlLanguage.parser.parse(new DocInput(tr.newDoc), fragments);
      const edited = managedFields(tr.newDoc, tree);
      const changed = touched.find(field => !edited.some(next => next.key === field.key && next.value === field.value))
        ?? edited.find((field, index) => (!originals.has(field.key) && !before.some(previous => previous.key === field.key)) ||
          edited.some((other, otherIndex) => otherIndex < index && other.key === field.key));
      return changed ? { effects: blocked.of(changed.hint) } : tr;
    }),
  ];
}
