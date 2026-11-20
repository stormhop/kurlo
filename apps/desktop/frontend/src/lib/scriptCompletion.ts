import { syntaxTree } from '@codemirror/language';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { DYNAMIC_VARIABLES } from './dynamicVariables';
import { scriptMembers, type ScriptMember } from './scriptApi';

export type ScriptScope = 'environment' | 'variables' | 'globals' | 'collectionVariables' | 'requests';
export interface ScriptContext {
  tests: boolean;
  names(scope: ScriptScope): readonly string[];
}

function hint(signature: string, example: string) {
  const dom = document.createElement('div');
  dom.className = 'script-completion-hint';
  const heading = document.createElement('code');
  heading.textContent = signature;
  const label = document.createElement('span');
  label.textContent = 'Example';
  const code = document.createElement('code');
  code.textContent = example;
  dom.append(heading, label, code);
  return dom;
}

function option(member: ScriptMember): Completion {
  return { label: member.name, type: member.type, info: () => hint(member.signature, member.example) };
}

function expressionPath(state: EditorState, node: SyntaxNode | null): string {
  const parts: string[] = [];
  while (node) {
    if (node.name === 'VariableName') {
      return state.sliceDoc(node.from, node.to) === 'pm' ? 'pm' + parts.reverse().join('') : '';
    }
    if (node.name === 'CallExpression') parts.push('()');
    else if (node.name === 'MemberExpression' && node.lastChild?.name === 'PropertyName') {
      parts.push('.' + state.sliceDoc(node.lastChild.from, node.lastChild.to));
    } else return '';
    node = node.firstChild;
  }
  return '';
}

function receiverGroup(path: string, tests: boolean): string | undefined {
  if (!path || (!tests && /^pm\.response\b/.test(path))) return;
  let owner = 'pm';
  for (const part of path.split('.').slice(1)) {
    const call = part.endsWith('()');
    const member = scriptMembers(owner)?.get(call ? part.slice(0, -2) : part);
    if (!member?.result || call !== (member.type === 'method')) return;
    owner = member.result;
  }
  return owner;
}

function keyScope(state: EditorState, literal: SyntaxNode): ScriptScope | undefined {
  const parent = literal.parent;
  if (parent?.name === 'BinaryExpression') {
    const op = literal.prevSibling;
    if (op?.name === 'CompareOp' && ['==', '===', '!=', '!=='].includes(state.sliceDoc(op.from, op.to))
      && expressionPath(state, op.prevSibling) === 'pm.info.requestName') return 'requests';
  }
  if (parent?.name !== 'ArgList' || literal.prevSibling?.name !== '(') return;
  const callee = parent.parent?.firstChild ?? null;
  const path = expressionPath(state, callee);
  const match = /^pm\.(variables|environment|globals|collectionVariables)\.(get|set|unset)$/.exec(path);
  if (match) return match[1] as ScriptScope;
  if (/^pm\.expect\(\)(?:\.[\w$]+)*\.(equal|equals|eq|eql|eqls)$/.test(path)) {
    let caller = callee;
    while (caller?.name === 'MemberExpression') caller = caller.firstChild;
    const value = caller?.getChild('ArgList')?.getChild('MemberExpression');
    if (expressionPath(state, value ?? null) === 'pm.info.requestName') return 'requests';
  }
}

function escaped(value: string, quote: string) {
  const json = JSON.stringify(value).slice(1, -1);
  if (quote === '"') return json;
  const text = json.replace(/\\"/g, '"');
  if (quote === "'") return text.replaceAll("'", "\\'");
  return text.replaceAll('`', '\\`').replaceAll('${', '\\${');
}

function literalOptions(context: CompletionContext, literal: SyntaxNode, data: ScriptContext): CompletionResult | null {
  const { state, pos } = context;
  const text = state.sliceDoc(literal.from, literal.to);
  const quote = text[0];
  const closed = text.length > 1 && text.endsWith(quote) && !literal.lastChild?.type.isError;
  const end = closed ? literal.to - 1 : literal.to;
  if (pos > end) return null;
  const before = state.sliceDoc(literal.from + 1, pos);
  const template = /\{\{\s*([$\p{L}\p{N}_.:-]*)$/u.exec(before);
  const scope = template ? 'variables' : keyScope(state, literal);
  if (!scope || (literal.name === 'TemplateString' && literal.getChild('Interpolation') && !template)) return null;
  const from = template ? pos - template[1].length : literal.from + 1;
  const suffix = template ? state.sliceDoc(pos, end).match(/^[$\p{L}\p{N}_.:-]*\}{0,2}/u)![0] : '';
  const to = template ? pos + suffix.length : end;
  const needle = state.sliceDoc(from, pos).toLowerCase();
  const names = new Set(data.names(scope));
  if (template) for (const variable of DYNAMIC_VARIABLES) names.add(variable.name);
  const options: Completion[] = [];
  for (const name of names) {
    const value = escaped(name, quote);
    if (!value.toLowerCase().includes(needle)) continue;
    options.push({
      label: name, type: scope === 'requests' ? 'text' : 'variable',
      detail: scope === 'requests' ? 'request' : scope === 'variables' ? 'variable' : scope,
      info: () => {
        const quoted = JSON.stringify(name);
        if (scope === 'requests') return hint('pm.info.requestName: string', `pm.info.requestName === ${quoted}`);
        if (template) return hint('pm.variables.replaceIn(text): string', `pm.variables.replaceIn(${JSON.stringify('{{' + name + '}}')})`);
        const path = expressionPath(state, literal.parent?.parent?.firstChild ?? null);
        const method = path.split('.').at(-1)!;
        const signature = scriptMembers(`pm.${scope}`)!.get(method)!.signature;
        return hint(signature, `${path}(${quoted}${method === 'set' ? ', "value"' : ''})`);
      },
      apply: value + (template ? '}}' : closed ? '' : quote),
    });
  }
  options.sort((a, b) => a.label.localeCompare(b.label));
  return options.length ? { from, to, options, filter: false } : null;
}

export function completeScript(context: CompletionContext, data: ScriptContext): CompletionResult | null {
  const { state, pos } = context;
  const node = syntaxTree(state).resolveInner(pos, -1);
  const literal = node.name === 'Escape' ? node.parent : node;
  if (literal && ['String', 'TemplateString'].includes(literal.name)) return literalOptions(context, literal, data);
  const member = node.parent;
  if (member?.name === 'MemberExpression' && ['.', '?.', 'PropertyName'].includes(node.name)) {
    const path = expressionPath(state, member.firstChild);
    const owner = receiverGroup(path, data.tests);
    const members = owner && scriptMembers(owner);
    if (!members) return null;
    const from = node.name === 'PropertyName' ? node.from : pos;
    const entries = [...members.values()].filter(item => data.tests || owner !== 'pm' || item.name !== 'response');
    if (pos < node.to) {
      const prefix = state.sliceDoc(from, pos).toLowerCase();
      return { from, to: node.to, options: entries.filter(item => item.name.toLowerCase().startsWith(prefix)).map(option), filter: false };
    }
    return { from, options: entries.map(option), validFor: /^[\w$]*$/ };
  }
  const root = node.name === 'VariableName' && state.sliceDoc(node.from, pos);
  if ((root && 'pm'.startsWith(root)) || (context.explicit && !context.matchBefore(/\S$/) && !/Comment|String|RegExp/.test(node.name))) {
    return { from: root ? node.from : pos, options: [{ label: 'pm', type: 'variable', info: () => hint('pm', 'pm.log(pm.info.requestName)') }] };
  }
  return null;
}
