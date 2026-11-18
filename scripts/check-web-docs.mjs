#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DOCS_HOME, DOCS_SECTIONS, docsSectionPages, docsTopicPages } from '../apps/web/docs.sidebar.mjs';
import { absolute } from '../apps/web/site.config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(root, 'apps/web');
const contentRoot = join(webRoot, 'src/content/docs');
const screenshotsRoot = join(webRoot, 'src/assets/screenshots');
const distRoot = join(webRoot, 'dist');

const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function walk(dir, predicate = () => true) {
  const output = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...walk(path, predicate));
    else if (predicate(path)) output.push(path);
  }
  return output;
}

function stripQueryAndHash(input) {
  return input.split('#')[0].split('?')[0];
}

function distCandidates(urlPath) {
  const clean = stripQueryAndHash(decodeURIComponent(urlPath));
  if (clean === '/') return [join(distRoot, 'index.html')];
  const trimmed = clean.replace(/^\/+/, '').replace(/\/+$/, '');
  return [
    join(distRoot, trimmed, 'index.html'),
    join(distRoot, `${trimmed}.html`),
    join(distRoot, trimmed),
  ];
}

function distPathExists(urlPath) {
  return distCandidates(urlPath).some(path => existsSync(path));
}

function checkMarkdownAssets(files) {
  const imageLinkRe = /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const file of files) {
    const text = read(file);
    for (const match of text.matchAll(imageLinkRe)) {
      const raw = stripQueryAndHash(match[1]);
      if (/^(https?:|data:)/i.test(raw)) continue;
      const target = normalize(join(dirname(file), raw));
      if (!target.startsWith(webRoot)) {
        fail(`${relative(root, file)} references image outside apps/web: ${match[1]}`);
      } else if (!existsSync(target)) {
        fail(`${relative(root, file)} references missing image: ${match[1]}`);
      }
    }
  }
}

function checkInternalLinks(files) {
  const linkPatterns = [
    /\[[^\]]+]\((\/[^)\s#?]+)(?:[?#][^)]*)?\)/g,
    /\bhref=["'](\/[^"'#?]+)(?:[?#][^"']*)?["']/g,
  ];
  for (const file of files) {
    const text = read(file);
    for (const pattern of linkPatterns) {
      for (const match of text.matchAll(pattern)) {
        const href = match[1];
        if (href.startsWith('//')) continue;
        if (!distPathExists(href)) {
          fail(`${relative(root, file)} links to missing built page: ${href}`);
        }
      }
    }
  }
}

function checkBasePrefixedLinks() {
  const base = process.env.KURLO_SITE_BASE ?? '/';
  const normalized = base.endsWith('/') ? base.slice(0, -1) : base;
  if (!normalized) return;

  const attributeRe = /(?:href|src)="(\/[^"]*)"/g;
  for (const file of walk(distRoot, path => path.endsWith('.html'))) {
    const seen = new Set();
    for (const match of read(file).matchAll(attributeRe)) {
      const url = match[1];
      if (url.startsWith('//') || seen.has(url)) continue;
      seen.add(url);
      if (!url.startsWith(`${normalized}/`)) {
        fail(`${relative(root, file)} links to ${url}, which is missing the ${normalized} deploy base`);
      }
    }
  }
}

