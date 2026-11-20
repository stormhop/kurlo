import { parse, parseType, parseValue } from 'graphql/language/parser';
import { print } from 'graphql/language/printer';
import { visit } from 'graphql/language/visitor';
import type { ASTNode, DocumentNode, FieldNode, InlineFragmentNode, OperationDefinitionNode, SelectionSetNode, TypeNode, ValueNode, VariableDefinitionNode } from 'graphql/language/ast';
import { applyEdits, modify } from 'jsonc-parser';
import { DEFAULT_GRAPHQL_QUERY, parseGraphQLVariables, type BuilderField, type BuilderSchema, type GraphQLExplorerArg, type GraphQLPayload } from './graphql';

export type Branch = BuilderField | { onType: string };
export type OperationKind = 'query' | 'mutation' | 'subscription';

export function operationDocument(query: string) {
  try {
    const source = query.trim() ? query : DEFAULT_GRAPHQL_QUERY;
    const document = parse(source);
    const operations = document.definitions.filter(d => d.kind === 'OperationDefinition');
    return { source, document, operations };
  } catch {
    return null;
  }
}

export function branchSelections(set: SelectionSetNode, branch: Branch) {
  return set.selections.filter((node): node is FieldNode | InlineFragmentNode => {
    if ('onType' in branch) {
      return node.kind === 'InlineFragment' && node.typeCondition?.name.value === branch.onType && !node.directives?.length;
    }
    return node.kind === 'Field' && !node.alias && node.name.value === branch.name;
  });
}

function uniqueName(preferred: string, used: Set<string>) {
  let name = preferred;
  for (let i = 2; used.has(name); i++) name = preferred + i;
  used.add(name);
  return name;
}

export function newOperation(payload: GraphQLPayload, kind: OperationKind): GraphQLPayload {
  const doc = operationDocument(payload.query);
  if (!doc) throw Error('Finish editing the current query first.');
  const name = uniqueName(kind[0].toUpperCase() + kind.slice(1), new Set(doc.operations.map(op => op.name?.value ?? '')));
  let source = doc.source;
  if (source.trim() === DEFAULT_GRAPHQL_QUERY) source = '';
  else {
    const anonymous = doc.operations.find(op => !op.name);
    if (anonymous) {
      const original = uniqueName('Original', new Set([name, ...doc.operations.map(op => op.name?.value ?? '')]));
      const token = anonymous.loc!.startToken;
      const shorthand = token.value !== anonymous.operation;
      const pos = shorthand ? token.start : token.end;
      source = source.slice(0, pos) + (shorthand ? `query ${original} ` : ' ' + original) + source.slice(pos);
    }
  }
  return { ...payload, query: [source.trimEnd(), `${kind} ${name} {\n  __typename\n}`].filter(Boolean).join('\n\n'), operationName: name };
}

function seed(type: string, schema: BuilderSchema, seen = new Set<string>()): unknown {
  if (type.startsWith('[')) return [];
  const name = type.replace(/!$/, '');
  if (['Int', 'Float'].includes(name)) return 0;
  if (name === 'Boolean') return false;
  const model = schema.types.get(name);
  if (model?.kind === 'ENUM') return model.enumValues[0] ?? '';
  if (model?.inputs.length && !seen.has(name)) {
    return Object.fromEntries(model.inputs.filter(f => f.required).map(f => [f.name, seed(f.type, schema, new Set([...seen, name]))]));
  }
  if (model?.kind === 'INPUT_OBJECT') return {};
  return '';
}

type Edit = { start: number; end: number; text: string };
function apply(source: string, edits: Edit[]) {
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, start) + text + source.slice(end);
  }
  return source;
}

function removeArgumentListItem(node: ASTNode, count: number): Edit {
  const { start, end, startToken, endToken } = node.loc!;
  if (count !== 1) return { start, end, text: '' };
  let left = startToken.prev;
  let right = endToken.next;
  while (left?.kind === 'Comment') left = left.prev;
  while (right?.kind === 'Comment') right = right.next;
  return { start: left!.start, end: right!.end, text: '' };
}

