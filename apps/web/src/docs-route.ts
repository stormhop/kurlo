import { defineRouteMiddleware, type StarlightRouteData } from '@astrojs/starlight/route-data';
import { DOCS_HOME, docsSectionForPath, docsSectionPages } from '../docs.sidebar.mjs';

function sidebarHrefs(entries: StarlightRouteData['sidebar']): string[] {
  return entries.flatMap(entry => entry.type === 'group' ? sidebarHrefs(entry.entries) : [entry.href]);
}

export const onRequest = defineRouteMiddleware(({ locals }) => {
  const route = locals.starlightRoute;
  const path = `/${route.id}/`;
  const section = docsSectionForPath(path);

  if (path === DOCS_HOME || path === '/download/') {
    route.hasSidebar = false;
    route.pagination = { prev: undefined, next: undefined };
    return;
  }

  if (!section) return;

  const group = route.sidebar.find(entry => entry.type === 'group' && entry.label === section.label);
  if (group?.type !== 'group') return;
  route.sidebar = group.entries;

  const hrefs = new Set(sidebarHrefs(group.entries));
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const pages: { link: string; label: string }[] = docsSectionPages(section);
  const titles = new Map<string, string>([
    [`${base}${section.link}`, section.label],
    ...pages.map(item => [
      item.link.startsWith('/') ? `${base}${item.link}` : item.link,
      item.label,
    ] as const),
  ]);
  const pageInSection = (link: StarlightRouteData['pagination']['prev']) => {
    if (!link || !hrefs.has(link.href)) return undefined;
    return { ...link, label: titles.get(link.href) ?? link.label };
  };
  const { prev, next } = route.pagination;
  route.pagination = { prev: pageInSection(prev), next: pageInSection(next) };
});
