import type { ProxyRule } from './wire';

export type RuleKind = 'local' | 'rewrite';

export interface CompiledPattern {
  regex: RegExp;
  withQuery: boolean;
  wildcardScheme: boolean;
}

export function compileRulePattern(raw: string): CompiledPattern | null {
  const pattern = raw.trim();
  if (!pattern || pattern.length > 2048 || /\s/.test(pattern)) return null;
  const separator = pattern.indexOf('://');
  if (separator < 0) return null;
  const scheme = pattern.slice(0, separator).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https' && scheme !== '*') return null;
  const rest = pattern.slice(separator + 3);
  const slash = rest.indexOf('/');
  const host = slash < 0 ? rest : rest.slice(0, slash);
  if (!host) return null;
  const normalized = `${scheme}://${normalizePatternHost(scheme, host)}/${slash < 0 ? '*' : rest.slice(slash + 1)}`;
  const source = normalized.split('*').map(part => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*');
  return { regex: new RegExp(`^${source}$`), withQuery: normalized.includes('?'), wildcardScheme: scheme === '*' };
}

export function matchTarget(raw: string, withQuery: boolean) {
  let url: URL;
  try { url = new URL(raw); } catch { return ''; }
  const path = url.pathname || '/';
  const value = `${url.protocol.replace(/:$/, '').toLowerCase()}://${hostForWire(raw, url)}${path}`;
  return withQuery && url.search ? value + url.search : value;
}

export function ruleMatches(rule: Pick<ProxyRule, 'method' | 'url'>, method: string, url: string) {
  if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) return false;
  const compiled = compileRulePattern(rule.url);
  if (!compiled) return false;
  const target = matchTarget(url, compiled.withQuery);
  if (compiled.regex.test(target)) return true;
  return !compiled.wildcardScheme && compiled.regex.test(matchTargetWithDefaultPort(url, compiled.withQuery));
}

export function patternForURL(raw: string) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname || '/'}`;
  } catch {
    return raw;
  }
}

function hostForWire(raw: string, url: URL) {
  const authority = raw.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1]?.split('@').at(-1) ?? '';
  const explicitPort = authority.match(/:(\d+)$/)?.[1];
  return `${url.hostname.toLowerCase()}${explicitPort ? `:${explicitPort}` : ''}`;
}

function normalizePatternHost(scheme: string, host: string) {
  const lower = host.toLowerCase();
  if ((scheme === 'http' && lower.endsWith(':80')) || (scheme === 'https' && lower.endsWith(':443'))) return lower.slice(0, lower.lastIndexOf(':'));
  return lower;
}

function matchTargetWithDefaultPort(raw: string, withQuery: boolean) {
  let url: URL;
  try { url = new URL(raw); } catch { return ''; }
  const authority = raw.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1]?.split('@').at(-1) ?? '';
  const explicitPort = authority.match(/:(\d+)$/)?.[1];
  const defaultPort = (url.protocol === 'http:' && explicitPort === '80') || (url.protocol === 'https:' && explicitPort === '443');
  const host = `${url.hostname.toLowerCase()}${explicitPort && !defaultPort ? `:${explicitPort}` : ''}`;
  const value = `${url.protocol.replace(/:$/, '').toLowerCase()}://${host}${url.pathname || '/'}`;
  return withQuery && url.search ? value + url.search : value;
}

export function newRuleID() {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function blankRule(kind: RuleKind, method = '', url = ''): ProxyRule {
  return {
    id: newRuleID(),
    name: '',
    enabled: true,
    kind,
    method,
    url,
    hits: 0,
    local: { status: 200, contentType: 'application/json', body: '', delayMs: 0, rateKiB: 0, errorPercent: 0, pause: false, script: '' },
    rewrite: { target: '', pathFrom: '', pathTo: '', setRequestHeaders: [], removeRequestHeaders: [], setResponseHeaders: [], removeResponseHeaders: [] },
  };
}

export function ruleSummary(rule: ProxyRule) {
  if (rule.kind === 'local') {
    const extras = [rule.local.delayMs ? `${rule.local.delayMs} ms delay` : '', rule.local.rateKiB ? `${rule.local.rateKiB} KiB/s` : '', rule.local.errorPercent ? `${rule.local.errorPercent}% 503` : '', rule.local.pause ? 'pauses' : '', rule.local.script.trim() ? 'hooks' : ''].filter(Boolean);
    return [`Responds ${rule.local.status}`, ...extras].join(' · ');
  }
  const action = rule.rewrite;
  const parts = [
    action.target ? `to ${action.target}` : '',
    action.pathFrom ? `${action.pathFrom} → ${action.pathTo || '(removed)'}` : '',
    headerChanges('request', (action.setRequestHeaders ?? []).length + (action.removeRequestHeaders ?? []).length),
    headerChanges('response', (action.setResponseHeaders ?? []).length + (action.removeResponseHeaders ?? []).length),
  ].filter(Boolean);
  return parts.join(' · ') || 'No changes';
}

function headerChanges(side: string, count: number) {
  return count ? `${count} ${side} header ${count === 1 ? 'change' : 'changes'}` : '';
}

export function headerNames(text: string) {
  return text.split(/[\s,]+/).map(name => name.trim()).filter(Boolean);
}
