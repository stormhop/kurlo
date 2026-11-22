import { insertCompletionText, pickedCompletion, snippet, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { getIndentUnit } from '@codemirror/language';
import { requestYamlCursor } from './requestYamlCursor';
import { managedRequestFields, requestYamlOptions, type RequestYamlOption } from './requestYamlOptions';

function yamlValue(option: RequestYamlOption, quote: string) {
  if (option.type === 'constant') return option.label;
  if (quote === "'" && option.label !== '""') return "'" + option.label.replaceAll("'", "''") + "'";
  if (option.label === '""') return '""';
  if (quote === '"' || !/^[a-z_][\w-]*$/i.test(option.label) || /^(true|false|null)$/i.test(option.label)) {
    return JSON.stringify(option.label);
  }
  return option.label;
}

export function requestYamlCompletion(context: CompletionContext): CompletionResult | null {
  const { state, pos } = context;
  const cursor = requestYamlCursor(state, pos);
  if (!cursor) return null;
  const { path, kind, siblings, requestType, method, from, to, hasColon, inFlow, indentStep } = cursor;
  if (from > pos || pos > to || to - from > 128) return null;
  const token = state.sliceDoc(from, to);
  if (kind === 'key' && hasColon && path.length === 1 && managedRequestFields.has(token.replace(/^['"]|['"]$/g, ''))) return null;
  const prefix = state.sliceDoc(from, pos).replace(/^['"]|['"]$/g, '').toLowerCase();
  const options = requestYamlOptions(path, kind, siblings, requestType, method)
    .filter(option => option.label.toLowerCase().startsWith(prefix))
    .filter(option => context.explicit || kind === 'key' || option.label !== token);
  if (!options.length) return null;

  const line = state.doc.lineAt(from);
  const nextToColon = from > line.from && state.sliceDoc(from - 1, from) === ':';
  const canNest = !inFlow && !state.sliceDoc(to, line.to).trim();
  const indentation = from - line.from + Math.max(1, indentStep || getIndentUnit(state));

  const choices = options.map((option): Completion => {
    let apply: Completion['apply'] = option.label;
    if (kind === 'value') {
      apply = (nextToColon ? ' ' : '') + yamlValue(option, token[0]);
    } else if (!hasColon) {
      const object = option.valueKind === 'object';
      const array = option.valueKind === 'array';
      if ((object || array) && inFlow) {
        apply = snippet(option.label + ': ' + (array ? '[${}]' : '{${}}'));
      } else if ((object || array) && canNest) {
        apply = option.label + ':\n' + ' '.repeat(indentation) + (array ? '- ' : '');
      } else {
        apply = option.label + ': ';
      }
    }
    if (inFlow && typeof apply === 'string') {
      const text = apply;
      apply = (view, picked, start, end) => {
        view.dispatch({
          ...insertCompletionText(view.state, text, start, end),
          annotations: pickedCompletion.of(picked),
        });
        const head = view.state.selection.main.head;
        const selection = view.dom.ownerDocument.getSelection();
        if (view.hasFocus && head === start + text.length && selection?.isCollapsed && selection.anchorOffset === 0) {
          const last = view.domAtPos(head - 1);
          if (last.node.nodeType === Node.TEXT_NODE) selection.collapse(last.node, last.offset + 1);
        }
      };
    }
    return { label: option.label, type: option.type, info: option.detail, apply };
  });
  return { from, to, options: choices, filter: false };
}
