import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  assertWritableFileTarget,
  ensureSafeParentDirectory,
  replaceFileFromStaging,
  resolveWorkspaceRelativePath,
  writeNewFile,
} from './filesystem.js';
import { type WorkspaceLeaseHandle } from './lease.js';
import { PROTOCOL_ROOT_DIR, WORKSPACE_MARKER_FILE, WorkspaceSafetyError } from './types.js';

export type WorkspaceSessionState = 'open' | 'closing' | 'closed' | 'lost';

export interface WorkspaceSessionHooks {
  readonly afterTempCreated?: (path: string) => void | Promise<void>;
}

export interface ControlledWorkspaceSessionOptions {
  readonly hooks?: WorkspaceSessionHooks;
}

export type WorkspaceWriteData = string | Uint8Array;

const WORKSPACE_SESSION_AUTHORITY = Symbol('workspace-session-authority');

export class WorkspaceSession {
  readonly writer: WorkspaceWriter;

  #state: WorkspaceSessionState = 'open';
  #tail: Promise<void> = Promise.resolve();
  #closePromise: Promise<string> | undefined;
  readonly #hooks: WorkspaceSessionHooks;

  constructor(
    token: typeof WORKSPACE_SESSION_AUTHORITY,
    readonly lease: WorkspaceLeaseHandle,
    options: ControlledWorkspaceSessionOptions,
  ) {
    if (token !== WORKSPACE_SESSION_AUTHORITY) {
      throw new WorkspaceSafetyError('invalid', 'workspace session authority token is invalid');
    }
    this.#hooks = options.hooks ?? {};
    this.writer = new WorkspaceWriter(this);
  }

  get state(): WorkspaceSessionState {
    return this.#state;
  }

  get hooks(): WorkspaceSessionHooks {
    return this.#hooks;
  }

  async withExclusiveAction<T>(action: (lease: WorkspaceLeaseHandle) => Promise<T>): Promise<T> {
    if (this.#state !== 'open') {
      throw new WorkspaceSafetyError(
        this.#state === 'lost' ? 'lease-lost' : 'closed',
        this.#state === 'lost' ? 'workspace session 已失去租约' : 'workspace session 已关闭写入口',
      );
    }

    const result = this.#tail.then(() => {
      if (this.#state === 'lost') {
        throw new WorkspaceSafetyError('lease-lost', 'workspace session 已失去租约');
      }
      return action(this.lease);
    });
    this.#tail = result.then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof WorkspaceSafetyError && error.code === 'lease-lost') {
          this.#state = 'lost';
        }
      },
    );
    return result;
  }

  close(): Promise<string> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#state === 'closed') {
      return Promise.reject(new WorkspaceSafetyError('closed', 'workspace session 已关闭'));
    }
    if (this.#state === 'lost') {
      return Promise.reject(new WorkspaceSafetyError('lease-lost', 'workspace session 已失去租约'));
    }

    this.#state = 'closing';
    const release = this.#tail.then(async () => {
      if (this.#state === 'lost') {
        throw new WorkspaceSafetyError('lease-lost', 'workspace session 已失去租约');
      }
      const incident = await this.lease.release();
      this.#state = 'closed';
      return incident;
    });
    this.#closePromise = release.catch((error: unknown) => {
      if (error instanceof WorkspaceSafetyError && error.code === 'lease-lost') {
        this.#state = 'lost';
      }
      throw error;
    });
    this.#tail = this.#closePromise.then(
      () => undefined,
      () => undefined,
    );
    return this.#closePromise;
  }
}

export function createWorkspaceSession(lease: WorkspaceLeaseHandle): WorkspaceSession {
  return new WorkspaceSession(WORKSPACE_SESSION_AUTHORITY, lease, {});
}

/** @internal Deterministic race seam; production callers must use createWorkspaceSession. */
export function createWorkspaceSessionControlled(
  lease: WorkspaceLeaseHandle,
  options: ControlledWorkspaceSessionOptions = {},
): WorkspaceSession {
  return new WorkspaceSession(WORKSPACE_SESSION_AUTHORITY, lease, options);
}

export class WorkspaceWriter {
  #sequence = 0;

  constructor(private readonly session: WorkspaceSession) {}

  writeFile(relativePath: string, data: WorkspaceWriteData): Promise<void> {
    return this.session.withExclusiveAction(async (lease) => {
      const firstPart = relativePath.split(/[\\/]/u)[0];
      if (
        firstPart.toLowerCase() === PROTOCOL_ROOT_DIR.toLowerCase() ||
        relativePath.toLowerCase() === WORKSPACE_MARKER_FILE.toLowerCase()
      ) {
        throw new WorkspaceSafetyError('invalid', '普通 WorkspaceWriter 不能写安全协议路径');
      }

      await lease.verify();
      const target = resolveWorkspaceRelativePath(lease.workspace.path, relativePath);
      await ensureSafeParentDirectory(lease.workspace.path, target);
      await assertWritableFileTarget(target);
      await lease.verify();

      this.#sequence += 1;
      const temp = join(
        dirname(target),
        `.${basename(target)}.coding-x-${lease.owner.ownerId}-${this.#sequence}-${randomUUID()}.tmp`,
      );
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      await writeNewFile(temp, bytes);
      await this.session.hooks.afterTempCreated?.(temp);

      // 这是提交前的最后一道 owner 检查；失败后不能清理 temp，因为清理本身也是迟到写。
      await lease.verify();
      try {
        await replaceFileFromStaging(temp, target);
      } catch (error) {
        if (error instanceof WorkspaceSafetyError && error.code === 'invalid') {
          throw new WorkspaceSafetyError(
            'lease-lost',
            'workspace 写入目标在提交前发生冲突；保留 lease 与 temp 供诊断',
          );
        }
        throw error;
      }
    });
  }
}
