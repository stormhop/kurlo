<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { Decoration, EditorView, ViewPlugin, hoverTooltip, keymap, placeholder as cmPlaceholder, lineNumbers, highlightActiveLine, highlightActiveLineGutter, type DecorationSet, type ViewUpdate } from '@codemirror/view';
  import { EditorState, Compartment, RangeSetBuilder, type Extension } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap, StreamLanguage } from '@codemirror/language';
  import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, type CompletionContext } from '@codemirror/autocomplete';
  import { forEachDiagnostic, linter, type Diagnostic } from '@codemirror/lint';
  import { tags } from '@lezer/highlight';
  import { selectedLineNumbersForComment } from './editorSelection';
  import { formatJsonDocument, validateJsonDocument } from './jsonEditing';
  import { formatGraphQLQuery } from './graphql';
  import { prettyMarkup } from './utils';
  import type { VariableSuggestion } from './variables';
  import { variableDisplayValue } from './variables';
  import { DYNAMIC_VARIABLES } from './dynamicVariables';
  import { maxLength as maxLengthFilter } from './editorLimit';

  type Lang = 'json' | 'javascript' | 'html' | 'xml' | 'graphql' | 'yaml' | 'text';

  let {
    value = $bindable(''),
    language = 'text' as Lang,
    placeholder = '',
    readonly = false,
    minHeight = '7.5rem',
    maxHeight = '18.75rem',
    fillHeight = false,
    compact = false,
    prose = false,
    testId = '',
    ariaLabel = '',
    variableSuggestions = [],
    maxLength = 0,
    onformat,
    validate,
  }: {
    value?: string;
    language?: Lang;
    placeholder?: string;
    readonly?: boolean;
    minHeight?: string;
    maxHeight?: string;
    fillHeight?: boolean;
    compact?: boolean;
    prose?: boolean;
    testId?: string;
    ariaLabel?: string;
    variableSuggestions?: VariableSuggestion[];
    maxLength?: number;
    onformat?: () => void;
    validate?: (text: string) => Promise<{ line: number; message: string } | null>;
  } = $props();

  let container: HTMLDivElement;
  let view: EditorView | undefined;
  let internalChange = false;
  let languageLoadVersion = 0;
  let lastLoadedLanguage: Lang | null = null;
  let lastPlaceholder = '';
  const languageCompartment = new Compartment();
  const placeholderCompartment = new Compartment();
  const languageExtensions: Partial<Record<Lang, Extension>> = {};
  const singleLinePlaceholder = $derived(placeholder.replace(/\s+/g, ' ').trim());

  function kurloTheme() {
    return EditorView.theme({
    '&': {
      backgroundColor: 'transparent',
      color: 'var(--text)',
      fontSize: prose ? 'var(--text-body)' : 'var(--text-code)',
      fontFamily: prose ? 'var(--font-ui)' : 'var(--font-mono, ui-monospace, monospace)',
      height: fillHeight ? '100%' : 'auto',
    },
    '.cm-content': {
      padding: compact ? 'var(--space-2) 0' : 'var(--space-2-5) 0',
      caretColor: 'var(--accent)',
      minHeight: fillHeight ? '100%' : minHeight,
    },
    '.cm-line': {
      padding: '0 var(--space-3)',
      minHeight: compact ? '1.42em' : '1.65em',
    },
    '.cm-scroller': {
      overflow: 'auto',
      ...(fillHeight ? {} : { maxHeight: maxHeight }),
      fontFamily: 'inherit',
      lineHeight: compact ? '1.42' : '1.65',
      overscrollBehavior: 'none',
      scrollbarGutter: 'stable both-edges',
    },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'color-mix(in srgb, var(--text) 5%, transparent)',
      color: 'var(--text-2)',
    },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--accent-dim)', outline: '1px solid var(--accent)' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      borderRight: 'none',
      color: 'var(--text-3)',
      userSelect: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 var(--space-3) 0 var(--space-1-5)',
      minWidth: '2.25rem',
    },
    '.cm-foldGutter .cm-gutterElement': { padding: '0 var(--space-1)', cursor: 'pointer' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--elevated)',
      border: '1px solid var(--border)',
      color: 'var(--text-2)',
      borderRadius: 'var(--radius-sm)',
      padding: '0 var(--space-1)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--elevated)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      color: 'var(--text)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'var(--accent-dim)',
      color: 'var(--text)',
    },
    '.cm-placeholder': {
      color: 'var(--text-3)',
      display: 'inline-block',
      maxWidth: '100%',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      verticalAlign: 'bottom',
      whiteSpace: 'nowrap',
    },
    '.cm-panels': { backgroundColor: 'var(--surface)', borderTop: '1px solid var(--border)' },
    '.cm-searchMatch': { backgroundColor: 'var(--accent-dim)', outline: '1px solid var(--accent)' },
    '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 16%, transparent)' },
    '.cm-tooltip-lint': {
      padding: '0',
      margin: '0',
      minWidth: '11.25rem',
      maxWidth: '26.25rem',
    },
    '.cm-diagnostic': {
      padding: 'var(--space-2) var(--space-2-5)',
      borderLeft: '3px solid transparent',
      whiteSpace: 'pre-wrap',
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      fontSize: 'var(--text-caption)',
      lineHeight: 'var(--leading-normal)',
      color: 'var(--text)',
    },
    '.cm-diagnostic-error': { borderLeftColor: 'var(--delete)' },
    '.cm-diagnostic-warning': { borderLeftColor: 'var(--put, orange)' },
    '.cm-diagnosticText': { color: 'var(--text)' },
    '.cm-diagnosticSource': {
      display: 'block',
      marginTop: 'var(--space-1)',
      color: 'var(--text-3)',
      fontSize: 'var(--text-micro)',
      fontWeight: 'var(--weight-semibold)',
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      opacity: '1',
    },
    '.cm-panel.cm-panel-lint ul [aria-selected]': {
      backgroundColor: 'var(--accent-dim)',
      color: 'var(--text)',
    },
    '.cm-panel.cm-panel-lint button[name="close"]': {
      color: 'var(--text-3)',
    },
    });
  }

  const kurloHighlight = syntaxHighlighting(HighlightStyle.define([
    { tag: tags.keyword,                  color: 'var(--syn-bool)', fontWeight: 'bold' },
    { tag: tags.controlKeyword,           color: 'var(--syn-bool)', fontWeight: 'bold' },
    { tag: tags.string,                   color: 'var(--syn-str)' },
    { tag: tags.special(tags.string),     color: 'var(--syn-url)' },
    { tag: tags.number,                   color: 'var(--syn-num)' },
    { tag: tags.bool,                     color: 'var(--syn-bool)' },
    { tag: tags.null,                     color: 'var(--text-3)', fontStyle: 'italic' },
    { tag: tags.propertyName,             color: 'var(--syn-key)' },
    { tag: tags.attributeName,            color: 'var(--syn-hdr-key)' },
    { tag: tags.attributeValue,           color: 'var(--syn-str)' },
    { tag: tags.comment,                  color: 'var(--text-3)', fontStyle: 'italic' },
    { tag: tags.lineComment,              color: 'var(--text-3)', fontStyle: 'italic' },
    { tag: tags.blockComment,             color: 'var(--text-3)', fontStyle: 'italic' },
    { tag: tags.operator,                 color: 'var(--syn-url)' },
    { tag: tags.punctuation,              color: 'var(--text-2)' },
    { tag: tags.bracket,                  color: 'var(--text-2)' },
    { tag: tags.variableName,             color: 'var(--text)' },
    { tag: tags.local(tags.variableName), color: 'var(--syn-hdr-key)' },
    { tag: tags.definition(tags.variableName), color: 'var(--syn-url)' },
    { tag: tags.function(tags.variableName), color: 'var(--syn-hdr-key)' },
    { tag: tags.typeName,                 color: 'var(--syn-hdr-key)' },
    { tag: tags.className,                color: 'var(--syn-num)' },
    { tag: tags.tagName,                  color: 'var(--syn-key)' },
    { tag: tags.name,                     color: 'var(--text)' },
    { tag: tags.namespace,                color: 'var(--syn-num)' },
    { tag: tags.meta,                     color: 'var(--text-3)' },
    { tag: tags.link,                     color: 'var(--syn-hdr-key)', textDecoration: 'underline' },
    { tag: tags.invalid,                  color: 'var(--syn-key)' },
    { tag: tags.escape,                   color: 'var(--syn-url)' },
    { tag: tags.regexp,                   color: 'var(--syn-url)' },
    { tag: tags.self,                     color: 'var(--syn-bool)' },
    { tag: tags.atom,                     color: 'var(--syn-num)' },
  ]));

  const graphQLLanguage = StreamLanguage.define({
    token(stream) {
      if (stream.eatSpace()) return null;
      if (stream.match(/#[^\n]*/)) return 'lineComment';
      if (stream.match(/"(?:[^"\\]|\\.)*"/)) return 'string';
      if (stream.match(/-?(?:0|[1-9]\d*)(?:\.\d+)?/)) return 'number';
      if (stream.match(/\$[_A-Za-z][_0-9A-Za-z]*/)) return 'variableName';
      if (stream.match(/[_A-Za-z][_0-9A-Za-z]*/)) {
        const token = stream.current();
        if (/^(query|mutation|subscription|fragment|on|schema|type|interface|union|enum|input|scalar|directive|extend|implements)$/i.test(token)) return 'keyword';
        if (/^(true|false|null)$/i.test(token)) return 'atom';
        if (/^[A-Z]/.test(token)) return 'typeName';
        return 'propertyName';
      }
      if (stream.match(/[!()[\]{}:=@|&,.]/)) return 'punctuation';
      stream.next();
      return null;
    },
  });

  const yamlLanguage = StreamLanguage.define({
    token(stream) {
      if (stream.sol() && stream.match(/^\s*-(?=\s|$)/)) return 'punctuation';
      if (stream.eatSpace()) return null;
      if (stream.match(/#.*/)) return 'lineComment';
      if (stream.match(/(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#][^:#]*?)(?=:(?:\s|$))/)) return 'propertyName';
      if (stream.match(/:(?=\s|$)/)) return 'punctuation';
      if (stream.match(/"(?:[^"\\]|\\.)*"?|'(?:[^']|'')*'?/)) return 'string';
      if (stream.match(/[|>][-+0-9]*\s*$/)) return 'punctuation';
      if (stream.match(/(?:true|false|null|~)(?=\s*(?:#|$))/)) return 'atom';
      if (stream.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?(?=\s*(?:#|$))/i)) return 'number';
      stream.skipToEnd();
      return 'string';
    },
  });

  function immediateLangExtension(lang: Lang): Extension {
    return languageExtensions[lang] ?? (lang === 'graphql' ? graphQLLanguage : lang === 'yaml' ? yamlLanguage : []);
  }

  async function loadLangExtension(lang: Lang): Promise<Extension> {
    const cached = languageExtensions[lang];
    if (cached) return cached;

    let extension: Extension;
    switch (lang) {
      case 'json':
        extension = (await import('@codemirror/lang-json')).json();
        break;
      case 'javascript':
        extension = (await import('@codemirror/lang-javascript')).javascript({ jsx: false, typescript: false });
        break;
      case 'html':
        extension = (await import('@codemirror/lang-html')).html();
        break;
      case 'xml':
        extension = (await import('@codemirror/lang-xml')).xml();
        break;
      case 'graphql':
        extension = graphQLLanguage;
        break;
      case 'yaml':
        extension = yamlLanguage;
        break;
      default:
        extension = [];
    }
    languageExtensions[lang] = extension;
    return extension;
  }

  async function reconfigureLanguage(lang: Lang) {
    const version = ++languageLoadVersion;
    const extension = await loadLangExtension(lang);
    if (!view || version !== languageLoadVersion) return;
    view.dispatch({ effects: languageCompartment.reconfigure(extension) });
    lastLoadedLanguage = lang;
  }

  function variableCompletionSource(context: CompletionContext) {
    const from = Math.max(0, context.pos - 90);
    const before = context.state.sliceDoc(from, context.pos);
    const match = before.match(/\{\{\s*([$\p{L}\p{N}_.:-]*)$/u);
    if (!match) return null;
    const prefix = match[1] ?? '';
    const start = context.pos - prefix.length;
    const needle = prefix.toLowerCase();
    const environmentOptions = variableSuggestions
      .filter(variable => variable.key.toLowerCase().includes(needle))
      .sort((a, b) => {
        const ap = a.key.toLowerCase().startsWith(needle) ? 0 : 1;
        const bp = b.key.toLowerCase().startsWith(needle) ? 0 : 1;
        return ap - bp || a.key.localeCompare(b.key);
      })
      .slice(0, 30)
      .map(variable => ({
        label: variable.key,
        type: 'variable',
        detail: variable.secret ? 'secret' : variableDisplayValue(variable),
        apply: `${variable.key}}}`,
      }));
    const dynamicOptions = DYNAMIC_VARIABLES
      .filter(variable => variable.name.toLowerCase().includes(needle))
      .slice(0, 30)
      .map(variable => ({
        label: variable.name,
        type: 'keyword',
        detail: variable.description,
        apply: `${variable.name}}}`,
      }));
    const options = [...environmentOptions, ...dynamicOptions];
    if (!options.length) return null;
    return { from: start, options, validFor: /^[$\p{L}\p{N}_.:-]*$/u };
  }

  function lineCommentToken() {
    if (language === 'html' || language === 'xml') return null;
    if (language === 'json' || language === 'javascript') return '//';
    return '#';
  }

  function isLineCommented(text: string, token: string | null) {
    const trimmed = text.trimStart();
    if (!trimmed) return true;
    if (!token) {
      const HTML_OPEN = '<' + '!--';
      const HTML_CLOSE = '--' + '>';
      return trimmed.startsWith(HTML_OPEN) && trimmed.endsWith(HTML_CLOSE);
    }
    return trimmed.startsWith(token);
  }

  function removeLineComment(text: string, token: string) {
    const indent = text.match(/^\s*/)?.[0] ?? '';
    const trimmed = text.slice(indent.length);
    if (!trimmed.startsWith(token)) return text;
    return `${indent}${trimmed.slice(token.length).replace(/^ /, '')}`;
  }

  function commentedLineDecorations(view: EditorView) {
    const builder = new RangeSetBuilder<Decoration>();
    const lineDecoration = Decoration.line({ class: 'cm-kurlo-commented-line' });
    let inBlockComment = false;

    for (let lineNo = 1; lineNo <= view.state.doc.lines; lineNo += 1) {
      const line = view.state.doc.line(lineNo);
      const trimmed = line.text.trimStart();
      let commented: boolean;

      if (language === 'html' || language === 'xml') {
        const HTML_OPEN = '<' + '!--';
        const HTML_CLOSE = '--' + '>';
        commented = inBlockComment || trimmed.startsWith(HTML_OPEN);
        if (trimmed.startsWith(HTML_OPEN) && !trimmed.includes(HTML_CLOSE)) inBlockComment = true;
        if (inBlockComment && trimmed.includes(HTML_CLOSE)) inBlockComment = false;
      } else if (language === 'json' || language === 'javascript') {
        commented = inBlockComment || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
        if (trimmed.startsWith('/*') && !trimmed.includes('*/')) inBlockComment = true;
        if (inBlockComment && trimmed.includes('*/')) inBlockComment = false;
      } else {
        commented = trimmed.startsWith('#') || trimmed.startsWith('//');
      }

      if (commented) builder.add(line.from, line.from, lineDecoration);
    }

    return builder.finish();
  }

  const commentDecorationPlugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = commentedLineDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.transactions.some(tr => tr.effects.length)) {
        this.decorations = commentedLineDecorations(update.view);
      }
    }
  }, {
    decorations: plugin => plugin.decorations,
  });

  function validateGraphQLStructure(src: string): { position: number; message: string } | null {
    const closers: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
    const stack: { ch: string; pos: number }[] = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const ch = src[i];
      if (ch === '#') { while (i < n && src[i] !== '\n') i += 1; continue; }
      if (ch === '"') {
        if (src.slice(i, i + 3) === '"""') {
          const end = src.indexOf('"""', i + 3);
          if (end === -1) return { position: i, message: 'Unterminated block string' };
          i = end + 3;
          continue;
        }
        i += 1;
        let closed = false;
        while (i < n) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '\n') break;
          if (src[i] === '"') { closed = true; i += 1; break; }
          i += 1;
        }
        if (!closed) return { position: Math.min(i, n - 1), message: 'Unterminated string' };
        continue;
      }
      if (ch === '{' || ch === '(' || ch === '[') { stack.push({ ch, pos: i }); i += 1; continue; }
      if (ch === '}' || ch === ')' || ch === ']') {
        const top = stack.pop();
        if (!top) return { position: i, message: `Unexpected closing '${ch}'` };
        if (top.ch !== closers[ch]) return { position: i, message: `Mismatched '${ch}' — '${top.ch}' is still open` };
        i += 1;
        continue;
      }
      i += 1;
    }
    const unclosed = stack[stack.length - 1];
    if (unclosed) return { position: unclosed.pos, message: `Unclosed '${unclosed.ch}'` };
    return null;
  }

  function computeIssue(text: string): { position: number; message: string; source: string } | null {
    if (!text.trim()) return null;
    if (language === 'json') {
      const error = validateJsonDocument(text);
      return error ? { position: error.position, message: error.message, source: 'JSON' } : null;
    }
    if (language === 'graphql') {
      const error = validateGraphQLStructure(text);
      return error ? { ...error, source: 'GraphQL' } : null;
    }
    return null;
  }

  async function kurloDiagnostics(view: EditorView): Promise<Diagnostic[]> {
    const docLen = view.state.doc.length;
    const text = view.state.doc.toString();
    let issue = computeIssue(text);
    if (!issue && validate) {
      const found = await validate(text);
      if (found) {
        const lineNumber = Math.min(Math.max(found.line, 1), view.state.doc.lines);
        issue = { position: view.state.doc.line(lineNumber).from, message: found.message, source: 'YAML' };
      }
    }
    if (!issue) return [];
    const pos = Math.min(Math.max(issue.position, 0), docLen);
    const line = view.state.doc.lineAt(pos);
    const leading = line.text.length - line.text.trimStart().length;
    let from = line.text.trim() ? line.from + leading : line.from;
    let to = line.to;
    if (from >= to) { from = line.from; to = Math.min(line.from + 1, docLen); }
    return [{
      from,
      to,
      severity: 'error',
      message: issue.message,
      source: issue.source,
    }];
  }

  const kurloLinter = linter(kurloDiagnostics, {
    delay: 300,
    tooltipFilter: () => null as unknown as Diagnostic[],
  });

  const kurloLintTooltip = hoverTooltip((hoverView, pos, side) => {
    const found: Diagnostic[] = [];
    let start = -1;
    let end = -1;
    forEachDiagnostic(hoverView.state, (diagnostic, from, to) => {
      if (pos < from || pos > to || (pos === from && side < 0 && from !== to) || (pos === to && side > 0 && from !== to)) return;
      found.push(diagnostic);
      start = start < 0 ? from : Math.min(start, from);
      end = Math.max(end, to);
    });
    if (!found.length) return null;
    return {
      pos: start,
      end,
      above: false,
      create() {
        const dom = document.createElement('ul');
        dom.className = 'cm-tooltip-lint';
        for (const diagnostic of found) {
          const item = document.createElement('li');
          item.className = `cm-diagnostic cm-diagnostic-${diagnostic.severity}`;
          const text = document.createElement('span');
          text.className = 'cm-diagnosticText';
          text.textContent = diagnostic.message;
          item.append(text);
          if (diagnostic.source) {
            const source = document.createElement('div');
            source.className = 'cm-diagnosticSource';
            source.textContent = diagnostic.source;
            item.append(source);
          }
          dom.append(item);
        }
        return { dom };
      },
    };
  }, { hideOnChange: true });

  function toggleSelectedLineComments() {
    if (!view || readonly) return false;
    const currentView = view;
    const token = lineCommentToken();
    const changes: { from: number; to?: number; insert: string }[] = [];

    for (const range of currentView.state.selection.ranges) {
      const lines = selectedLineNumbersForComment(currentView.state.doc, range.from, range.to)
        .map(lineNo => currentView.state.doc.line(lineNo));

      if (language === 'html' || language === 'xml') {
        const allCommented = lines.every(line => isLineCommented(line.text, null));
        for (const line of lines) {
          if (!line.text.trim()) continue;
          const indent = line.text.match(/^\s*/)?.[0] ?? '';
          const trimmed = line.text.trim();
          if (allCommented) {
            const uncommented = trimmed.replace(/^<!--\s?/, '').replace(/\s?-->$/, '');
            changes.push({ from: line.from, to: line.to, insert: `${indent}${uncommented}` });
          } else {
            changes.push({ from: line.from, to: line.to, insert: `${indent}<!-- ${trimmed} -->` });
          }
        }
        continue;
      }

      if (!token) continue;
      const allCommented = lines.every(line => isLineCommented(line.text, token));
      for (const line of lines) {
        if (!line.text.trim()) continue;
        if (allCommented) {
          changes.push({ from: line.from, to: line.to, insert: removeLineComment(line.text, token) });
        } else {
          const indent = line.text.match(/^\s*/)?.[0] ?? '';
          changes.push({ from: line.from + indent.length, insert: `${token} ` });
        }
      }
    }

    if (!changes.length) return true;
    currentView.dispatch({ changes });
    value = currentView.state.doc.toString();
    return true;
  }

  function buildExtensions(lang: Lang) {
    return [
      ...(prose
        ? [EditorView.lineWrapping]
        : [lineNumbers(), foldGutter(), highlightActiveLineGutter(), highlightActiveLine(), bracketMatching(), closeBrackets()]),
      history(),
      indentOnInput(),
      autocompletion({ override: [variableCompletionSource] }),
      commentDecorationPlugin,
      kurloLinter,
      kurloLintTooltip,
      keymap.of([
        { key: 'Mod-/', run: toggleSelectedLineComments },
        { key: 'Mod-Shift-f', run: () => { format(); return true; } },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      placeholderCompartment.of(singleLinePlaceholder ? cmPlaceholder(singleLinePlaceholder) : []),
      languageCompartment.of(immediateLangExtension(lang)),
      kurloTheme(),
      kurloHighlight,
      EditorState.readOnly.of(readonly),
      ...(maxLength > 0 ? [maxLengthFilter(maxLength)] : []),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !internalChange) {
          internalChange = true;
          value = update.state.doc.toString();
          internalChange = false;
        }
      }),
    ];
  }

  onMount(() => {
    view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: buildExtensions(language),
      }),
      parent: container,
    });
    lastLoadedLanguage = language;
    lastPlaceholder = singleLinePlaceholder;
    void reconfigureLanguage(language);
  });

  $effect(() => {
    if (!view) return;
    const next = value;
    untrack(() => {
      if (internalChange) return;
      const current = view!.state.doc.toString();
      if (current === next) return;
      internalChange = true;
      try {
        view!.dispatch({ changes: { from: 0, to: view!.state.doc.length, insert: next } });
      } finally {
        internalChange = false;
      }
    });
  });

  $effect(() => {
    if (!view) return;
    const nextLang = language;
    if (nextLang === lastLoadedLanguage) return;
    void reconfigureLanguage(nextLang);
  });

  $effect(() => {
    if (!view) return;
    const nextPlaceholder = singleLinePlaceholder;
    if (nextPlaceholder === lastPlaceholder) return;
    lastPlaceholder = nextPlaceholder;
    view.dispatch({ effects: placeholderCompartment.reconfigure(nextPlaceholder ? cmPlaceholder(nextPlaceholder) : []) });
  });

  onDestroy(() => {
    languageLoadVersion += 1;
    view?.destroy();
    view = undefined;
  });

  export function format() {
    if (!view) return false;
    let formatted: string | null = null;
    const current = view.state.doc.toString();
    const source = current.trim();

    if (language === 'json' && source) {
      formatted = formatJsonDocument(current);
    }
    if ((language === 'html' || language === 'xml') && current.trim()) {
      formatted = prettyMarkup(current);
    }
    if (language === 'graphql' && current.trim()) {
      formatted = formatGraphQLQuery(current);
    }
    if (formatted !== null && formatted !== current) {
      internalChange = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted } });
      internalChange = false;
      value = formatted;
      onformat?.();
      return true;
    }
    return false;
  }

</script>

<div
  bind:this={container}
  class="cm-wrap"
  class:fill={fillHeight}
  data-testid={testId || undefined}
  aria-label={ariaLabel || undefined}
></div>

<style>
  .cm-wrap {
    width: 100%;
    overflow: hidden;
  }
  .cm-wrap.fill {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  :global(.cm-wrap .cm-editor) {
    width: 100%;
    outline: none;
  }
  :global(.cm-wrap.fill .cm-editor) {
    flex: 1;
    min-height: 0;
    height: 100%;
  }
  :global(.cm-wrap.fill .cm-scroller) {
    flex: 1;
    min-height: 0;
    height: 100%;
    overscroll-behavior: none;
    scrollbar-gutter: stable both-edges;
  }
  :global(.cm-wrap .cm-editor.cm-focused) {
    outline: none;
  }
  :global(.cm-wrap .cm-kurlo-commented-line),
  :global(.cm-wrap .cm-kurlo-commented-line span) {
    color: var(--text-3) !important;
  }
  :global(.cm-wrap .cm-lintRange) {
    padding-bottom: var(--space-0-5);
    background-position: left bottom;
    background-repeat: repeat-x;
    text-decoration: none !important;
  }
  :global(.cm-wrap .cm-lintRange-error) {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0' stroke='%23e5484d' fill='none' stroke-width='1.1'/%3E%3C/svg%3E") !important;
  }
  :global(.cm-wrap .cm-lintRange-warning) {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0' stroke='%23e0922f' fill='none' stroke-width='1.1'/%3E%3C/svg%3E") !important;
  }
</style>
