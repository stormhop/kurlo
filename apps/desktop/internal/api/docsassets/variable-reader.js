globalThis.kurloVariableReader = function (copy, notify) {
  const popup = document.querySelector('#var-popover');
  const toggle = document.querySelector('#var-toggle');
  const picker = document.querySelector('#var-environment');
  const index = new Map();
  const requestRows = new Map();
  let cachedScope;
  const environments = new Map([...document.querySelectorAll('#environments [data-env-id]')].map(card => [card.dataset.envId, card.querySelector('h2').textContent.trim()]));
  const pattern = /\{\{([^{}]+)\}\}/g;
  let trigger;
  let timer;
  let active;
  let showValues = false;

  for (const card of document.querySelectorAll('#variables .var-card')) {
    const item = { id: card.querySelector('h2').id, environments: new Map() };
    for (const row of card.querySelectorAll('[data-scope]')) {
      const { scope, source, env, disabled, masked } = row.dataset;
      if (scope === 'Environment') environments.set(env, source);
      if (disabled === 'true') continue;
      const value = row.querySelector('dd code')?.textContent || '';
      for (const binding of row.querySelectorAll('[data-order]')) {
        const definition = { value, masked: masked === 'true', scope, source, env, order: Number(binding.dataset.order) };
        if (scope === 'Request') {
          const id = binding.hash.slice(1);
          if (!requestRows.has(id)) requestRows.set(id, []);
          requestRows.get(id).push({ name: card.dataset.name, definition });
        } else if (scope === 'Environment') {
          const previous = item.environments.get(env);
          if (!previous || previous.order < definition.order) item.environments.set(env, definition);
        } else if (!item[scope] || item[scope].order < definition.order) {
          item[scope] = definition;
        }
      }
    }
    index.set(card.dataset.name, item);
  }

  for (const rows of requestRows.values()) rows.sort((a, b) => a.definition.order - b.definition.order);

  function shared(name, env) {
    const item = index.get(name);
    if (!item) return [];
    if (!env && item.environments.size) return [...item.environments.values()];
    const definition = item.environments.get(env) || item.Collection || item.Global;
    return definition ? [definition] : [];
  }

  function interpolate(definition, lookup, ancestors = []) {
    if (definition.masked) return null;
    let remaining = 65536;
    function expand(text, path) {
      if (path.length >= 20 || !text.includes('{{')) return text;
      const parts = [];
      let end = 0;
      for (const match of text.matchAll(pattern)) {
        const key = match[1].trim();
        const rows = lookup(key);
        if (rows.length === 1 && rows[0].masked) return null;
        let part = match[0];
        if (!path.includes(key) && rows.length === 1) {
          remaining -= rows[0].value.length + 1;
          if (remaining < 0) return text;
          part = expand(rows[0].value, [...path, key]);
          if (part === null) return null;
        }
        parts.push(text.slice(end, match.index), part);
        end = match.index + match[0].length;
      }
      parts.push(text.slice(end));
      return parts.join('');
    }
    return expand(definition.value, ancestors);
  }

  function choices(name, requestId, env) {
    if (cachedScope?.id !== requestId || cachedScope.env !== env) {
      const local = new Map();
      const lookup = key => local.has(key) ? [local.get(key)] : shared(key, env);
      for (const { name: key, definition } of requestRows.get(requestId) || []) {
        const value = interpolate(definition, lookup);
        local.set(key, { ...definition, masked: value === null, value: value ?? '' });
      }
      cachedScope = { id: requestId, env, lookup };
    }
    return cachedScope.lookup(name);
  }

  function resolved(definition, requestId, name, env) {
    return interpolate(definition, key => choices(key, requestId, env), [name]);
  }

  function display(token) {
    const name = token.dataset.name;
    const requestId = token.closest('article').id;
    const rows = choices(name, requestId, picker?.value);
    const value = showValues && rows.length === 1 ? resolved(rows[0], requestId, name, rows[0].env || picker?.value) : null;
    token.textContent = value === null ? token.dataset.literal : value;
  }

  function prepare(article) {
    if (article.dataset.tokensReady) return;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.data.includes('{{') && node.parentElement.closest('code, .prose, .properties dd, .table-wrap td') &&
          !node.parentElement.closest('a, button, textarea, [data-literal]')) nodes.push(node);
    }
    for (const node of nodes) {
      const fragment = document.createDocumentFragment();
      let end = 0;
      for (const match of node.data.matchAll(pattern)) {
        fragment.append(node.data.slice(end, match.index));
        const token = document.createElement('button');
        token.type = 'button';
        token.className = 'var-token';
        token.dataset.name = match[1].trim();
        token.dataset.literal = token.textContent = match[0];
        token.setAttribute('aria-label', 'Inspect variable ' + token.dataset.name);
        token.setAttribute('aria-haspopup', 'dialog');
        fragment.append(token);
        end = match.index + match[0].length;
      }
      if (end) {
        fragment.append(node.data.slice(end));
        node.replaceWith(fragment);
      }
    }
    article.dataset.tokensReady = 'true';
  }

  function hide() {
    clearTimeout(timer);
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    trigger = null;
    popup.hidden = true;
  }

  function show(view) {
    hide();
    active = view?.matches('article') ? view : null;
    if (!active) return;
    prepare(active);
    active.querySelectorAll('.var-token').forEach(display);
  }

  function resetTokens() {
    for (const token of document.querySelectorAll('.var-token')) {
      token.textContent = token.dataset.literal;
    }
  }

  function restoreTokens() {
    active?.querySelectorAll('.var-token').forEach(display);
  }

  function position() {
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popup.offsetWidth - 8));
    const below = rect.bottom + 4;
    const top = below + popup.offsetHeight <= window.innerHeight - 8 ? below : Math.max(8, rect.top - popup.offsetHeight - 4);
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  }

  function open(token) {
    clearTimeout(timer);
    if (trigger === token && !popup.hidden) return;
    hide();
    trigger = token;
    trigger.setAttribute('aria-expanded', 'true');
    const name = token.dataset.name;
    const requestId = token.closest('article').id;
    const rows = choices(name, requestId, picker?.value);
    popup.querySelector('strong').textContent = name;
    popup.querySelector('header span').textContent = rows[0]?.scope || 'Undefined';
    const list = popup.querySelector('.hint-values');
    list.replaceChildren();
    if (!rows.length) list.textContent = 'No enabled value in this scope.';
    for (const definition of rows) {
      const line = document.createElement('div');
      if (definition.scope === 'Environment') {
        const label = document.createElement('small');
        label.textContent = definition.source;
        line.append(label);
      }
      const value = resolved(definition, requestId, name, definition.env || picker?.value);
      const code = document.createElement('code');
      code.textContent = value === null ? 'Hidden value' : value || 'Empty string';
      line.append(code);
      if (value !== null && value !== '') {
        const button = document.createElement('button');
        button.className = 'icon-button';
        button.type = 'button';
        button.setAttribute('aria-label', 'Copy variable value');
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        button.append(icon);
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', '#i-copy');
        icon.append(use);
        button.onclick = async () => {
          try { await copy(value); notify('Copied to clipboard'); }
          catch { notify('Clipboard unavailable'); }
        };
        line.append(button);
      }
      list.append(line);
    }
    const link = popup.querySelector('a');
    link.hidden = !index.has(name);
    if (!link.hidden) link.setAttribute('href', '#' + index.get(name).id);
    popup.hidden = false;
    position();
  }

  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const token = event.target.closest('.var-token');
    if (token) open(token);
    else if (popup.contains(event.target)) clearTimeout(timer);
  });
  function closeLater(event) {
    if (trigger && (trigger.contains(event.target) || popup.contains(event.target)) &&
        !trigger.contains(event.relatedTarget) && !popup.contains(event.relatedTarget)) {
      clearTimeout(timer);
      timer = setTimeout(hide, 200);
    }
  }
  document.addEventListener('pointerout', closeLater);
  document.addEventListener('focusout', closeLater);
  document.addEventListener('focusin', event => {
    const token = event.target.closest('.var-token');
    if (token) open(token);
    else if (popup.contains(event.target)) clearTimeout(timer);
  });
  document.addEventListener('click', event => {
    const token = event.target.closest('.var-token');
    if (token) open(token);
    else if (!popup.contains(event.target)) hide();
  });
  document.addEventListener('keydown', event => {
    if (!trigger) return;
    if (event.key === 'Escape') {
      if (popup.contains(document.activeElement)) trigger.focus();
      hide();
      event.stopImmediatePropagation();
    } else if (document.activeElement === trigger && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      popup.querySelector('button, a:not([hidden])')?.focus();
    } else if (event.key === 'Tab' && !event.shiftKey && popup.contains(document.activeElement) && document.activeElement === popup.querySelector('a')) {
      trigger.focus();
      hide();
    }
  });
  window.addEventListener('resize', hide);
  document.addEventListener('scroll', event => { if (!popup.contains(event.target)) hide(); }, true);
  if (picker) {
    picker.add(new Option('All environments', ''));
    for (const [id, name] of environments) picker.add(new Option(name, id));
    picker.hidden = environments.size < 2;
    picker.onchange = () => show(active);
  }
  if (toggle) toggle.onclick = () => {
    showValues = !showValues;
    toggle.setAttribute('aria-checked', String(showValues));
    show(active);
  };
  return { show, hide, resetTokens, restoreTokens };
};