function checkDocumentationNavigation(contentFiles) {
  const base = (process.env.KURLO_SITE_BASE ?? '/').replace(/\/$/, '');
  const sectionByPath = new Map();
  const entriesBySection = new Map();
  for (const section of DOCS_SECTIONS) {
    const entries = [section.link, ...docsSectionPages(section).map(item => item.link)];
    entriesBySection.set(section, entries.map(link => link.startsWith('/') ? `${base}${link}` : link));
    for (const link of entries.filter(link => link.startsWith('/'))) {
      if (sectionByPath.has(link)) fail(`Documentation page belongs to multiple sections: ${link}`);
      sectionByPath.set(link, section);
    }
  }

  const paths = contentFiles
    .map(file => `/${relative(contentRoot, file).replaceAll('\\', '/').replace(/\.(mdx?|astro)$/i, '').replace(/\/index$/, '')}/`)
    .filter(path => path.startsWith(DOCS_HOME));
  const linkTargets = html => [...html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>/g)].map(match => match[1]);
  const containsSameLinks = (actual, expected) =>
    actual.length === expected.length && expected.every(link => actual.includes(link));
  const tabTargets = DOCS_SECTIONS.map(section => `${base}${section.link}`);

  for (const path of new Set([...paths, ...sectionByPath.keys()])) {
    const section = sectionByPath.get(path);
    if (!section && path !== DOCS_HOME) fail(`Documentation page has no section: ${path}`);

    const file = distCandidates(path).find(candidate => existsSync(candidate) && statSync(candidate).isFile());
    if (!file) {
      fail(`Documentation navigation points to a missing build output: ${path}`);
      continue;
    }
    const html = read(file);
    const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? '';
    const article = main.search(/<[^>]+\bclass="[^"]*\bsl-markdown-content\b/);
    const winterScenes = [...html.matchAll(/data-docs-winter="(hero|article)"/g)].map(match => match[1]);
    const lights = /<svg\b[^>]*class="[^"]*\bwinter-lights\b/.test(html);
    if (winterScenes.length !== 1 || winterScenes[0] !== (path === DOCS_HOME ? 'hero' : 'article') || lights !== (path === DOCS_HOME)) {
      fail(`Unexpected winter decoration on ${path}`);
    }
    if (path === DOCS_HOME) {
      if (html.includes('<docs-page-actions')) fail('The documentation homepage renders copy controls');
    } else {
      const actions = main.match(/<docs-page-actions\b[^>]*>([\s\S]*?)<\/docs-page-actions>/);
      const pageActions = actions?.[1] ?? '';
      const markdown = pageActions.match(/<template\b[^>]*>([\s\S]*?)<\/template>/)?.[1] ?? '';
      if (!markdown.startsWith('# ') || !markdown.includes(`Source: ${absolute(path)}`)) {
        fail(`Page actions are missing Markdown for ${path}`);
      }
      if ((pageActions.match(/<button\b[^>]*\bdata-copy-page\b/g)?.length ?? 0) !== 2 ||
          !pageActions.includes('popovertarget="docs-page-actions"')) {
        fail(`Page actions are missing copy controls for ${path}`);
      }
      if (!actions || actions.index >= article || html.indexOf('<docs-page-actions') < html.indexOf('<main')) {
        fail(`Page actions must be in the article heading on ${path}`);
      }
      const actionLinks = [...pageActions.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/g)];
      for (const chat of ['https://chatgpt.com/', 'https://claude.ai/new']) {
        const link = actionLinks.find(([, href]) => href.startsWith(`${chat}?`));
        const href = link?.[1];
        if (!href || !new URL(href).searchParams.get('q')?.endsWith(absolute(path))) {
          fail(`Page actions are missing the ${chat} link for ${path}`);
        }
        if (link && !/<svg\b[^>]*\bclass="[^"]*\bpage-action-brand\b/.test(link[0])) {
          fail(`Page actions are missing the ${chat} logo for ${path}`);
        }
      }
    }
    const feedback = main.match(/<docs-page-feedback\b[^>]*>([\s\S]*?)<\/docs-page-feedback>/);
    if (!feedback || feedback.index <= article || !feedback[0].includes(`data-path="${path}"`) ||
        !feedback[1].includes('data-vote="yes"') || !feedback[1].includes('data-vote="no"') ||
        (feedback[1].match(/<input\b[^>]*name="reason"/g)?.length ?? 0) !== 5) {
      fail(`Page feedback is missing or incomplete on ${path}`);
    }
    const tabs = html.match(/<nav\b[^>]*aria-label="Documentation sections"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
    if (!containsSameLinks(linkTargets(tabs), tabTargets)) fail(`Documentation section tabs are missing or incorrect on ${path}`);

    const sidebar = html.match(/<sl-sidebar-pane\b[^>]*>([\s\S]*?)<\/sl-sidebar-pane>/)?.[1];
    if (section) {
      const expected = entriesBySection.get(section);
      const articleLinks = linkTargets(sidebar ?? '').filter(link => expected.includes(link) || link.startsWith('/'));
      if (!containsSameLinks(articleLinks, expected)) fail(`Documentation sidebar shows incorrect articles on ${path}`);

      const headings = [...(sidebar ?? '').matchAll(/<h2\b[^>]*id="docs-sidebar-group-\d+"[^>]*>([^<]+)<\/h2>/g)]
        .map(match => match[1].replaceAll('&amp;', '&'));
      if (headings.join('\n') !== section.groups.map(group => group.label).join('\n')) {
        fail(`Documentation sidebar is missing section headings on ${path}`);
      }
      const disclosures = (sidebar ?? '').match(/<summary\b/g)?.length ?? 0;
      const guides = section.groups.flatMap(group => group.items).filter(item => docsTopicPages(item.link).length);
      if (disclosures !== guides.length) fail(`Documentation sidebar should only expand guides on ${path}`);

      const activeArticle = sidebar?.match(/<a\s[^>]*href="([^"]+)"[^>]*aria-current="page"/)?.[1];
      if (activeArticle !== `${base}${path}`) fail(`Documentation sidebar highlights the wrong article on ${path}`);

      const activeTab = tabs.match(/<a\s[^>]*href="([^"]+)"[^>]*aria-current="(?:true|page)"/)?.[1];
      if (activeTab !== `${base}${section.link}`) fail(`Documentation section is highlighted incorrectly on ${path}`);

      const neighboringPages = linkTargets([...html.matchAll(/<a\s[^>]*rel="(?:prev|next)"[^>]*>/g)].map(match => match[0]).join(''));
      if (neighboringPages.some(link => !expected.includes(link))) fail(`Previous or next page crosses documentation sections on ${path}`);
    } else if (path === DOCS_HOME) {
      if (sidebar) fail('The documentation homepage renders an article sidebar');
      if (/<div\b[^>]*class="pagination-links\b/.test(html)) fail('The documentation homepage renders an article footer');
      for (const id of ['beyond-the-basics', 'reference', 'conventions', 'need-something-the-docs-dont-cover']) {
        if (!html.includes(`id="${id}"`)) fail(`The documentation homepage is missing the existing #${id} anchor`);
      }
    }
  }
}

