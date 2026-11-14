const onDisk = new WeakSet<object>();

export function markExamplesOnDisk(examples: unknown) {
  if (Array.isArray(examples)) onDisk.add(examples);
}

export function examplesOnDisk(examples: unknown): boolean {
  return Array.isArray(examples) && onDisk.has(examples);
}
