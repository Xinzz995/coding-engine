import { readFileSync } from 'node:fs';

export interface Story {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  passes: boolean;
  notes: string;
  retryCount: number;
  blocked: boolean;
}

export interface Prd {
  project: string;
  branchName: string;
  description: string;
  /** 意图真相源（源 PRD）的仓库相对路径；由 prd-to-json 写入，引擎只透传不解析 */
  sourcePrd?: string;
  userStories: Story[];
}

export function tryReadPrd(path: string): Prd | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Prd;
  } catch {
    return null;
  }
}

export function getCurrentStoryId(prd: Prd): string | null {
  for (const s of prd.userStories) {
    if (!s.passes && !s.blocked) return s.id;
  }
  return null;
}

export function allStoriesResolved(prd: Prd): boolean {
  return prd.userStories.every((s) => s.passes || s.blocked);
}