function checkLegacyFragments() {
  const base = (process.env.KURLO_SITE_BASE ?? '/').replace(/\/$/, '');
  const legacy = JSON.parse(read(join(webRoot, 'docs.legacy-fragments.json')));
  const cachedPages = new Map();
  const page = path => {
    if (!cachedPages.has(path)) {
      const file = join(distRoot, path.slice(1), 'index.html');
      cachedPages.set(path, existsSync(file) ? read(file) : '');
    }
    return cachedPages.get(path);
  };
  for (const [source, fragments] of Object.entries(legacy)) {
    const anchors = new Map([...page(source).matchAll(/<span\s[^>]*id="([^"]+)"[^>]*data-destination="([^"]+)"/g)]
      .map(match => [match[1], match[2]]));
    for (const [id, destination] of Object.entries(fragments)) {
      if (anchors.get(id) !== `${base}${destination}`) {
        fail(`Missing documentation link for ${source}#${id}`);
      }
      const [targetPath, targetId] = destination.split('#');
      const target = page(targetPath);
      if (!target || targetId && !target.includes(`id="${targetId}"`)) {
        fail(`Documentation link ${source}#${id} points to missing destination ${destination}`);
      }
    }
  }
}

function checkPagefind() {
  const pagefindDir = join(distRoot, 'pagefind');
  if (!existsSync(pagefindDir)) {
    fail('Pagefind output is missing: apps/web/dist/pagefind');
    return;
  }
  if (!existsSync(join(pagefindDir, 'pagefind.js'))) {
    fail('Pagefind runtime is missing: apps/web/dist/pagefind/pagefind.js');
  }
  const files = walk(pagefindDir);
  if (!files.some(path => path.endsWith('.pf_fragment'))) {
    fail('Pagefind index fragments are missing under apps/web/dist/pagefind');
  }
}