function selectionEdit(source: string, set: SelectionSetNode, node: FieldNode | InlineFragmentNode | undefined, replacement: string): Edit {
  const only = set.selections.length === 1 ? set.selections[0] : null;
  const placeholder = only?.kind === 'Field' && only.name.value === '__typename' && !only.alias && !only.directives?.length;
  if (node || placeholder) {
    const { start, end } = (node ?? only)!.loc!;
    const line = source.lastIndexOf('\n', start - 1) + 1;
    const indent = source.slice(line, start).match(/^\s*/)![0];
    const text = replacement.replaceAll('\n', '\n' + indent);
    if (!text && !source.slice(line, start).trim() && /^[ \t]*\n/.test(source.slice(end))) {
      return { start: line, end: source.indexOf('\n', end) + 1, text };
    }
    return { start, end, text };
  }
  const close = set.loc!.endToken.start;
  const line = source.lastIndexOf('\n', close - 1) + 1;
  const indent = source.slice(line, close).match(/^[ \t]*/)![0];
  const text = replacement.split('\n').map(s => indent + '  ' + s).join('\n');
  const ownLine = !source.slice(line, close).trim();
  return { start: ownLine ? line : close, end: ownLine ? line : close, text: ownLine ? text + '\n' : '\n' + text + '\n' + indent };
}

function variableUses(doc: DocumentNode, operation: OperationDefinitionNode) {
  const names = new Set<string>();
  const fragments = new Map(doc.definitions.filter(d => d.kind === 'FragmentDefinition').map(d => [d.name.value, d]));
  const seen = new Set<string>();
  const pending: ASTNode[] = [operation];
  while (pending.length) visit(pending.pop()!, {
    VariableDefinition: () => false,
    Variable: node => { names.add(node.name.value); },
    FragmentSpread(node) {
      const name = node.name.value;
      if (!seen.has(name) && fragments.has(name)) pending.push(fragments.get(name)!);
      seen.add(name);
    },
  });
  return names;
}

function compatibleType(variable: TypeNode, argument: TypeNode): boolean {
  if (argument.kind === 'NonNullType') return variable.kind === 'NonNullType' && compatibleType(variable.type, argument.type);
  if (variable.kind === 'NonNullType') return compatibleType(variable.type, argument);
  if (argument.kind === 'ListType') return variable.kind === 'ListType' && compatibleType(variable.type, argument.type);
  return variable.kind === 'NamedType' && variable.name.value === argument.name.value;
}

function checkLiteral(value: ValueNode, type: TypeNode, schema: BuilderSchema): void {
  if (value.kind === 'Variable') return;
  if (value.kind === 'NullValue' && type.kind !== 'NonNullType') return;
  if (type.kind === 'NonNullType' && value.kind !== 'NullValue') return checkLiteral(value, type.type, schema);
  if (type.kind === 'ListType') {
    for (const item of value.kind === 'ListValue' ? value.values : [value]) checkLiteral(item, type.type, schema);
    return;
  }
  if (type.kind === 'NamedType') {
    const name = type.name.value;
    const model = schema.types.get(name);
    if (model?.kind === 'ENUM') {
      if (value.kind === 'EnumValue' && model.enumValues.includes(value.value)) return;
      throw Error(`Choose a ${name} value: ${model.enumValues.join(', ')}.`);
    }
    if (model?.kind === 'INPUT_OBJECT') {
      if (value.kind === 'ObjectValue') {
        for (const f of model.inputs) {
          if (f.required && !value.fields.some(item => item.name.value === f.name)) throw Error(`${name} requires ${f.name}.`);
        }
        const seen = new Set<string>();
        for (const item of value.fields) {
          if (seen.has(item.name.value)) throw Error(`Duplicate field ${item.name.value} on ${name}.`);
          seen.add(item.name.value);
          const field = model.inputs.find(f => f.name === item.name.value);
          if (!field) throw Error(`Unknown field ${item.name.value} on ${name}.`);
          checkLiteral(item.value, parseType(field.type), schema);
        }
        return;
      }
    } else {
      if (name === 'Int' && value.kind === 'IntValue') {
        const number = Number(value.value);
        if (number < -2147483648 || number > 2147483647) throw Error('Int requires a signed 32-bit integer.');
      }
      const kinds: Record<string, string[]> = { Int: ['IntValue'], Float: ['IntValue', 'FloatValue'], ID: ['IntValue', 'StringValue'], String: ['StringValue'], Boolean: ['BooleanValue'] };
      if (!Object.hasOwn(kinds, name) || kinds[name].includes(value.kind)) return;
    }
  }
  throw Error(`Enter a GraphQL value of type ${print(type)}.`);
}

