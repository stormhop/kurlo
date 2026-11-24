<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, drawSelection, gutterLineClass, tooltips, hoverTooltip, keymap, placeholder as cmPlaceholder, lineNumbers, highlightActiveLine, highlightActiveLineGutter, type DecorationSet, type ViewUpdate } from '@codemirror/view';
  import { EditorSelection, EditorState, Compartment, Prec, RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
  import { defaultKeymap, history, isolateHistory, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldEffect, foldGutter, foldKeymap, StreamLanguage } from '@codemirror/language';
  import { autocompletion, completionKeymap, completionStatus, closeBrackets, closeBracketsKeymap, type CompletionContext, type CompletionSource } from '@codemirror/autocomplete';
  import { forEachDiagnostic, linter, setDiagnosticsEffect, type Diagnostic } from '@codemirror/lint';
  import { tags } from '@lezer/highlight';
  import { textChange } from './textChange';
  import { selectedLineNumbersForComment } from './editorSelection';
  import { formatJsonDocument, validateJsonDocument } from './jsonEditing';
  import { formatGraphQLQuery } from './graphql';
  import { prettyMarkup } from './utils';
  import type { VariableSuggestion } from './variables';
  import { VAULT_TEMPLATE_PREFIX, matchVariableSuggestions, variableDisplayValue } from './variables';
  import { DYNAMIC_VARIABLES } from './dynamicVariables';
  import { maxLength as maxLengthFilter } from './editorLimit';
  import { registerEditorView, unregisterEditorView } from './editorViews';
  import type { EditorGhost } from './ghostText';

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
    editorExtensions = [],
    completionSource,
    includeVariableCompletions = false,
    maxLength = 0,
    onformat,
    validate,
    ghost = undefined,
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
    editorExtensions?: Extension;
    completionSource?: CompletionSource;
    includeVariableCompletions?: boolean;
    maxLength?: number;
    onformat?: () => void;
    validate?: (text: string) => Promise<{ line: number; message: string; source?: string } | null>;
    ghost?: (doc: string, pos: number) => EditorGhost | null;
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
      padding: compact ? 'var(--space-2) 0 var(--space-2) var(--space-3)' : 'var(--space-2-5) 0 var(--space-2-5) var(--space-3)',
      caretColor: 'var(--accent)',
      minHeight: fillHeight ? '100%' : minHeight,
    },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
    },
    '.cm-line': {
      padding: '0 var(--space-3) 0 0',
      minHeight: compact ? '1.42em' : '1.65em',
    },
    '.cm-scroller': {
      overflow: 'auto',
      ...(prose ? { overflowX: 'hidden' } : {}),
      ...(fillHeight ? {} : { maxHeight: maxHeight }),
      fontFamily: 'inherit',
      lineHeight: compact ? '1.42' : '1.65',
      overscrollBehavior: 'none',
      scrollbarGutter: 'stable both-edges',
    },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)',
      boxShadow: 'calc(-1 * var(--space-3)) 0 0 0 color-mix(in srgb, var(--text) 4%, transparent)',
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
    '.cm-ghost-text': {
      color: 'var(--text-3)',
      pointerEvents: 'none',
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
      fontFamily: 'var(--font-ui)',
      fontSize: 'var(--text-label)',
      lineHeight: 'var(--leading-normal)',
      color: 'var(--text)',
    },
    '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
    '.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
    '.cm-diagnosticText': { color: 'var(--text)' },
    '.cm-diagnosticSource': {
      display: 'block',
      marginTop: 'var(--space-0-5)',
      color: 'var(--text-3)',
      fontSize: 'var(--text-caption)',
      opacity: '1',
    },
    '.cm-kurlo-issue-badge': {
      position: 'absolute',
      right: 'var(--space-3)',
      bottom: 'var(--space-2)',
      zIndex: '5',
      display: 'flex',
      justifyContent: 'flex-end',
      maxWidth: 'calc(100% - var(--space-6))',
      pointerEvents: 'none',
    },
    '.cm-kurlo-issue': {
      display: 'flex',
      alignItems: 'baseline',
      gap: 'var(--space-2)',
      minWidth: '0',
      maxWidth: '100%',
      padding: 'var(--space-1) var(--space-2-5)',
      border: '1px solid color-mix(in srgb, var(--danger) 40%, var(--border))',
      borderRadius: 'var(--radius-md)',
      background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
      boxShadow: 'var(--shadow-popover)',
      color: 'var(--danger-text)',
      font: 'inherit',
      fontFamily: 'var(--font-ui)',
      fontSize: 'var(--text-caption)',
      lineHeight: 'var(--leading-normal)',
      textAlign: 'left',
      cursor: 'pointer',
      pointerEvents: 'auto',
      WebkitUserSelect: 'none',
      userSelect: 'none',
    },
    '.cm-kurlo-issue[hidden]': { display: 'none' },
    '.cm-kurlo-issue-announcer': {
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      clipPath: 'inset(50%)',
      whiteSpace: 'nowrap',
    },
    '.cm-kurlo-issue:hover': { background: 'color-mix(in srgb, var(--danger) 14%, var(--surface))' },
    '.cm-kurlo-issue:focus-visible': { outline: 'var(--focus-outline)', outlineOffset: '-2px' },
    '.cm-kurlo-issue.warning': { borderColor: 'color-mix(in srgb, var(--warning) 45%, var(--border))', background: 'color-mix(in srgb, var(--warning) 10%, var(--surface))', color: 'var(--text)' },
    '.cm-kurlo-issue-line-label': { flexShrink: '0', fontWeight: 'var(--weight-medium)' },
    '.cm-kurlo-issue-message': { minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    '.cm-lineNumbers .cm-gutterElement.cm-kurlo-issue-line': {
      color: 'var(--danger)',
      fontWeight: 'var(--weight-semibold)',
      boxShadow: 'inset 2px 0 0 var(--danger)',
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

  function foldMarker(open: boolean): HTMLElement {
    const marker = document.createElement('span');
    marker.className = open ? 'cm-fold-open' : 'cm-fold-closed';
    marker.textContent = open ? '⌄' : '›';
    marker.setAttribute('aria-hidden', 'true');
    return marker;
  }

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
    const matched = matchVariableSuggestions(variableSuggestions, prefix, 30);
    const environmentOptions = matched.items.map(variable => variable.key === VAULT_TEMPLATE_PREFIX
      ? { label: VAULT_TEMPLATE_PREFIX, type: 'namespace', detail: variable.description, apply: VAULT_TEMPLATE_PREFIX, boost: -1 }
      : {
        label: matched.vault ? `${VAULT_TEMPLATE_PREFIX}${variable.key}` : variable.key,
        type: 'variable',
        detail: variable.linked ? variableDisplayValue(variable) : variable.secret ? 'secret' : variableDisplayValue(variable),
        apply: `${matched.vault ? VAULT_TEMPLATE_PREFIX : ''}${variable.key}}}`,
      });
    const dynamicOptions = matched.vault ? [] : DYNAMIC_VARIABLES
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
    const { doc } = view.state;
    const { from, to } = view.viewport;
    const lastLine = doc.lineAt(to).number;
    const HTML_OPEN = '<' + '!--';
    const HTML_CLOSE = '--' + '>';
    let inBlockComment = false;
    let lineStart = 0;

    for (const text of doc.iterLines(1, lastLine + 1)) {
      const trimmed = text.trimStart();
      let commented: boolean;

      if (language === 'html' || language === 'xml') {
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

      if (commented && lineStart + text.length >= from) builder.add(lineStart, lineStart, lineDecoration);
      lineStart += text.length + 1;
    }

    return builder.finish();
  }

  const setGhost = StateEffect.define<EditorGhost | null>();

  const ghostField = StateField.define<EditorGhost | null>({
    create: () => null,
    update(current, tr) {
      for (const effect of tr.effects) if (effect.is(setGhost)) return effect.value;
      return tr.docChanged || tr.selection ? null : current;
    },
  });

  class GhostWidget extends WidgetType {
    text: string;
    constructor(text: string) { super(); this.text = text; }
    eq(other: GhostWidget) { return other.text === this.text; }
    toDOM() {
      const span = document.createElement('span');
      span.className = 'cm-ghost-text';
      span.setAttribute('aria-hidden', 'true');
      span.dataset.testid = 'editor-ghost-text';
      span.textContent = this.text;
      return span;
    }
    ignoreEvent() { return true; }
  }

  const ghostDecorations = EditorView.decorations.compute([ghostField], state => {
    const current = state.field(ghostField);
    if (!current) return Decoration.none;
    return Decoration.set([Decoration.widget({ widget: new GhostWidget(current.text), side: 1 }).range(state.selection.main.head)]);
  });

  function computeGhost(target: EditorView): EditorGhost | null {
    const provider = ghost;
    const selection = target.state.selection.main;
    if (!provider || readonly || target.root.activeElement !== target.contentDOM || !selection.empty || completionStatus(target.state) === 'active') return null;
    return provider(target.state.doc.toString(), selection.head);
  }

  const ghostPlugin = ViewPlugin.fromClass(class {
    pending = false;
    target: EditorView;
    constructor(target: EditorView) { this.target = target; }
    update(update: ViewUpdate) {
      const completionChanged = completionStatus(update.startState) !== completionStatus(update.state);
      if (!update.docChanged && !update.selectionSet && !update.focusChanged && !completionChanged) return;
      if (this.pending) return;
      this.pending = true;
      queueMicrotask(() => {
        this.pending = false;
        const next = computeGhost(this.target);
        const current = this.target.state.field(ghostField, false) ?? null;
        if (!next && !current) return;
        if (next && current && next.text === current.text && next.from === current.from && next.to === current.to && next.insert === current.insert) return;
        this.target.dispatch({ effects: setGhost.of(next) });
      });
    }
  });

  function acceptGhost(target: EditorView) {
    const current = target.state.field(ghostField, false);
    if (!current) return false;
    target.dispatch({
      changes: { from: current.from, to: current.to, insert: current.insert },
      selection: { anchor: current.from + current.insert.length },
      effects: setGhost.of(null),
      userEvent: 'input.complete',
    });
    return true;
  }

  function dismissGhost(target: EditorView) {
    if (!target.state.field(ghostField, false)) return false;
    target.dispatch({ effects: setGhost.of(null) });
    return true;
  }

  const ghostExtension = [
    ghostField,
    ghostDecorations,
    ghostPlugin,
    Prec.highest(keymap.of([
      { key: 'Tab', run: acceptGhost },
      { key: 'Escape', run: dismissGhost },
    ])),
  ];

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

  function computeIssue(text: string): { position: number; message: string; source?: string } | null {
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
        issue = { position: view.state.doc.line(lineNumber).from, message: found.message, source: found.source ?? (language === 'yaml' ? 'YAML' : undefined) };
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

  type EditorIssue = { from: number; message: string; source?: string; severity: Diagnostic['severity'] };

  const issueField = StateField.define<EditorIssue | null>({
    create: () => null,
    update(current, tr) {
      let next = current && tr.docChanged ? { ...current, from: tr.changes.mapPos(current.from) } : current;
      for (const effect of tr.effects) {
        if (!effect.is(setDiagnosticsEffect)) continue;
        const first = [...effect.value].sort((a, b) => a.from - b.from)[0];
        next = first ? { from: first.from, message: first.message, source: first.source, severity: first.severity } : null;
      }
      return next;
    },
  });

  class IssueLineMarker extends GutterMarker {
    elementClass = 'cm-kurlo-issue-line';
  }
  const issueLineMarker = new IssueLineMarker();

  const issueGutter = gutterLineClass.compute([issueField], state => {
    const issue = state.field(issueField);
    if (!issue) return RangeSet.empty;
    return RangeSet.of([issueLineMarker.range(state.doc.lineAt(Math.min(issue.from, state.doc.length)).from)]);
  });

  function jumpToIssue(target: EditorView) {
    const issue = target.state.field(issueField);
    if (!issue) return;
    const pos = Math.min(issue.from, target.state.doc.length);
    target.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    target.focus();
  }

  function issueLabel(state: EditorState, issue: EditorIssue) {
    return `Line ${state.doc.lineAt(Math.min(issue.from, state.doc.length)).number}`;
  }

  const issueBadge = ViewPlugin.fromClass(class {
    dom: HTMLDivElement;
    announcer: HTMLSpanElement;
    button: HTMLButtonElement;
    line: HTMLSpanElement;
    message: HTMLSpanElement;
    badgeView: EditorView;
    onScroll: () => void;

    constructor(badgeView: EditorView) {
      this.badgeView = badgeView;
      this.dom = document.createElement('div');
      this.dom.className = 'cm-kurlo-issue-badge';
      this.announcer = document.createElement('span');
      this.announcer.className = 'cm-kurlo-issue-announcer';
      this.announcer.setAttribute('aria-live', 'polite');
      this.button = document.createElement('button');
      this.button.type = 'button';
      this.button.className = 'cm-kurlo-issue';
      this.button.hidden = true;
      this.line = document.createElement('span');
      this.line.className = 'cm-kurlo-issue-line-label';
      this.message = document.createElement('span');
      this.message.className = 'cm-kurlo-issue-message';
      this.button.append(this.line, this.message);
      this.button.addEventListener('mousedown', event => event.preventDefault());
      this.button.addEventListener('click', () => jumpToIssue(this.badgeView));
      this.dom.append(this.announcer, this.button);
      badgeView.dom.append(this.dom);
      this.onScroll = () => this.measure();
      badgeView.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
      this.render(badgeView.state);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.state.field(issueField) !== update.startState.field(issueField)) this.render(update.state);
      else if (update.viewportChanged || update.geometryChanged) this.measure();
    }

    render(state: EditorState) {
      const issue = state.field(issueField);
      const label = issue ? issueLabel(state, issue) : '';
      this.announcer.textContent = issue ? `${label}: ${issue.message}` : '';
      if (issue) {
        this.button.classList.toggle('warning', issue.severity === 'warning');
        this.line.textContent = label;
        this.message.textContent = issue.message;
        this.button.setAttribute('aria-label', `${label}: ${issue.message}. Go to the line`);
      }
      this.measure();
    }

    measure() {
      this.badgeView.requestMeasure({
        key: this,
        read: target => {
          const issue = target.state.field(issueField);
          if (!issue) return false;
          const block = target.lineBlockAt(Math.min(issue.from, target.state.doc.length));
          const scroller = target.scrollDOM.getBoundingClientRect();
          const top = target.documentTop + block.top;
          const bottom = target.documentTop + block.bottom;
          return bottom <= scroller.top + 2 || top >= scroller.bottom - 2;
        },
        write: offscreen => {
          this.button.hidden = !offscreen;
        },
      });
    }

    destroy() {
      this.badgeView.scrollDOM.removeEventListener('scroll', this.onScroll);
      this.dom.remove();
    }
  });

  const keepCursorOutOfFolds = EditorState.transactionFilter.of(tr => {
    const folds = tr.effects.filter(effect => effect.is(foldEffect)).map(effect => effect.value as { from: number; to: number });
    if (!folds.length) return tr;
    const selection = tr.newSelection;
    let moved = false;
    const ranges = selection.ranges.map(range => {
      const fold = folds.find(item => range.head > item.from && range.head <= item.to);
      if (!fold) return range;
      moved = true;
      return EditorSelection.cursor(tr.state.doc.lineAt(fold.to).to);
    });
    return moved ? [tr, { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true }] : tr;
  });

  const keepFocusOnFoldClick = ViewPlugin.fromClass(class {
    target: EditorView;
    onMouseDown = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('.cm-foldGutter')) event.preventDefault();
    };
    constructor(target: EditorView) {
      this.target = target;
      target.dom.addEventListener('mousedown', this.onMouseDown);
    }
    destroy() {
      this.target.dom.removeEventListener('mousedown', this.onMouseDown);
    }
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
          const source = document.createElement('div');
          source.className = 'cm-diagnosticSource';
          const lineNumber = hoverView.state.doc.lineAt(Math.min(start, hoverView.state.doc.length)).number;
          source.textContent = diagnostic.source ? `Line ${lineNumber} · ${diagnostic.source}` : `Line ${lineNumber}`;
          item.append(source);
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
    const sources: CompletionSource[] = [];
    if (completionSource) sources.push(context => completionSource?.(context) ?? null);
    if (!completionSource || includeVariableCompletions) sources.push(variableCompletionSource);
    return [
      ...(prose
        ? [EditorView.lineWrapping]
        : [lineNumbers(), foldGutter({ markerDOM: foldMarker }), highlightActiveLineGutter(), highlightActiveLine(), bracketMatching(), closeBrackets()]),
      editorExtensions,
      readonly ? [] : drawSelection(),
      history(),
      indentOnInput(),
      ...(completionSource ? [tooltips({ parent: document.body })] : []),
      autocompletion({
        override: sources,
        tooltipClass: () => completionSource ? 'script-completions' : '',
      }),
      commentDecorationPlugin,
      ghostExtension,
      kurloLinter,
      kurloLintTooltip,
      keepCursorOutOfFolds,
      keepFocusOnFoldClick,
      issueField,
      issueGutter,
      issueBadge,
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
    registerEditorView(view.dom, view);
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
        if (language === 'yaml') {
          view!.dispatch({ changes: textChange(current, next), annotations: isolateHistory.of('full') });
        } else {
          view!.dispatch({ changes: { from: 0, to: view!.state.doc.length, insert: next } });
        }
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
    if (view) unregisterEditorView(view.dom);
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
    return formatted !== null && applyFormattedText(formatted);
  }

  export function applyFormattedText(formatted: string) {
    if (!view || view.state.doc.toString() === formatted) return false;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: formatted },
      annotations: isolateHistory.of('full'),
    });
    onformat?.();
    return true;
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

  :global(.cm-wrap .cm-scroller:has(> .cm-cursorLayer)) {
    scrollbar-gutter: stable;
  }

  @supports (hanging-punctuation: first) {
    :global(.cm-wrap.fill .cm-scroller) {
      overflow-y: scroll;
    }
  }
  :global(.cm-wrap .cm-editor.cm-focused) {
    outline: none;
  }
  :global(.cm-wrap .cm-kurlo-commented-line),
  :global(.cm-wrap .cm-kurlo-commented-line span) {
    color: var(--text-3) !important;
  }
  :global(.cm-wrap .cm-lintRange) {
    --lint-color: var(--danger);
    padding-bottom: var(--space-0-5);
    background-image:
      linear-gradient(135deg, transparent 37.5%, var(--lint-color) 37.5% 62.5%, transparent 62.5%),
      linear-gradient(45deg, transparent 37.5%, var(--lint-color) 37.5% 62.5%, transparent 62.5%) !important;
    background-size: 0.25rem 0.1875rem !important;
    background-position: 0 100%, 0.125rem 100% !important;
    background-repeat: repeat-x !important;
    text-decoration: none !important;
  }
  :global(.cm-wrap .cm-lintRange-warning) {
    --lint-color: var(--warning);
  }
</style>