function checkCodeBackedDocs() {
  const stripGo = read(join(root, 'apps/desktop/internal/api/file_workspace_store_strip.go'));
  const secretsGo = read(join(root, 'apps/desktop/internal/api/file_workspace_store.go'));
  const schema = read(join(root, 'schemas/kurlo-workspace-yaml-v1.schema.json'));
  const publishedSchema = join(distRoot, 'schemas/kurlo-workspace-yaml-v1.schema.json');
  const yaml = join(contentRoot, 'docs/reference/kurlo-yaml-format');
  const yamlDoc = [read(join(yaml, 'request.md')), read(join(yaml, 'request-fields.md')), read(join(yaml, 'secrets.md'))].join('\n');
  const coverage = read(join(webRoot, 'DOCS_COVERAGE.md'));

  if (!existsSync(publishedSchema) || read(publishedSchema) !== schema) {
    fail('The built workspace YAML schema differs from schemas/kurlo-workspace-yaml-v1.schema.json.');
  }

  for (const field of ['oauth2GrantType', 'oauth2AuthURL', 'oauth2RefreshToken', 'oauth2TokenExpiry', 'oauth2UsePKCE']) {
    if (!stripGo.includes(`"${field}"`)) fail(`OAuth2 field ${field} is missing from authActiveFields`);
    if (!schema.includes(`"${field}"`)) fail(`OAuth2 field ${field} is missing from YAML schema`);
    if (!yamlDoc.includes(field)) fail(`OAuth2 field ${field} is missing from YAML reference docs`);
  }
  for (const field of ['jwtAlgorithm', 'jwtSecretBase64', 'jwtPayload', 'jwtHeaders', 'jwtExpiresIn', 'jwtAddTo', 'jwtHeaderPrefix', 'jwtQueryParam']) {
    if (!stripGo.includes(`"${field}"`)) fail(`JWT field ${field} is missing from authActiveFields`);
    if (!schema.includes(`"${field}"`)) fail(`JWT field ${field} is missing from YAML schema`);
    if (!yamlDoc.includes(field)) fail(`JWT field ${field} is missing from YAML reference docs`);
  }
  for (const field of ['jwtSecret', 'jwtPrivateKey']) {
    if (!secretsGo.includes(`"${field}"`)) fail(`${field} is not listed as a filesystem workspace secret field`);
    if (!yamlDoc.includes(`\`${field}\``)) fail(`${field} is missing from the YAML reference secret list`);
  }
  if (!secretsGo.includes('"oauth2RefreshToken"')) {
    fail('oauth2RefreshToken is not listed as a filesystem workspace secret field');
  }
  for (const snippet of ['wsHandshakeTimeoutMs: 0', 'wsReconnectIntervalMs: 5000', 'wsMaxMessageSizeMb: 10']) {
    if (!yamlDoc.includes(snippet)) fail(`YAML request settings example is out of sync: expected "${snippet}"`);
  }

  try {
    const latestTag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', '--exclude', 'v*-*'], { cwd: root, encoding: 'utf8' }).trim();
    if (latestTag && !coverage.includes(`desktop tag **${latestTag}**`)) {
      fail(`DOCS_COVERAGE.md audit tag is stale: expected ${latestTag}`);
    }
  } catch {
    warn('Skipping DOCS_COVERAGE tag drift check because no git tag is available in this checkout.');
  }
}

