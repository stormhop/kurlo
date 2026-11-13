export function openExternalURL(url: string) {
  if (window.runtime?.BrowserOpenURL) {
    window.runtime.BrowserOpenURL(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export const KURLO_DOCS_URL = 'https://kurlo.dev/docs/';

export const KURLO_BOOSTY_URL = 'https://boosty.to/kurlo';

export function kurloDocsURL(query = '') {
  const text = query.trim();
  return text ? `${KURLO_DOCS_URL}?q=${encodeURIComponent(text)}` : KURLO_DOCS_URL;
}
