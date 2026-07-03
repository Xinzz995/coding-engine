// 把三个 per-tool 插件清单的 version 同步到 package.json 的版本。
// 由 package.json 的 "version" 生命周期钩子调用（npm version 时自动执行），
// 兜底校验在 .github/workflows/publish.yml 的版本一致性门禁。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_MANIFESTS = [
  '.claude-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  '.codex-plugin/plugin.json',
];

// 只重写 version 字段所在片段，不做 JSON 重新序列化——保留各清单的既有格式
export function syncPluginVersions(rootDir, version) {
  const changed = [];
  for (const rel of PLUGIN_MANIFESTS) {
    const path = join(rootDir, rel);
    const text = readFileSync(path, 'utf8');
    const match = text.match(/"version":\s*"([^"]*)"/);
    if (!match) throw new Error(`${rel} 缺少 version 字段，无法同步`);
    if (match[1] === version) continue;
    writeFileSync(path, text.replace(match[0], `"version": "${version}"`));
    changed.push(rel);
  }
  return changed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const version =
    process.env.npm_package_version ??
    // 剥 UTF-8 BOM：Windows 编辑器可能给 JSON 加 BOM，不剥会 SyntaxError
    JSON.parse(readFileSync('package.json', 'utf8').replace(/^\uFEFF/, '')).version;
  const changed = syncPluginVersions(process.cwd(), version);
  console.log(
    changed.length
      ? `插件清单已同步到 ${version}：${changed.join(', ')}`
      : `插件清单已是 ${version}，无需同步`,
  );
}
