export function textChange(before: string, after: string) {
  let from = 0;
  const commonLength = Math.min(before.length, after.length);
  while (from < commonLength && before.charCodeAt(from) === after.charCodeAt(from)) from++;
  let to = before.length;
  let end = after.length;
  while (to > from && end > from && before.charCodeAt(to - 1) === after.charCodeAt(end - 1)) {
    to--;
    end--;
  }
  return { from, to, insert: after.slice(from, end) };
}
