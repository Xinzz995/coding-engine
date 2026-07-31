import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApiResponseWithWorkspaceSafety, configureWorkspace } from '../dashboard/server.js';
import {
  renderDoctorJson,
  renderDoctorReport,
  runDoctorWithWorkspaceSafety,
} from '../doctor/doctor.js';
import {
  collectStatusWithWorkspaceSafety,
  renderStatusJson,
  renderStatusReport,
} from '../status/status.js';
import { bootstrapWorkspace } from './bootstrap.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function snapshotTree(root: string): readonly string[] {
  const entries: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      const name = relative(root, path).replaceAll('\\', '/');
      const info = lstatSync(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        entries.push(`directory:${name}`);
        walk(path);
      } else if (info.isFile() && !info.isSymbolicLink()) {
        entries.push(`file:${name}:${readFileSync(path).toString('base64')}`);
      } else {
        entries.push(`other:${name}:${info.mode}`);
      }
    }
  };
  walk(root);
  return entries;
}

describe('workspace safety display consumers', () => {
  it('shows one production classification and guidance without changing workspace bytes', async () => {
    const projectRoot = temporaryDirectory('coding-x-safety-consumer-project-');
    const workspace = temporaryDirectory('coding-x-safety-consumer-workspace-');
    const before = snapshotTree(workspace);

    const status = await collectStatusWithWorkspaceSafety(workspace, {
      projectRoot,
      refreshRemote: false,
    });
    const doctor = await runDoctorWithWorkspaceSafety(projectRoot, {
      workspace,
      requireQualityContract: false,
      local: true,
      modelConfigPath: join(projectRoot, 'missing-model-catalog.json'),
    });
    configureWorkspace(workspace, 0);
    const dashboard = await buildApiResponseWithWorkspaceSafety();

    expect(status.workspaceSafety).toEqual(doctor.workspaceSafety);
    expect(dashboard.workspaceSafety).toEqual(status.workspaceSafety);
    expect(status.workspaceSafety).toMatchObject({
      status: 'uninitialized',
      observedClassification: 'uninitialized-empty',
      probeEvidence: 'system',
      display: {
        label: '未初始化',
        summary: '目录为空，可以显式初始化为新版安全工作区。',
        guidance: '先运行 workspace 初始化命令。',
      },
    });

    const statusText = renderStatusReport(status).text;
    const renderedDoctor = renderDoctorReport(doctor);
    const doctorText = renderedDoctor.text;
    expect(renderedDoctor.exitCode).toBe(1);
    expect(renderDoctorJson(doctor).exitCode).toBe(1);
    for (const value of [
      status.workspaceSafety.display.label,
      status.workspaceSafety.display.summary,
      status.workspaceSafety.display.guidance,
    ]) {
      expect(value).not.toBeNull();
      expect(statusText).toContain(value);
      expect(doctorText).toContain(value);
    }
    expect(JSON.parse(renderStatusJson(status).text)).toMatchObject({
      workspaceSafety: status.workspaceSafety,
    });
    expect(JSON.parse(renderDoctorJson(doctor).text)).toMatchObject({
      workspaceSafety: status.workspaceSafety,
    });
    expect(snapshotTree(workspace)).toEqual(before);
  });

  it('lets doctor pass the workspace safety check only for a ready workspace', async () => {
    const projectRoot = temporaryDirectory('coding-x-safety-ready-project-');
    const workspace = temporaryDirectory('coding-x-safety-ready-workspace-');
    await bootstrapWorkspace({ workspacePath: workspace });
    const before = snapshotTree(workspace);

    const doctor = await runDoctorWithWorkspaceSafety(projectRoot, {
      workspace,
      requireQualityContract: false,
      local: true,
      modelConfigPath: join(projectRoot, 'missing-model-catalog.json'),
    });

    expect(doctor.workspaceSafety).toMatchObject({
      status: 'ready',
      observedClassification: 'ready',
      display: { label: '就绪', guidance: null },
    });
    expect(renderDoctorReport(doctor).exitCode).toBe(0);
    expect(renderDoctorJson(doctor).exitCode).toBe(0);
    expect(snapshotTree(workspace)).toEqual(before);
  });
});
