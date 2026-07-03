import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_MANIFESTS } from './sync-plugin-versions.mjs';

// 版本不变量测试：所有版本落点必须钉在同一个 X.Y.Z。
// 教训（2026-07-04）：三个插件清单一起停在 0.5.1 达三个版本无人发现——彼此「一致」
// 骗过人眼，发版门禁又只在 tag push 时跑。此测试随 npm test 常态运行，让第一个
// 漂移提交就红（做法学自 ponytail 的 scripts/check-versions.js，它踩过同一坑）。
// 新增版本号落点时登记进 PLUGIN_MANIFESTS 或本文件的 entries。

const ROOT = process.cwd(); // vitest root = 仓库根

function readJson(path) {
  // 剥 UTF-8 BOM：Windows 编辑器可能给 JSON 加 BOM，不剥会 SyntaxError
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

describe('version consistency', () => {
  it('readJson strips a UTF-8 BOM before parsing (Windows editors may add one)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bom-'));
    try {
      const file = join(dir, 'manifest.json');
      writeFileSync(file, '\uFEFF{ "version": "1.2.3" }');
      expect(readJson(file).version).toBe('1.2.3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every version-bearing file shares one pinned X.Y.Z version', () => {
    const lock = readJson(join(ROOT, 'package-lock.json'));
    const entries = {
      'package.json': readJson(join(ROOT, 'package.json')).version,
      'package-lock.json': lock.version,
      'package-lock.json packages[""]': lock.packages[''].version,
    };
    for (const rel of PLUGIN_MANIFESTS) {
      entries[rel] = readJson(join(ROOT, rel)).version;
    }

    for (const [file, version] of Object.entries(entries)) {
      expect(version, `${file} 的 version 必须是钉死的 X.Y.Z`).toMatch(/^\d+\.\d+\.\d+$/);
    }

    // 全部与 package.json 对齐；失败时 diff 直接点名漂移的文件
    const reference = entries['package.json'];
    const expected = Object.fromEntries(Object.keys(entries).map((k) => [k, reference]));
    expect(entries).toEqual(expected);
  });
});
