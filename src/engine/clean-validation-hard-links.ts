import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, readlinkSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';

export interface CleanValidationHardLinkObservation {
  readonly path: string;
  readonly artifactRoot: string | null;
  readonly kind: 'directory' | 'file' | 'symbolic-link';
  readonly linkTargetDigest: string | null;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly nlink: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly birthtimeNs: bigint;
}

export interface CleanValidationHardLinkProof {
  readonly digest: string;
  readonly groups: number;
}

export class CleanValidationHardLinkProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanValidationHardLinkProofError';
  }
}

function invalid(message: string): CleanValidationHardLinkProofError {
  return new CleanValidationHardLinkProofError(`无法证明验证检出拓扑稳定且未越界：${message}`);
}

export function observeCleanValidationHardLink(
  path: string,
  artifactRoot: string | null,
  info: BigIntStats,
): CleanValidationHardLinkObservation {
  const observation = observeCleanValidationTopologyEntry(path, artifactRoot, info);
  if (observation.kind !== 'file' || observation.nlink <= 1n) {
    throw invalid(`${path} 不是需建立组证明的普通 hard link 文件`);
  }
  return observation;
}

export function observeCleanValidationTopologyEntry(
  path: string,
  artifactRoot: string | null,
  info: BigIntStats,
  linkTarget?: Uint8Array,
): CleanValidationHardLinkObservation {
  const kind = info.isSymbolicLink()
    ? 'symbolic-link'
    : info.isDirectory()
      ? 'directory'
      : info.isFile()
        ? 'file'
        : null;
  if (kind === null) throw invalid(`验证检出含特殊文件：${path}`);
  if (info.nlink < 1n) throw invalid(`${path} 的链接数量非法`);
  if (kind === 'symbolic-link' && info.nlink !== 1n) {
    throw invalid(`符号链接有多个目录名称：${path}`);
  }
  if ((kind === 'symbolic-link') !== (linkTarget !== undefined)) {
    throw invalid(`${path} 的符号链接目标快照缺失或多余`);
  }
  return {
    path,
    artifactRoot,
    kind,
    linkTargetDigest:
      linkTarget === undefined ? null : createHash('sha256').update(linkTarget).digest('hex'),
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    gid: info.gid,
    mode: info.mode,
    size: info.size,
    nlink: info.nlink,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
    birthtimeNs: info.birthtimeNs,
  };
}

function metadata(observation: CleanValidationHardLinkObservation): string {
  return [
    observation.dev,
    observation.ino,
    observation.uid,
    observation.gid,
    observation.mode,
    observation.size,
    observation.nlink,
    observation.mtimeNs,
    observation.ctimeNs,
    observation.birthtimeNs,
  ].join(':');
}

export function freezeCleanValidationHardLinks(
  observations: readonly CleanValidationHardLinkObservation[],
): CleanValidationHardLinkProof {
  const groups = new Map<string, CleanValidationHardLinkObservation[]>();
  const paths = new Set<string>();
  const topologyRecords: string[] = [];
  for (const observation of observations) {
    if (observation.path === '' || observation.path.includes('\0') || paths.has(observation.path)) {
      throw invalid('扫描结果含非法或重复路径');
    }
    if (
      (observation.kind === 'symbolic-link' &&
        (observation.nlink !== 1n ||
          !observation.linkTargetDigest ||
          !/^[0-9a-f]{64}$/u.test(observation.linkTargetDigest))) ||
      (observation.kind !== 'symbolic-link' && observation.linkTargetDigest !== null)
    ) {
      throw invalid(`${observation.path} 的条目类型与链接证明不一致`);
    }
    paths.add(observation.path);
    topologyRecords.push(
      [
        observation.path,
        observation.kind,
        observation.artifactRoot ?? '',
        metadata(observation),
        observation.linkTargetDigest ?? '',
      ].join('\0'),
    );
    if (observation.kind !== 'file' || observation.nlink <= 1n) continue;
    const key = `${observation.dev}:${observation.ino}`;
    const group = groups.get(key);
    if (group) group.push(observation);
    else groups.set(key, [observation]);
  }

  for (const [key, group] of groups) {
    const first = group[0];
    const firstMetadata = metadata(first);
    if (group.some((member) => metadata(member) !== firstMetadata)) {
      throw invalid(`${first.path} 所在组的文件身份不一致`);
    }
    if (BigInt(group.length) !== first.nlink) {
      throw invalid(
        `${first.path} 所在组不完整（观察到 ${group.length}，系统报告 ${first.nlink}）`,
      );
    }
    if (first.artifactRoot === null || group.some((member) => member.artifactRoot === null)) {
      throw invalid(`${first.path} 所在组包含未声明为产物的路径`);
    }
    if (group.some((member) => member.artifactRoot !== first.artifactRoot)) {
      throw invalid(`${first.path} 所在组跨越多个产物根`);
    }
    topologyRecords.push(
      [
        'hard-link-group',
        key,
        first.artifactRoot,
        ...group.map((member) => member.path).sort(),
      ].join('\0'),
    );
  }
  topologyRecords.sort();
  return {
    digest: createHash('sha256').update(topologyRecords.join('\0')).digest('hex'),
    groups: groups.size,
  };
}

export function snapshotCleanValidationHardLinks(options: {
  readonly root: string;
  readonly owningRoot: (path: string) => string | null;
  readonly maxEntries: number;
  readonly signal?: AbortSignal;
}): CleanValidationHardLinkProof {
  const observations: CleanValidationHardLinkObservation[] = [];
  let entries = 0;
  const checkpoint = (): void => {
    if (options.signal?.aborted) throw invalid('复核被中断');
  };
  const visit = (directory: string, prefix = ''): void => {
    checkpoint();
    const stream = opendirSync(directory);
    try {
      let entry;
      while ((entry = stream.readSync()) !== null) {
        if (prefix === '' && entry.name === '.git') continue;
        checkpoint();
        entries += 1;
        if (entries > options.maxEntries) throw invalid(`复核内容超过 ${options.maxEntries} 项`);
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const target = join(directory, entry.name);
        let info: BigIntStats;
        try {
          info = lstatSync(target, { bigint: true });
        } catch {
          throw invalid(`条目在复核期间消失：${path}`);
        }
        let linkTarget: Buffer | undefined;
        if (info.isSymbolicLink()) {
          try {
            linkTarget = readlinkSync(target, { encoding: 'buffer' });
          } catch {
            throw invalid(`符号链接在复核期间无法读取：${path}`);
          }
        }
        observations.push(
          observeCleanValidationTopologyEntry(path, options.owningRoot(path), info, linkTarget),
        );
        if (info.isDirectory() && !info.isSymbolicLink()) {
          visit(target, path);
        }
      }
    } finally {
      stream.closeSync();
    }
  };
  visit(options.root);
  return freezeCleanValidationHardLinks(observations);
}
