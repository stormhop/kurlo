
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';


import {
  GITHUB_SOURCE,
  SITE_BASE,
  SITE_BASE_PATH,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_URL,
} from './site.config.mjs';
import { DOCS_SIDEBAR } from './docs.sidebar.mjs';
import { structuredData } from './site.schema.mjs';

const SITE = SITE_URL;
const BASE = SITE_BASE;
const BASE_NORMALIZED = SITE_BASE_PATH;

function sourcesFor(pathname) {
  const route = pathname.slice(BASE_NORMALIZED.length).replace(/^\/+|\/+$/g, '');
  if (route === '') return ['src/pages/index.astro'];
  if (route.startsWith('vs/')) return ['src/pages/vs/[tool].astro', 'src/lib/competitors.ts'];
  const candidates = [
    `src/pages/${route}.astro`,
    ...['md', 'mdx'].flatMap(ext => [`src/content/docs/${route}.${ext}`, `src/content/docs/${route}/index.${ext}`]),
  ];
  return candidates.filter(file => existsSync(file)).slice(0, 1);
}

function lastModified(pathname) {
  const files = sourcesFor(pathname);
  if (!files.length) return undefined;
  try {
    const date = execFileSync('git', ['log', '-1', '--format=%cI', '--', ...files], { encoding: 'utf8' }).trim();
    return date || undefined;
  } catch {
    return undefined;
  }
}

function rehypeBasePaths() {
  if (!BASE_NORMALIZED) return () => tree => tree;
  const prefixed = value =>
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.startsWith(`${BASE_NORMALIZED}/`);

  return () => tree => {
    const walk = node => {
      if (node.type === 'element' && node.properties) {
        for (const attribute of ['href', 'src']) {
          if (prefixed(node.properties[attribute])) {
            node.properties[attribute] = `${BASE_NORMALIZED}${node.properties[attribute]}`;
          }
        }
      }
      if (Array.isArray(node.attributes)) {
        for (const attribute of node.attributes) {
          if (['href', 'src'].includes(attribute.name) && prefixed(attribute.value)) {
            attribute.value = `${BASE_NORMALIZED}${attribute.value}`;
          }
        }
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
    return tree;
  };
}

function rehypeShortcutKeys() {
  return () => (tree, file) => {
    const path = String(file?.path ?? file?.history?.[0] ?? '');
    if (!path.endsWith('keyboard-shortcuts.md')) return tree;
    const text = node => (node.children ?? []).map(child => (child.type === 'text' ? child.value : text(child))).join('');
    const walk = (node, inCell) => {
      if (node.type !== 'element' && node.type !== 'root') return;
      const cell = inCell || node.tagName === 'td';
      node.children = (node.children ?? []).map(child => {
        if (cell && child.type === 'element' && child.tagName === 'code') {
          const keys = text(child).trim().split(/\s+/).filter(Boolean);
          return {
            type: 'element',
            tagName: 'span',
            properties: { className: ['kurlo-keys'] },
            children: keys.map(key => ({ type: 'element', tagName: 'kbd', properties: {}, children: [{ type: 'text', value: key === 'Backslash' ? '\\' : key }] })),
          };
        }
        walk(child, cell);
        return child;
      });
    };
    walk(tree, false);
    return tree;
  };
}

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'always',
  markdown: {
    processor: unified({ rehypePlugins: [rehypeBasePaths(), rehypeShortcutKeys()] }),
  },
  integrations: [
    starlight({
      title: SITE_NAME,
      description: SITE_TAGLINE,
      logo: {
        src: './src/assets/logo.png',
        replacesTitle: false,
      },
      favicon: '/favicon-32.png',
      customCss: ['@fontsource-variable/geist', '@fontsource-variable/geist-mono', './src/styles/custom.css'],
      components: {
        Header: './src/components/Header.astro',
        PageTitle: './src/components/PageTitle.astro',
        Footer: './src/components/Footer.astro',
      },
      expressiveCode: {
        themes: ['github-dark-default'],
        useStarlightDarkModeSwitch: false,
        styleOverrides: {
          borderRadius: '10px',
          borderColor: 'var(--kurlo-code-line)',
          codeBackground: 'var(--kurlo-code-bg)',
          codeFontFamily: 'var(--sl-font-mono)',
          codeFontSize: '0.84rem',
          codeLineHeight: '1.7',
          uiFontFamily: 'var(--sl-font)',
          frames: {
            shadowColor: 'transparent',
            editorTabBarBackground: 'var(--kurlo-code-bar)',
            editorActiveTabBackground: 'var(--kurlo-code-bg)',
            editorActiveTabIndicatorTopColor: 'transparent',
            editorActiveTabIndicatorBottomColor: 'transparent',
            editorTabBarBorderBottomColor: 'var(--kurlo-code-line)',
            terminalBackground: 'var(--kurlo-code-bg)',
            terminalTitlebarBackground: 'var(--kurlo-code-bar)',
            terminalTitlebarBorderBottomColor: 'var(--kurlo-code-line)',
            terminalTitlebarDotsOpacity: '0.3',
            inlineButtonBorder: 'var(--kurlo-code-line)',
          },
        },
      },
      social: [{ icon: 'github', label: 'GitHub', href: GITHUB_SOURCE }],
      head: [
        {
          tag: 'meta',
          attrs: { property: 'og:site_name', content: SITE_NAME },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:type', content: 'website' },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:image', content: `${SITE}${BASE_NORMALIZED}/og.png` },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:image:width', content: '1200' },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:image:height', content: '630' },
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:card', content: 'summary_large_image' },
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:image', content: `${SITE}${BASE_NORMALIZED}/og.png` },
        },

        {
          tag: 'link',
          attrs: { rel: 'apple-touch-icon', href: `${BASE_NORMALIZED}/apple-touch-icon.png` },
        },
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: structuredData({ siteRoot: `${SITE}${BASE_NORMALIZED}/`, description: SITE_TAGLINE }),
        },
      ],
      sidebar: DOCS_SIDEBAR,
      lastUpdated: true,
      pagefind: true,
      disable404Route: true,
    }),
    sitemap({
      filter: page => !page.endsWith('/pricing/'),
      serialize: item => {
        const lastmod = lastModified(new URL(item.url).pathname);
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
  ],
});