export type ArgumentEdit = { arg: GraphQLExplorerArg; value?: string };
function definitionEdits(active: OperationDefinitionNode, obsolete: readonly VariableDefinitionNode[], added: Map<string, string>) {
  const keep = active.variableDefinitions?.filter(d => !obsolete.includes(d)) ?? [];
  const edits: Edit[] = [];
  const newDefs = [...added].map(([key, type]) => `$${key}: ${type}`).join(', ');
  if (!keep.length && obsolete.length) {
    const first = removeArgumentListItem(obsolete[0], 1);
    const last = removeArgumentListItem(obsolete.at(-1)!, 1);
    edits.push({ start: first.start, end: last.end, text: newDefs ? '(' + newDefs + ')' : '' });
  } else {
    for (const d of obsolete) edits.push({ start: d.loc!.start, end: d.loc!.end, text: '' });
    if (newDefs) {
      const last = keep.at(-1);
      const token = active.loc!.startToken;
      const shorthand = token.kind === '{';
      const pos = last?.loc!.end ?? active.name?.loc!.end ?? (shorthand ? token.start : token.end);
      edits.push({ start: pos, end: pos, text: last ? ', ' + newDefs : (shorthand ? 'query' : '') + '(' + newDefs + ')' + (shorthand ? ' ' : '') });
    }
  }
  return edits;
}

type BindVariable = (arg: GraphQLExplorerArg, name?: string) => string;

function addedBranch(path: Branch[], schema: BuilderSchema, binding: BindVariable) {
  const members = path.map(step => {
    if ('onType' in step) return { head: '... on ' + step.onType, composite: true };
    const args = step.args.filter(a => a.required).map(a => a.name + ': ' + binding(a));
    return { head: step.name + (args.length ? '(' + args.join(', ') + ')' : ''), composite: ['OBJECT', 'INTERFACE', 'UNION'].includes(schema.types.get(step.namedType)?.kind ?? '') };
  });
  let text = '';
  for (const { head, composite } of members.reverse()) {
    if (!text && composite) text = '__typename';
    text = text ? head + ' {\n  ' + text.replaceAll('\n', '\n  ') + '\n}' : head;
  }
  return text;
}

function argumentChange(node: FieldNode, argument: Required<ArgumentEdit>, op: OperationDefinitionNode, schema: BuilderSchema, binding: BindVariable): Edit | undefined {
  const { arg } = argument;
  let value = argument.value.trim();
  const current = node.arguments?.find(a => a.name.value === arg.name);
  if (value) {
    const parsed = parseValue(value);
    if (parsed.kind === 'Variable') value = binding(arg, parsed.name.value);
    else {
      checkLiteral(parsed, parseType(arg.type), schema);
      visit(parsed, { Variable(node) {
        if (!op.variableDefinitions?.some(d => d.variable.name.value === node.name.value)) throw Error(`Declare $${node.name.value} in the query editor first.`);
      } });
    }
  } else if (arg.required) throw Error(`${arg.name} requires ${arg.type}.`);
  if (current) return value ? { ...current.value.loc!, text: value } : removeArgumentListItem(current, node.arguments!.length);
  if (value) {
    const last = node.arguments?.at(-1);
    const pos = (last ?? node.name).loc!.end;
    return { start: pos, end: pos, text: last ? ', ' + arg.name + ': ' + value : '(' + arg.name + ': ' + value + ')' };
  }
}

