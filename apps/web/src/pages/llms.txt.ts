import type { APIRoute } from 'astro';
import { absolute } from '../../site.config.mjs';
import { llmsHeader, llmsPages, textResponse } from '../lib/llms';

const OPTIONAL_GROUPS = new Set(['Help']);

export const GET: APIRoute = async () => {
  const pages = await llmsPages();
  const groups = new Map<string, string[]>();
  for (const page of pages) {
    const group = OPTIONAL_GROUPS.has(page.group) ? 'Optional' : page.group;
    const line = `- [${page.label}](${page.url})${page.description ? `: ${page.description}` : ''}`;
    groups.set(group, [...(groups.get(group) ?? []), line]);
  }
  const optional = groups.get('Optional') ?? [];
  groups.delete('Optional');
  const sections = [...groups.entries(), ...(optional.length ? [['Optional', optional] as const] : [])];
  const body = [
    llmsHeader(),
    `All of the documentation in one file: ${absolute('/llms-full.txt')}`,
    '',
    ...sections.flatMap(([group, lines]) => [`## ${group}`, '', ...lines, '']),
  ].join('\n');
  return textResponse(body);
};
