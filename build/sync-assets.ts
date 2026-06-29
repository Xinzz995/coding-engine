import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface TargetSpec {
  dir: string;
  skillsSubdir: string;
  commandsSubdir: string;
}

export function syncAssets(opts: { sourceDir: string; targets: TargetSpec[] }): void {
  const skillsSrc = join(opts.sourceDir, 'skills');
  const commandsSrc = join(opts.sourceDir, 'commands');

  for (const t of opts.targets) {
    const skillsOut = join(t.dir, t.skillsSubdir);
    const commandsOut = join(t.dir, t.commandsSubdir);
    rmSync(skillsOut, { recursive: true, force: true });
    rmSync(commandsOut, { recursive: true, force: true });
    mkdirSync(t.dir, { recursive: true });
    if (existsSync(skillsSrc)) cpSync(skillsSrc, skillsOut, { recursive: true });
    if (existsSync(commandsSrc)) cpSync(commandsSrc, commandsOut, { recursive: true });
  }
}

// CLI usage: `tsx build/sync-assets.ts` generates the three committed tool dirs
// from the repo's assets/ source.
if (process.argv[1]?.endsWith('sync-assets.ts')) {
  const root = process.cwd();
  syncAssets({
    sourceDir: join(root, 'assets'),
    targets: [
      { dir: root, skillsSubdir: 'skills', commandsSubdir: 'commands' },          // Claude (plugin root)
      { dir: join(root, '.cursor'), skillsSubdir: 'skills', commandsSubdir: 'commands' },
      { dir: join(root, '.agents'), skillsSubdir: 'skills', commandsSubdir: 'commands' },
    ],
  });
  console.log('✅ 已从 assets/ 生成 skills/ commands/ .cursor/ .agents/');
}
