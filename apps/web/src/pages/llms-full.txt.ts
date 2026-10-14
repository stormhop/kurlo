import type { APIRoute } from 'astro';
import { llmsHeader, llmsPages, textResponse } from '../lib/llms';

export const GET: APIRoute = async () => {
  const pages = (await llmsPages()).filter(page => page.group !== 'Docs');
  const body = [
    llmsHeader(),
    ...pages.flatMap(page => [`# ${page.label}`, '', `Source: ${page.url}`, '', ...(page.description ? [`> ${page.description}`, ''] : []), page.body, '']),
  ].join('\n');
  return textResponse(body);
};
