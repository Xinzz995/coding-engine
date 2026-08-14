export function summarizeTopLevelPaths(
  paths: readonly string[],
): readonly { readonly topLevel: string; readonly paths: readonly string[] }[] {
  const groups = new Map<
    string,
    { readonly topLevel: string; readonly paths: string[]; readonly seen: Set<string> }
  >();

  for (const path of paths) {
    const normalized = path
      .trim()
      .replaceAll('\\', '/')
      .replace(/^(?:\.\/)+/u, '');
    if (normalized.length === 0) continue;

    const separator = normalized.indexOf('/');
    const topLevel = separator === -1 ? '.' : normalized.slice(0, separator);
    let group = groups.get(topLevel);
    if (group === undefined) {
      group = { topLevel, paths: [], seen: new Set<string>() };
      groups.set(topLevel, group);
    }
    if (group.seen.has(normalized)) continue;

    group.seen.add(normalized);
    group.paths.push(normalized);
  }

  return [...groups.values()].map(({ topLevel, paths: groupPaths }) => ({
    topLevel,
    paths: [...groupPaths],
  }));
}
