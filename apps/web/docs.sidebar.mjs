import { GITHUB_RELEASES } from './site.constants.mjs';
import { DOCS_TOPICS } from './docs.topics.mjs';

const guide = (label, slug, expanded = false) => ({ label, link: `/docs/guides/${slug}/`, expanded });
const start = (label, slug, expanded = false) => ({ label, link: `/docs/getting-started/${slug}/`, expanded });
const reference = (label, slug, expanded = false) => ({ label, link: `/docs/reference/${slug}/`, expanded });

export const DOCS_HOME = '/docs/';

export function isDocumentationPath(path) {
  return path.startsWith(DOCS_HOME) || path.startsWith('/changelog/') || path === '/privacy/';
}

const topicGroups = new Map(Object.entries(DOCS_TOPICS));

export function docsTopicPages(link) {
  return (topicGroups.get(link) ?? []).map(([slug, label]) => ({ label, link: `${link}${slug}/` }));
}

export function docsSectionPages(section) {
  return section.groups.flatMap(({ items }) => items.flatMap(item => [item, ...docsTopicPages(item.link)]));
}

export function docsParentTopic(path, section) {
  return section?.groups.flatMap(group => group.items).find(item =>
    docsTopicPages(item.link).some(page => page.link === path),
  );
}

function sidebarItem({ expanded = false, ...item }) {
  const pages = docsTopicPages(item.link);
  if (!pages.length) return item;
  return {
    label: item.label,
    collapsed: !expanded,
    items: [{ ...item, label: 'Overview' }, ...pages],
  };
}

export const DOCS_SECTIONS = [
  Object.freeze({
    label: 'Getting started',
    link: '/docs/getting-started/',
    icon: 'rocket',
    description: 'Install Kurlo, send your first request, and bring over collections from Postman, Insomnia, or Bruno.',
    groups: [
      {
        label: 'Start using Kurlo',
        items: [
          start('Installation', 'installation', true),
          start('Your first request', 'first-request'),
          start('Migrating to Kurlo', 'migrating'),
        ],
      },
    ],
  }),
  Object.freeze({
    label: 'Requests',
    link: '/docs/requests/',
    icon: 'random',
    description: 'Choose a request type, configure auth and network settings, and inspect responses.',
    groups: [
      {
        label: 'Send requests',
        items: [
          guide('Request types', 'request-types', true),
          guide('Authentication', 'authentication', true),
          guide('Per-request settings', 'request-settings'),
        ],
      },
      {
        label: 'Inspect responses',
        items: [
          guide('Response viewer', 'response-viewer'),
          guide('Request history', 'history'),
        ],
      },
      {
        label: 'Network & browser',
        items: [
          guide('Cookies', 'cookies'),
          guide('Proxy configuration', 'proxy'),
          guide('Browser security emulation', 'browser-security'),
        ],
      },
    ],
  }),
  Object.freeze({
    label: 'Workspaces',
    link: '/docs/workspaces/',
    icon: 'code-branch',
    description: 'Organize collections and environments, share work with Git, and import or sync OpenAPI specs.',
    groups: [
      {
        label: 'Organize requests',
        items: [
          guide('Workspaces & collections', 'workspaces', true),
          guide('Collection defaults', 'collection-defaults'),
          guide('Environments & variables', 'environments', true),
        ],
      },
      {
        label: 'Share & move data',
        items: [
          guide('Git-backed workspaces', 'git-workspaces'),
          guide('Import & export', 'import-export'),
          guide('OpenAPI sync', 'openapi-sync'),
          guide('Backup & recovery', 'backup-recovery'),
        ],
      },
    ],
  }),
  Object.freeze({
    label: 'Testing & CLI',
    link: '/docs/testing/',
    icon: 'approve-check-circle',
    description: 'Write assertions, mock APIs, and run collection and k6 load tests from the app or CLI.',
    groups: [
      {
        label: 'Write & run tests',
        items: [
          guide('Scripting (pre-request & tests)', 'scripting', true),
          guide('Collection Runner', 'collection-runner'),
        ],
      },
      {
        label: 'Examples & mocking',
        items: [
          guide('Response examples', 'examples'),
          guide('Mock server', 'mock-server'),
          guide('Capture proxy', 'capture-proxy'),
        ],
      },
      {
        label: 'CLI & load testing',
        items: [
          guide('CLI runner (run & load)', 'cli-runner', true),
          guide('Load testing with k6', 'load-testing'),
        ],
      },
    ],
  }),
  Object.freeze({
    label: 'Agent & MCP',
    link: '/docs/agents/',
    icon: 'puzzle',
    description: 'Run and edit requests in Agent mode, or connect an external assistant through the MCP server.',
    groups: [
      {
        label: 'Connect & configure',
        items: [
          guide('Agent mode', 'agent', true),
          guide('MCP server (kurlo mcp)', 'mcp-server', true),
        ],
      },
    ],
  }),
  Object.freeze({
    label: 'Reference',
    link: '/docs/reference/',
    icon: 'open-book',
    description: 'Find code snippets, scripting and YAML references, shortcuts, settings, and performance tools.',
    groups: [
      {
        label: 'Code & formats',
        items: [
          guide('Code snippets', 'code-generation'),
          reference('Scripting API', 'scripting-api', true),
          reference('Kurlo YAML format', 'kurlo-yaml-format', true),
        ],
      },
      {
        label: 'Desktop app',
        items: [
          guide('App settings', 'settings'),
          reference('Keyboard shortcuts', 'keyboard-shortcuts'),
          reference('Performance dock', 'performance'),
          reference('Performance fixtures', 'performance-fixtures'),
        ],
      },
    ],
  }),
  Object.freeze({
    label: 'Help',
    link: '/docs/help/',
    icon: 'question-circle',
    description: 'Troubleshoot common problems, get support, and read about privacy and releases.',
    groups: [
      {
        label: 'Get support',
        items: [
          { label: 'Troubleshooting', link: '/docs/troubleshooting/', expanded: true },
          { label: 'FAQ', link: '/docs/faq/' },
          { label: 'Support Kurlo', link: '/docs/support/' },
        ],
      },
      {
        label: 'About Kurlo',
        items: [
          { label: 'Privacy & security', link: '/privacy/' },
          { label: 'Changelog', link: '/changelog/' },
          { label: 'Releases', link: GITHUB_RELEASES, attrs: { target: '_blank' } },
        ],
      },
    ],
  }),
];

export const DOCS_SIDEBAR = [
  { label: 'Overview', link: DOCS_HOME },
  ...DOCS_SECTIONS.map(({ label, link, groups }) => ({
    label,
    collapsed: true,
    items: [
      { label: 'Overview', link },
      ...groups.map(group => ({ ...group, items: group.items.map(sidebarItem) })),
    ],
  })),
];

export function docsSectionForPath(path) {
  return DOCS_SECTIONS.find(section =>
    section.link === path || docsSectionPages(section).some(item => item.link === path),
  );
}
