export type Part = { code: string } | { text: string };

export function codeParts(text: string, terms: RegExp): Part[] {
  return text.split(terms).map((part, i) => (i % 2 ? { code: part } : { text: part }));
}
