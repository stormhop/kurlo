export type Mark = 'yes' | 'part' | 'no';
export type Cell = { mark: Mark; text: string; note?: string };
export type Row = { label: string; kurlo: Cell; other: Cell };
export type Point = { title: string; text: string };

export type Competitor = {
  slug: string;
  name: string;
  summary: string;
  highlights: string[];
  title: string;
  description: string;
  lead: string;
  rows: Row[];
  reasons: Point[];
  migrate: { intro: string; steps: string[]; carries: string; link: string };
  sources: { label: string; url: string }[];
};

export const CHECKED_ON = '15 October 2026';

const kurlo = {
  price: { mark: 'yes', text: 'Free, every feature', note: 'No paid plan to grow into' },
  account: { mark: 'yes', text: 'Not needed' },
  storage: { mark: 'yes', text: 'Your disk, as YAML in your Git repo' },
  sharing: { mark: 'yes', text: 'Any Git host, no seat limit' },
  license: { mark: 'yes', text: 'MIT' },
  runtime: { mark: 'yes', text: 'Native Go with the system WebView' },
  scripts: { mark: 'yes', text: 'pm.* scripts run as written' },
  mock: { mark: 'yes', text: 'Local, no request cap', note: 'Works offline, no account' },
  mcp: { mark: 'yes', text: 'MCP client and MCP server', note: 'Agents can run and write your collections' },
  cors: { mark: 'yes', text: 'Built in' },
  cookies: { mark: 'yes', text: 'Extension for Chromium and Firefox' },
} satisfies Record<string, Cell>;

