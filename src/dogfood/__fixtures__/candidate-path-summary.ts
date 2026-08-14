export function summarizeTopLevelPaths(
  paths: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const groupedPaths = new Map<string, string[]>();
  const seenPaths = new Set<string>();

  for (const path of paths) {
    if (path.trim() === '') continue;

    const normalizedPath = path.replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '');
    if (seenPaths.has(normalizedPath)) continue;

    seenPaths.add(normalizedPath);
    const separatorIndex = normalizedPath.indexOf('/');
    const topLevel = separatorIndex === -1 ? '.' : normalizedPath.slice(0, separatorIndex);
    const existingGroup = groupedPaths.get(topLevel);

    if (existingGroup) existingGroup.push(normalizedPath);
    else groupedPaths.set(topLevel, [normalizedPath]);
  }

  return groupedPaths;
}