function checkFrontDoorDocs() {
  const ui = read(join(root, 'apps/desktop/frontend/src/lib/stores/ui.ts'));
  const constants = read(join(root, 'apps/desktop/frontend/src/lib/constants.ts'));
  const codegenDoc = read(join(contentRoot, 'docs/guides/code-generation.md'));
  const shortcutDoc = walk(join(contentRoot, 'docs/reference/keyboard-shortcuts'), path => path.endsWith('.md')).map(read).join('\n');
  const readme = read(join(root, 'README.md'));

  const languages = [...ui.matchAll(/^\s*'([a-z]+)',$/gm)].map(match => match[1]);
  const labels = [...ui.matchAll(/^\s*([a-z]+): '([^']+)',$/gm)].map(match => match[2]);
  if (languages.length) {
    for (const text of [codegenDoc, readme]) {
      if (!text.includes(`${languages.length} `)) {
        fail(`Code-generation target count is stale: SNIPPET_LANGUAGES has ${languages.length}`);
      }
    }
  }
  for (const label of labels) {
    const bare = label.replace(/`/g, '');
    const family = bare.split(' ')[0];
    if (!codegenDoc.includes(family)) fail(`Code-generation guide does not mention the ${label} target`);
  }

  const combos = [...constants.matchAll(/defaultCombo: '([^']+)'/g)].map(match => match[1].replace(/\\\\/g, '\\'));
  const docKeys = expandShortcutRanges(shortcutDoc);
  for (const combo of combos) {
    const rendered = combo
      .split('+')
      .map(part => {
        if (part === 'Meta') return 'Cmd/Ctrl';
        if (part === '\\') return 'Backslash';
        if (part === 'ArrowUp') return '\u2191';
        if (part === 'ArrowDown') return '\u2193';
        if (part === 'ArrowLeft') return '\u2190';
        if (part === 'ArrowRight') return '\u2192';
        return part;
      })
      .join(' ');
    if (!docKeys.includes(rendered)) {
      fail(`Keyboard-shortcuts reference does not document the default binding ${combo} (expected "${rendered}")`);
    }
  }
}

function expandShortcutRanges(text) {
  const rangeRe = /`Cmd\/Ctrl (\d)` \u2026 `Cmd\/Ctrl (\d)`/g;
  let expanded = text;
  for (const match of text.matchAll(rangeRe)) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    for (let key = from; key <= to; key += 1) expanded += ` \`Cmd/Ctrl ${key}\``;
  }
  return expanded;
}

function checkWinterLandingPages() {
  for (const [route, scarves] of [['/', 1], ['/mcp/', 1], ['/agent/', 2], ['/pricing/', 0], [DOCS_HOME, 0]]) {
    const file = distCandidates(route).find(existsSync);
    const html = file ? read(file) : '';
    const layers = html.match(/<div class="landing-snow(?:\s|")/g) ?? [];
    const birds = html.match(/<g class="tail-front(?:\s|")/g) ?? [];
    if (!file || layers.length !== Number(scarves > 0) || birds.length !== scarves) {
      fail(`Unexpected snow or scarf count on ${route}`);
    }
  }
}

function checkScreenshotInventory() {
  const expected = [
    'auth-oauth2-token-fetch.png',
    'cookie-jar-populated.png',
    'examples-panel.png',
    'mock-server.png',
    'response-diff-example.png',
    'git-workspace.png',
    'headers-tab.png',
    'import-postman.png',
    'request-editor.png',
    'request-grpc.png',
    'request-graphql.png',
    'request-settings.png',
    'request-socketio.png',
    'request-sse.png',
    'request-websocket.png',
    'response-viewer-search.png',
    'response-viewer-large-body.png',
    'scripting-pre-request.png',
  ];
  for (const name of expected) {
    const path = join(screenshotsRoot, name);
    if (!existsSync(path)) fail(`Expected docs screenshot is missing: ${relative(root, path)}`);
    else if (statSync(path).size < 1024) fail(`Docs screenshot looks too small: ${relative(root, path)}`);
  }
}

if (!existsSync(distRoot)) {
  fail('Build output is missing. Run npm run web:build before npm run web:check-docs.');
} else {
  const contentFiles = walk(contentRoot, path => /\.(mdx?|astro)$/i.test(path));
  checkMarkdownAssets(contentFiles);
  checkInternalLinks(contentFiles);
  checkBasePrefixedLinks();
  checkDocumentationNavigation(contentFiles);
  checkLegacyFragments();
  checkPagefind();
  checkCodeBackedDocs();
  checkFrontDoorDocs();
  checkWinterLandingPages();
  checkScreenshotInventory();
}

for (const message of warnings) console.warn(`docs-check warning: ${message}`);
if (errors.length) {
  console.error('docs-check failed:');
  for (const message of errors) console.error(`- ${message}`);
  process.exit(1);
}

console.log('docs-check passed.');