export function editBuilder(payload: GraphQLPayload, schema: BuilderSchema, path: Branch[], argument?: ArgumentEdit): GraphQLPayload {
  const doc = operationDocument(payload.query);
  const op = doc?.operations.find(o => o.name?.value === payload.operationName) ?? (!payload.operationName && doc?.operations.length === 1 ? doc.operations[0] : undefined);
  if (!doc || !op) throw Error('Choose a valid operation in the query editor first.');
  const vars = () => parseGraphQLVariables(payload.variables);
  const definitions = op.variableDefinitions ?? [];
  const added = new Map<string, string>();
  let reserved: Set<string> | undefined;
  function binding(arg: GraphQLExplorerArg, value?: string) {
    if (!reserved) {
      reserved = new Set(Object.keys(vars()));
      visit(doc!.document, { Variable(node) { reserved!.add(node.name.value); } });
    }
    const name = value ?? uniqueName(arg.name, reserved);
    const existing = definitions.find(d => d.variable.name.value === name);
    const argType = parseType(arg.type);
    const expected = argType.kind === 'NonNullType' && (!arg.required || (existing?.defaultValue && existing.defaultValue.kind !== 'NullValue')) ? argType.type : argType;
    if (existing && !compatibleType(existing.type, expected)) {
      throw Error(`$${name} is declared as ${print(existing.type)}. Use a variable of type ${arg.type}.`);
    }
    if (!existing) added.set(name, arg.type);
    return '$' + name;
  }
  let parents = [op.selectionSet];
  const edits: Edit[] = [];
  for (const [index, branch] of path.entries()) {
    const groups = parents.map(set => ({ set, matches: branchSelections(set, branch) }));
    const matches = groups.flatMap(group => group.matches);
    if (!matches.length) {
      if (argument) throw Error('Select the field before editing its arguments.');
      const text = addedBranch(path.slice(index), schema, binding);
      edits.push(selectionEdit(doc.source, parents[0], undefined, text));
      break;
    }
    if (index < path.length - 1) {
      parents = matches.flatMap(node => node.selectionSet ? [node.selectionSet] : []);
      if (!parents.length) throw Error('Add a selection set to this field in the query editor.');
      continue;
    }
    if (argument) {
      const change = { ...argument, value: argument.value ?? binding(argument.arg) };
      for (const node of matches) {
        if (node.kind !== 'Field') continue;
        const edit = argumentChange(node, change, op, schema, binding);
        if (edit) edits.push(edit);
      }
    } else {
      for (const { set, matches: siblings } of groups) {
        const removingAll = siblings.length === set.selections.length;
        for (const [position, node] of siblings.entries()) {
          const replacement = removingAll && position === 0 ? '__typename' : '';
          edits.push(selectionEdit(doc.source, set, node, replacement));
        }
      }
    }
  }
  if (!edits.length) return payload;
  const source = apply(doc.source, edits);
  const next = operationDocument(source);
  if (!next) throw Error('Could not apply this edit to the current operation.');
  const active = next.operations[doc.operations.indexOf(op)];
  const remaining = variableUses(next.document, active);
  const previouslyUsed = variableUses(doc.document, op);
  const obsolete = (active.variableDefinitions ?? []).filter(d => previouslyUsed.has(d.variable.name.value) && !remaining.has(d.variable.name.value));
  let variables = payload.variables;
  if (added.size || obsolete.length) {
    const values = vars();
    const change = (key: string, value: unknown) => {
      const json = variables.trim() ? variables : '{}';
      variables = applyEdits(json, modify(json, [key], value, { formattingOptions: { tabSize: 2, insertSpaces: true } }));
    };
    for (const [name, type] of added) if (!Object.hasOwn(values, name)) change(name, seed(type, schema));
    const shared = new Set(next.operations.filter(other => other !== active).flatMap(other => other.variableDefinitions?.map(d => d.variable.name.value) ?? []));
    for (const d of obsolete) {
      const name = d.variable.name.value;
      if (!shared.has(name) && Object.hasOwn(values, name)) change(name, undefined);
    }
  }
  return { ...payload, query: apply(source, definitionEdits(active, obsolete, added)), variables };
}