export const competitors: Competitor[] = [
  {
    slug: 'postman',
    name: 'Postman',
    summary: 'Postman’s free plan is one user now. Kurlo has no plans at all, needs no account and runs your scripts as they are.',
    highlights: ['Free for a team of any size, shared through Git', 'pm.* scripts, chai and pm.sendRequest run unchanged', 'Mock server on localhost, no account'],
    title: 'Kurlo vs Postman: a free, open-source Postman alternative',
    description: 'Kurlo and Postman compared on price, accounts, where collections live, scripts, mock servers and MCP. Kurlo runs Postman pm.* scripts as written, needs no account and is free for a team of any size.',
    lead: 'Postman is a cloud API platform with a desktop app. Kurlo is a desktop API client that keeps everything on your disk. If you use Postman to send requests, run tests and share collections, Kurlo does that without an account or a per-seat plan, and your pm.* scripts come with you unchanged.',
    rows: [
      { label: 'Price', kurlo: kurlo.price, other: { mark: 'part', text: 'Free for 1 user', note: 'Solo $9, Team $19 per user a month' } },
      { label: 'Account', kurlo: kurlo.account, other: { mark: 'part', text: 'Required for collections', note: 'Signed out, it only sends one-off requests' } },
      { label: 'Team sharing', kurlo: kurlo.sharing, other: { mark: 'part', text: 'Team plan', note: 'Free users cannot create or join a team workspace' } },
      { label: 'Where collections live', kurlo: kurlo.storage, other: { mark: 'part', text: 'Postman’s cloud', note: 'Or local files with Native Git in the desktop app' } },
      { label: 'Source code', kurlo: kurlo.license, other: { mark: 'no', text: 'Closed' } },
      { label: 'Built on', kurlo: kurlo.runtime, other: { mark: 'part', text: 'Electron' } },
      { label: 'Postman scripts', kurlo: kurlo.scripts, other: { mark: 'yes', text: 'Native' } },
      { label: 'Mock server', kurlo: kurlo.mock, other: { mark: 'part', text: 'Cloud-hosted', note: 'Needs an account' } },
      { label: 'MCP', kurlo: kurlo.mcp, other: { mark: 'yes', text: 'MCP client' } },
      { label: 'Browser CORS and CSP checks', kurlo: kurlo.cors, other: { mark: 'no', text: 'No' } },
      { label: 'Sync cookies from your browser', kurlo: kurlo.cookies, other: { mark: 'yes', text: 'Interceptor extension' } },
    ],
    reasons: [
      { title: 'No seat math', text: 'Since March 2026 Postman’s Free plan is one user, and working together starts at $19 per user a month. Kurlo has no plan at all: a team shares a workspace through any Git host, however many people are on it.' },
      { title: 'Scripts keep working', text: 'Pre-request and test scripts run in Kurlo as they were written for Postman: pm.test, pm.expect with chai, pm.sendRequest, CryptoJS, require for lodash, ajv and uuid, and legacy globals such as tests[] and postman.setEnvironmentVariable.' },
      { title: 'No account in between', text: 'Open the app and send. Collections, environments and history stay on your machine, and secrets stay in an encrypted local file instead of a cloud vault.' },
      { title: 'Collections reviewed in pull requests', text: 'Every request is a readable YAML file in your repository, so an API change and the requests that test it land in the same commit.' },
      { title: 'Mocks without the cloud', text: 'Saved responses from your Postman collection become examples, and Kurlo serves them on localhost while the real endpoint is still being built.' },
      { title: 'See what the browser will do', text: 'Send a request the way a page on another origin would, and get the CORS or CSP error before your users do.' },
    ],
    migrate: {
      intro: 'Postman’s own export carries over, and nothing in Postman is changed.',
      steps: [
        'In Postman, export the collection as Collection v2.1, and export each environment.',
        'Drop the files on Kurlo’s sidebar, or use the import button next to +.',
        'Pick an environment and send a request you use often to check it.',
      ],
      carries: 'Folders, requests, bodies, auth (Basic, Bearer, API key, Digest, OAuth 2.0 and AWS SigV4), environments, saved responses as examples, and pre-request and test scripts. Kurlo can also export a collection back to Postman v2.1.',
      link: 'docs/getting-started/migrating/',
    },
    sources: [{ label: 'Postman pricing', url: 'https://www.postman.com/pricing/' }],
  },
  {
    slug: 'insomnia',
    name: 'Insomnia',
    summary: 'Everything Insomnia asks an account or a Pro seat for, Kurlo does from the first launch.',
    highlights: ['No account, not even to save a collection', 'Git sharing with no user cap', 'Mocks without a monthly quota'],
    title: 'Kurlo vs Insomnia: an Insomnia alternative with no account',
    description: 'Kurlo and Insomnia compared on price, accounts, Git sharing, scripts, mock servers and MCP. Kurlo needs no account, has no user cap on Git sharing and serves mocks locally without a quota.',
    lead: 'Insomnia is Kong’s API client, with cloud, local and Git storage, and an account for anything beyond its Scratch Pad. Kurlo needs no account at all, keeps every collection as YAML files you commit, and puts no cap on how many people share them through Git.',
    rows: [
      { label: 'Price', kurlo: kurlo.price, other: { mark: 'part', text: 'Free for up to 3 Git Sync users', note: 'Pro $12, Enterprise $45 per user a month' } },
      { label: 'Account', kurlo: kurlo.account, other: { mark: 'part', text: 'Required beyond Scratch Pad' } },
      { label: 'Team sharing', kurlo: kurlo.sharing, other: { mark: 'part', text: 'Git Sync', note: 'More than 3 users needs Pro' } },
      { label: 'Where collections live', kurlo: kurlo.storage, other: { mark: 'part', text: 'Cloud, local or Git' } },
      { label: 'Source code', kurlo: kurlo.license, other: { mark: 'yes', text: 'Apache-2.0' } },
      { label: 'Built on', kurlo: kurlo.runtime, other: { mark: 'part', text: 'Electron' } },
      { label: 'Postman scripts', kurlo: kurlo.scripts, other: { mark: 'part', text: 'Compatibility layer' } },
      { label: 'Mock server', kurlo: kurlo.mock, other: { mark: 'part', text: '1,000 mock requests a month on free', note: '10,000 on Pro, then paid packs' } },
      { label: 'MCP', kurlo: kurlo.mcp, other: { mark: 'yes', text: 'MCP client' } },
      { label: 'Browser CORS and CSP checks', kurlo: kurlo.cors, other: { mark: 'no', text: 'No' } },
      { label: 'Sync cookies from your browser', kurlo: kurlo.cookies, other: { mark: 'no', text: 'No' } },
    ],
    reasons: [
      { title: 'No account, ever', text: 'Collections, environments and history work from the first launch, with nothing to sign in to and no organization to create.' },
      { title: 'Git without a user cap', text: 'A Kurlo workspace is a folder of YAML files. Commit, pull and push from the app or your terminal, with as many teammates as the repository has.' },
      { title: 'Mocks without a quota', text: 'The mock server runs on localhost and serves your saved examples for as many requests as your tests send.' },
      { title: 'Postman scripts as they are', text: 'Collections that came from Postman keep their pm.* scripts, and they run unchanged, including chai assertions and pm.sendRequest.' },
      { title: 'An agent that keeps the collection current', text: 'kurlo mcp lets Claude Code, Codex or Cursor add the request and its tests for an endpoint it just wrote, in the same commit.' },
      { title: 'See what the browser will do', text: 'Send a request the way a page on another origin would, and get the CORS or CSP error before your users do.' },
    ],
    migrate: {
      intro: 'Kurlo reads Insomnia’s export directly and recognizes the format by itself.',
      steps: [
        'In Insomnia, open Preferences, then Data, and export your data as Insomnia v4 JSON.',
        'Drop the file on Kurlo’s sidebar, or use the import button next to +.',
        'Pick an environment and send a request you use often to check it.',
      ],
      carries: 'Each workspace becomes a collection, request groups become folders, and requests keep their URL, method, headers, body and auth. Environments come across, and template tags that are plain variables become {{variables}}.',
      link: 'docs/getting-started/migrating/#from-insomnia',
    },
    sources: [{ label: 'Insomnia pricing', url: 'https://insomnia.rest/pricing' }],
  },
  {
    slug: 'bruno',
    name: 'Bruno',
    summary: 'The same files-in-Git idea, with nothing held back for a paid edition.',
    highlights: ['Private Git hosts and push from the app, free', 'pm.* scripts are not converted to bru.*', 'Browser CORS checks, cookie sync and an MCP server'],
    title: 'Kurlo vs Bruno: a Git-based API client with no paid edition',
    description: 'Kurlo and Bruno compared: both keep collections as files in Git with no account. Kurlo has no paid edition, runs Postman pm.* scripts without converting them, and adds browser CORS checks, cookie sync and an MCP server.',
    lead: 'Bruno and Kurlo start from the same idea: no account, and collections as files in your Git repository. They differ in what is free and what comes in the box. Kurlo has no paid edition, runs Postman scripts without converting them, and adds browser checks, cookie sync and an MCP server for your agent.',
    rows: [
      { label: 'Price', kurlo: kurlo.price, other: { mark: 'part', text: 'Free core', note: 'Pro $6, Ultimate $11 per user a month' } },
      { label: 'Account', kurlo: kurlo.account, other: { mark: 'yes', text: 'Not needed' } },
      { label: 'Where collections live', kurlo: kurlo.storage, other: { mark: 'yes', text: 'Your disk and your Git repo' } },
      { label: 'Private Git hosts', kurlo: { mark: 'yes', text: 'Any host' }, other: { mark: 'part', text: 'Pro', note: 'Free works with public providers' } },
      { label: 'Commit and push in the app', kurlo: { mark: 'yes', text: 'Included' }, other: { mark: 'part', text: 'Pro', note: 'Free can clone, diff and pull' } },
      { label: 'Workspaces', kurlo: { mark: 'yes', text: 'Unlimited' }, other: { mark: 'part', text: '2 on free' } },
      { label: 'Data-driven runs', kurlo: { mark: 'yes', text: 'CSV and JSON data files' }, other: { mark: 'part', text: 'Pro' } },
      { label: 'Source code', kurlo: kurlo.license, other: { mark: 'yes', text: 'MIT core', note: 'Paid editions on top' } },
      { label: 'Built on', kurlo: kurlo.runtime, other: { mark: 'part', text: 'Electron' } },
      { label: 'Postman scripts', kurlo: kurlo.scripts, other: { mark: 'part', text: 'Converted to bru.* on import', note: 'Complex scripts need rewriting' } },
      { label: 'Mock server', kurlo: kurlo.mock, other: { mark: 'yes', text: 'Local' } },
      { label: 'Browser CORS and CSP checks', kurlo: kurlo.cors, other: { mark: 'no', text: 'No' } },
      { label: 'Sync cookies from your browser', kurlo: kurlo.cookies, other: { mark: 'no', text: 'No' } },
    ],
    reasons: [
      { title: 'Nothing behind an edition', text: 'Private Git hosts, commit and push from the app, data-driven runs and any number of workspaces are all in the one free download.' },
      { title: 'pm.* stays pm.*', text: 'Scripts imported from Postman are not translated to another API. They run as written, so the same script works in Kurlo and in the Postman collection a colleague still uses.' },
      { title: 'See what the browser will do', text: 'Send a request the way a page on another origin would, and get the CORS or CSP error before your users do.' },
      { title: 'Your browser session', text: 'An extension for Chrome, Edge, Brave and Firefox sends the cookies of the site you are signed into, so a request to a session-protected API just works.' },
      { title: 'Built for agents', text: 'kurlo mcp lets Claude Code, Codex or Cursor run your saved requests and write new ones with tests. Secrets stay masked and protected environments are off limits.' },
    ],
    migrate: {
      intro: 'Kurlo imports Bruno collections saved in the OpenCollection format, and the original files are not touched.',
      steps: [
        'In Kurlo, click the import button next to + and choose Bruno.',
        'Pick the collection. Kurlo adds it to the current workspace.',
        'Pick an environment and send a request you use often to check it.',
      ],
      carries: 'Folders, including empty ones, and requests, GraphQL included, with the settings the format describes.',
      link: 'docs/guides/import-export/#from-brunoopencollection',
    },
    sources: [{ label: 'Bruno pricing', url: 'https://www.usebruno.com/pricing' }],
  },
];
