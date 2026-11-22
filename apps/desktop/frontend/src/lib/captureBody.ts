export function indentJsonLoose(text: string): string {
  let out = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  const pad = () => '\n' + '  '.repeat(Math.max(0, depth));
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '{' || ch === '[') {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      if (text[next] === (ch === '{' ? '}' : ']')) {
        out += ch + text[next];
        i = next;
      } else {
        depth += 1;
        out += ch + pad();
      }
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      out += pad() + ch;
    } else if (ch === ',') {
      out += ',' + pad();
    } else if (ch === ':') {
      out += ': ';
    } else {
      out += ch;
    }
  }
  return out;
}

function looksLikeJson(text: string) {
  const first = text.trimStart()[0];
  return first === '{' || first === '[';
}

export function formatJsonBody(text: string): string | null {
  if (!looksLikeJson(text)) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return indentJsonLoose(text);
  }
}

export function formatEventStream(text: string): string {
  return text.split(/\r\n|\r|\n/).map(line => {
    const match = /^(data|event|id|retry):\s?(.*)$/.exec(line);
    if (!match) return line;
    const [, field, value] = match;
    const json = field === 'data' ? formatJsonBody(value) : null;
    return `${field}: ${json ?? value}`;
  }).join('\n');
}

export function formatCapturedBody(text: string, eventStream: boolean): { text: string; json: boolean } {
  if (eventStream) return { text: formatEventStream(text), json: false };
  const json = formatJsonBody(text);
  return json === null ? { text, json: false } : { text: json, json: true };
}
