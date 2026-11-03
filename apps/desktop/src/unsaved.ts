const checks = new Set<() => boolean>();

export function registerUnsaved(check: () => boolean): () => void {
  checks.add(check);
  return () => void checks.delete(check);
}

export function hasUnsaved(): boolean {
  for (const c of checks) if (c()) return true;
  return false;
}
