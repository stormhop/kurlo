import { getCollection } from 'astro:content';
import { DOCS_SIDEBAR } from '../../docs.sidebar.mjs';
import { SITE_NAME } from '../../site.constants.mjs';
import { absolute } from '../../site.config.mjs';

type SidebarItem = { label: string; link?: string; items?: SidebarItem[] };

export type LlmsPage = { group: string; label: string; url: string; description: string; body: string };

export const LLMS_SUMMARY =
  'Kurlo is a free, open-source (MIT) desktop API client for HTTP, GraphQL, gRPC, WebSocket, Socket.IO, SSE and MCP. No account, no seats, no cloud, no telemetry: collections are plain YAML files on your disk, and Git is how a team shares them.';

export const LLMS_DETAILS = [
  'It runs Postman `pm.*` scripts as written, imports Postman, Insomnia, Bruno, OpenAPI and HAR, and has a local mock server, a collection runner, and browser CORS and CSP checks.',
  'For AI agents, `kurlo mcp` is an MCP server that lists, runs and edits the saved requests of a workspace and reads what the user sent from the app. `npx -y @kurlo/cli mcp install` adds it to Claude Code, Cursor, Codex, VS Code and other clients. `kurlo run` runs collections in CI.',
];

function pageLink(id: string): string {
  const slug = id.replace(/(^|\/)index$/, '').replace(/\/$/, '');
  return slug ? `/${slug}/` : '/';
}

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&amp;': '&' };

function stripTags(line: string): string {
  const withCode = line.replace(/<code>([\s\S]*?)<\/code>/g, (_, code: string) => `\`${code}\``);
  return withCode
    .split(/(`[^`]*`)/)
    .map(part => (part.startsWith('`') ? part : part.replace(/<\/?[A-Za-z][A-Za-z0-9.-]*(\s[^<>]*)?\/?>/g, '')))
    .join('')
    .replace(/&(lt|gt|quot|#39|nbsp|amp);/g, entity => ENTITIES[entity]);
}

function cleanBody(body: string): string {
  let fenced = false;
  const lines: string[] = [];
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      lines.push(line);
      continue;
    }
    if (fenced) {
      lines.push(line);
      continue;
    }
    if (/^\s*import\s.+from\s/.test(line) || /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line)) continue;
    const text = stripTags(line);
    if (text.trim() === '' && line.trim() !== '') continue;
    lines.push(text === line ? line : text.trim());
  }
  return lines
    .join('\n')
    .replace(/\]\(\/(?!\/)/g, `](${absolute('/')}`)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function llmsPages(): Promise<LlmsPage[]> {
  const entries = await getCollection('docs');
  const byLink = new Map(entries.map(entry => [pageLink(entry.id), entry]));
  const pages: LlmsPage[] = [];
  const add = (group: string, item: SidebarItem) => {
    if (!item.link?.startsWith('/')) return;
    const entry = byLink.get(item.link);
    if (!entry) return;
    pages.push({
      group,
      label: item.label,
      url: absolute(item.link),
      description: entry.data.description ?? '',
      body: cleanBody(entry.body ?? ''),
    });
  };
  for (const item of DOCS_SIDEBAR as SidebarItem[]) {
    if (item.items) {
      for (const child of item.items) add(item.label, child);
    } else {
      add('Docs', item);
    }
  }
  return pages;
}

export function textResponse(body: string): Response {
  return new Response(`${body.trim()}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

export function llmsHeader(): string {
  return [`# ${SITE_NAME}`, '', `> ${LLMS_SUMMARY}`, '', ...LLMS_DETAILS.flatMap(line => [line, ''])].join('\n');
}
