import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { GITHUB_LATEST_RELEASE, GITHUB_RELEASES, GITHUB_SOURCE, SITE_NAME } from './site.constants.mjs';

const NPM_PACKAGE = 'https://www.npmjs.com/package/@kurlo/cli';
const MCP_REGISTRY_ENTRY = 'https://registry.modelcontextprotocol.io/v0/servers/dev.kurlo%2Fkurlo/versions/latest';

function latestVersion() {
  const changelog = readFileSync(resolve(process.cwd(), 'src/content/docs/changelog.md'), 'utf8');
  return changelog.match(/^## (\d+\.\d+\.\d+)\s*$/m)?.[1];
}

export const SOFTWARE_VERSION = latestVersion();

export function structuredData({ siteRoot, description, screenshot = '', page = { url: '', name: '', description: '' } }) {
  const root = siteRoot.endsWith('/') ? siteRoot : `${siteRoot}/`;
  const organization = {
    '@type': 'Organization',
    '@id': `${root}#organization`,
    name: SITE_NAME,
    url: root,
    logo: { '@type': 'ImageObject', url: `${root}apple-touch-icon.png`, width: 180, height: 180 },
    sameAs: [GITHUB_SOURCE, NPM_PACKAGE],
  };
  const website = {
    '@type': 'WebSite',
    '@id': `${root}#website`,
    name: SITE_NAME,
    url: root,
    inLanguage: 'en',
    publisher: { '@id': organization['@id'] },
  };
  const application = {
    '@type': 'SoftwareApplication',
    '@id': `${root}#software`,
    name: SITE_NAME,
    description,
    applicationCategory: 'DeveloperApplication',
    applicationSubCategory: 'API client',
    operatingSystem: 'macOS, Windows, Linux',
    ...(SOFTWARE_VERSION && { softwareVersion: SOFTWARE_VERSION }),
    releaseNotes: `${root}changelog/`,
    url: root,
    downloadUrl: GITHUB_LATEST_RELEASE,
    installUrl: `${root}download/`,
    image: `${root}og.png`,
    ...(screenshot && { screenshot }),
    license: 'https://opensource.org/licenses/MIT',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    author: { '@id': organization['@id'] },
    publisher: { '@id': organization['@id'] },
    sameAs: [GITHUB_SOURCE, GITHUB_RELEASES, NPM_PACKAGE, MCP_REGISTRY_ENTRY],
  };
  const graph = [organization, website, application];
  if (page.url) {
    graph.push({
      '@type': 'WebPage',
      '@id': `${page.url}#webpage`,
      url: page.url,
      name: page.name,
      description: page.description,
      inLanguage: 'en',
      isPartOf: { '@id': website['@id'] },
      about: { '@id': application['@id'] },
      ...(screenshot && { primaryImageOfPage: screenshot }),
    });
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph });
}
