import { GITHUB_RELEASES } from './site.constants.mjs';

export const DOCS_SIDEBAR = [
  { label: 'Overview', link: '/docs/' },
  {
    label: 'Getting started',
    items: [
      { label: 'Installation', link: '/docs/getting-started/installation/' },
      { label: 'Your first request', link: '/docs/getting-started/first-request/' },
      { label: 'Migrating from Postman / Insomnia', link: '/docs/getting-started/migrating/' },
    ],
  },
  {
    label: 'Guides',
    items: [
      { label: 'App settings', link: '/docs/guides/settings/' },
      { label: 'Authentication', link: '/docs/guides/authentication/' },
      { label: 'Environments & variables', link: '/docs/guides/environments/' },
      { label: 'Workspaces & collections', link: '/docs/guides/workspaces/' },
      { label: 'Collection defaults', link: '/docs/guides/collection-defaults/' },
      { label: 'Request types', link: '/docs/guides/request-types/' },
      { label: 'Response viewer', link: '/docs/guides/response-viewer/' },
      { label: 'Response examples', link: '/docs/guides/examples/' },
      { label: 'Mock server', link: '/docs/guides/mock-server/' },
      { label: 'Per-request settings', link: '/docs/guides/request-settings/' },
      { label: 'Browser security emulation', link: '/docs/guides/browser-security/' },
      { label: 'Proxy configuration', link: '/docs/guides/proxy/' },
      { label: 'Cookies', link: '/docs/guides/cookies/' },
      { label: 'Request history', link: '/docs/guides/history/' },
      { label: 'Scripting (pre-request & tests)', link: '/docs/guides/scripting/' },
      { label: 'Collection Runner', link: '/docs/guides/collection-runner/' },
      { label: 'Load testing with k6', link: '/docs/guides/load-testing/' },
      { label: 'CLI runner (run & load)', link: '/docs/guides/cli-runner/' },
      { label: 'MCP server (kurlo mcp)', link: '/docs/guides/mcp-server/' },
      { label: 'Git-backed workspaces', link: '/docs/guides/git-workspaces/' },
      { label: 'Import & export', link: '/docs/guides/import-export/' },
      { label: 'Backup & recovery', link: '/docs/guides/backup-recovery/' },
      { label: 'Code generation', link: '/docs/guides/code-generation/' },
    ],
  },
  {
    label: 'Reference',
    items: [
      { label: 'Scripting API', link: '/docs/reference/scripting-api/' },
      { label: 'Kurlo YAML format', link: '/docs/reference/kurlo-yaml-format/' },
      { label: 'Performance fixtures', link: '/docs/reference/performance-fixtures/' },
      { label: 'Keyboard shortcuts', link: '/docs/reference/keyboard-shortcuts/' },
    ],
  },
  {
    label: 'Help',
    items: [
      { label: 'Troubleshooting', link: '/docs/troubleshooting/' },
      { label: 'FAQ', link: '/docs/faq/' },
      { label: 'Privacy & security', link: '/privacy/' },
      { label: 'Changelog', link: '/changelog/' },
      { label: 'Releases', link: GITHUB_RELEASES, attrs: { target: '_blank' } },
    ],
  },
];
