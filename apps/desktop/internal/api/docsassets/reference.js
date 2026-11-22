(() => {
  const root = document.documentElement;
  const search = document.querySelector('#search');
  const sidebar = document.querySelector('#sidebar');
  const navigation = sidebar.querySelector('nav');
  const menu = document.querySelector('#menu');
  const results = document.querySelector('#results');
  const matches = document.querySelector('#matches');
  const methodFilter = document.querySelector('#method-filter');
  const resultCount = document.querySelector('#result-count');
  const theme = document.querySelector('#theme');
  const views = new Map([...document.querySelectorAll('main > .view')].map(view => [view.id, view]));
  const links = [...sidebar.querySelectorAll('a')];
  const entries = [...document.querySelectorAll('#overview .directory-row')].map(row => {
    const folder = row.parentElement.dataset.folder;
    const method = row.querySelector('.verb').dataset.kind;
    const text = [row.dataset.address, folder, ...[...row.children].slice(0, 3).map(item => item.textContent)].join(' ').toLowerCase();
    return { row, folder, method, text };
  });
  let noticeTimer;
  const variables = globalThis.kurloVariableReader(copy, notify);
  for (const method of [...new Set(entries.map(entry => entry.method).filter(Boolean))].sort()) {
    methodFilter.add(new Option(method, method));
  }
  if (entries.length > 60) {
    document.querySelectorAll('details.folder, details.directory:not([data-root])').forEach(folder => { folder.open = false; });
  }

  let snippetLanguage;
  try { snippetLanguage = localStorage.getItem('kurlo-docs-snippet'); } catch {}

  function selectLanguage(panel, language) {
    const tabs = [...panel.querySelectorAll('[role="tab"]')];
    const tab = tabs.find(item => item.dataset.lang === language) || tabs[0];
    if (!tab) return;
    for (const item of tabs) item.setAttribute('aria-selected', String(item === tab));
    for (const pre of panel.querySelectorAll('pre[data-lang]')) pre.hidden = pre.dataset.lang !== tab.dataset.lang;
    panel.querySelector('.code-head .copy').setAttribute('aria-label', 'Copy ' + tab.dataset.lang);
  }

  function clampDescriptions(view) {
    for (const description of view.querySelectorAll('.description:not(.clamp-box)')) {
      const prose = description.querySelector('.prose');
      description.classList.add('clamp-box');
      if (prose.scrollHeight <= 340) continue;
      description.classList.add('clamped');
      const more = document.createElement('button');
      more.className = 'more';
      more.type = 'button';
      more.textContent = 'Show more';
      more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', () => {
        const open = description.classList.toggle('clamped');
        more.textContent = open ? 'Show more' : 'Show less';
        more.setAttribute('aria-expanded', String(!open));
      });
      description.append(more);
    }
  }

  function unclamp(node) {
    const box = node.closest('.clamp-box.clamped');
    if (box) box.querySelector('.more').click();
  }

  function revealCurrentLink() {
    const current = navigation.querySelector('[aria-current="page"]');
    if (!current || !navigation.clientHeight) return;
    const link = current.getBoundingClientRect();
    const rail = navigation.getBoundingClientRect();
    if (link.top < rail.top) navigation.scrollTop -= rail.top - link.top + 10;
    else if (link.bottom > rail.bottom) navigation.scrollTop += link.bottom - rail.bottom + 10;
  }

  function setMenu(open) {
    sidebar.classList.toggle('expanded', open);
    menu.setAttribute('aria-expanded', String(open));
    if (open) revealCurrentLink();
  }

  function showView() {
    const target = document.getElementById(location.hash.slice(1));
    const active = target?.closest('main > .view') || views.get('overview');
    for (const view of views.values()) view.hidden = view !== active;
    for (const link of links) {
      if (link.hash === '#' + active.id) {
        link.setAttribute('aria-current', 'page');
        for (let folder = link.closest('details'); folder; folder = folder.parentElement.closest('details')) {
          folder.open = true;
        }
      } else {
        link.removeAttribute('aria-current');
      }
    }
    variables.show(active);
    for (const panel of active.querySelectorAll('.code-panel')) selectLanguage(panel, snippetLanguage);
    clampDescriptions(active);
    results.hidden = true;
    search.value = '';
    methodFilter.value = '';
    setMenu(false);
    revealCurrentLink();
  }

  function filter() {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
      showView();
      return;
    }
    for (const view of views.values()) view.hidden = true;
    for (const link of links) link.removeAttribute('aria-current');
    setMenu(false);
    variables.hide();
    const method = methodFilter.value;
    const found = entries.filter(entry => (!method || entry.method === method) && words.every(word => entry.text.includes(word)));
    const list = document.createDocumentFragment();
    for (const { row, folder } of found) {
      const match = row.cloneNode(true);
      const context = document.createElement('small');
      context.textContent = folder;
      match.querySelector('.directory-name').append(context);
      list.append(match);
    }
    matches.replaceChildren(list);
    resultCount.textContent = found.length
      ? found.length + (found.length === 1 ? ' matching endpoint' : ' matching endpoints')
      : 'No matching endpoints. Try a different search or method.';
    results.hidden = false;
    window.scrollTo(0, 0);
  }

  function navigate(focusHeading = true) {
    showView();
    window.scrollTo(0, 0);
    const target = document.getElementById(location.hash.slice(1));
    const heading = target?.matches('[data-section], .prose :is(h1,h2,h3,h4,h5,h6), .var-card > h2') ? target : document.querySelector('main > .view:not([hidden]) h1');
    if (heading === target) {
      unclamp(heading);
      for (let detail = heading.closest('details'); detail; detail = detail.parentElement.closest('details')) detail.open = true;
      heading.scrollIntoView();
    }
    if (focusHeading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }

  function setTheme(value) {
    root.dataset.theme = value;
    const dark = value === 'dark';
    theme.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    theme.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  }

  function notify(message) {
    const notice = document.querySelector('#notice');
    clearTimeout(noticeTimer);
    notice.textContent = message;
    noticeTimer = setTimeout(() => { notice.textContent = ''; }, 2200);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const field = document.createElement('textarea');
      field.value = text;
      const previous = document.activeElement;
      document.body.append(field);
      field.select();
      try {
        if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
      } finally {
        field.remove();
        previous?.focus({ preventScroll: true });
      }
    }
  }

  document.addEventListener('click', async event => {
    const tab = event.target.closest('.code-tabs [role="tab"]');
    if (tab) {
      snippetLanguage = tab.dataset.lang;
      try { localStorage.setItem('kurlo-docs-snippet', snippetLanguage); } catch {}
      for (const panel of document.querySelectorAll('.code-panel')) selectLanguage(panel, snippetLanguage);
      return;
    }
    const button = event.target.closest('button.copy, button.permalink');
    if (button) {
      const value = button.classList.contains('permalink')
        ? new URL('#' + button.closest('article').id, location.href).href
        : (scope => (scope.querySelector('pre:not([hidden]) code') || scope.querySelector('code')).textContent)(button.closest('.code-panel, .snippet, .route, .prompt-section'));
      try {
        await copy(value);
        notify('Copied to clipboard');
        const icon = button.querySelector('use');
        if (icon && !button.classList.contains('copied')) {
          const original = icon.getAttribute('href');
          icon.setAttribute('href', '#i-check');
          button.classList.add('copied');
          setTimeout(() => { icon.setAttribute('href', original); button.classList.remove('copied'); }, 1400);
        }
      } catch {
        notify('Clipboard unavailable');
      }
      return;
    }
    const link = event.target.closest('a[href^="#"]');
    if (link && link.hash === location.hash && views.has(link.hash.slice(1)) &&
        event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      navigate();
    }
  });

  search.addEventListener('input', filter);
  methodFilter.addEventListener('change', filter);
  document.addEventListener('keydown', event => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return;
    if (event.key === '/' && document.activeElement !== search) {
      event.preventDefault();
      search.focus();
      search.select();
    } else if (event.key === 'Escape') {
      if (!results.hidden || document.activeElement === search) {
        showView();
        search.focus();
      } else if (sidebar.classList.contains('expanded')) {
        setMenu(false);
        menu.focus();
      }
    } else if (!results.hidden) {
      const active = document.activeElement;
      if (active === search && event.key === 'Enter' && matches.firstElementChild) {
        event.preventDefault();
        matches.firstElementChild.click();
      } else if ((active === search || matches.contains(active)) && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'ArrowDown'
          ? (active === search ? matches.firstElementChild : active.nextElementSibling)
          : (active === search ? matches.lastElementChild : active.previousElementSibling || search);
        next?.focus();
      }
    }
  });
  menu.addEventListener('click', () => setMenu(!sidebar.classList.contains('expanded')));
  theme.addEventListener('click', () => {
    setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
    try { localStorage.setItem('kurlo-docs-theme', root.dataset.theme); } catch {}
  });
  let preference;
  try { preference = localStorage.getItem('kurlo-docs-theme'); } catch {}
  setTheme(preference === 'light' || preference === 'dark' ? preference : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  let closedDetails;
  window.addEventListener('beforeprint', () => {
    if (closedDetails) return;
    closedDetails = [...document.querySelectorAll('details:is(.directory, .snapshot, .example, .var-uses, .var-sources):not([open])')];
    for (const detail of closedDetails) detail.open = true;
    variables.resetTokens();
  });
  window.addEventListener('afterprint', () => {
    if (!closedDetails) return;
    for (const detail of closedDetails) detail.open = false;
    closedDetails = null;
    variables.restoreTokens();
  });
  document.querySelector('#print').addEventListener('click', () => window.print());
  window.addEventListener('hashchange', () => navigate());
  if (location.hash) navigate(false);
  else showView();
  root.classList.add('enhanced');
})();
