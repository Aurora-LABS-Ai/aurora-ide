/**
 * Git Service
 * Frontend wrapper for Rust git commands via Tauri
 */

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../lib/tauri';

// Types
export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored'
  | 'conflicted';

export interface GitFileChange {
  path: string;
  oldPath?: string; // For renames
  status: GitFileStatus;
  staged: boolean;
}

export interface GitStatus {
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
  conflicted: GitFileChange[];
  ahead: number;
  behind: number;
}

export interface GitBranch {
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
  upstream?: string;
  lastCommit?: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  email: string;
  date: string;
  refs: string[];
}

export interface BranchResult {
  branches: GitBranch[];
  current: string;
}

// Service implementation
class GitService {
  /**
   * Check if directory is a git repository
   */
  async isGitRepository(workspacePath: string): Promise<boolean> {
    if (!isTauri()) return false;
    try {
      return await invoke<boolean>('git_is_repository', { workspacePath });
    } catch {
      return false;
    }
  }

  /**
   * Get current git status (staged, unstaged, untracked files)
   */
  async getStatus(workspacePath: string): Promise<GitStatus> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    return await invoke<GitStatus>('git_get_status', { workspacePath });
  }

  /**
   * Get all branches (local and remote)
   */
  async getBranches(workspacePath: string): Promise<BranchResult> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    return await invoke<BranchResult>('git_get_branches', { workspacePath });
  }

  /**
   * Get commit history
   */
  async getCommits(workspacePath: string, limit: number = 50): Promise<GitCommit[]> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    return await invoke<GitCommit[]>('git_get_commits', { workspacePath, limit });
  }

  /**
   * Stage a file for commit
   */
  async stageFile(workspacePath: string, filePath: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_stage_file', { workspacePath, filePath });
  }

  /**
   * Unstage a file
   */
  async unstageFile(workspacePath: string, filePath: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_unstage_file', { workspacePath, filePath });
  }

  /**
   * Stage all changes
   */
  async stageAll(workspacePath: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_stage_all', { workspacePath });
  }

  /**
   * Unstage all changes
   */
  async unstageAll(workspacePath: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_unstage_all', { workspacePath });
  }

  /**
   * Discard changes in a file
   */
  async discardChanges(workspacePath: string, filePath: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_discard_changes', { workspacePath, filePath });
  }

  /**
   * Create a commit
   */
  async commit(workspacePath: string, message: string): Promise<string> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    return await invoke<string>('git_commit', { workspacePath, message });
  }

  /**
   * Checkout a branch
   */
  async checkout(workspacePath: string, branch: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_checkout', { workspacePath, branch });
  }

  /**
   * Create a new branch
   */
  async createBranch(workspacePath: string, name: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_create_branch', { workspacePath, name });
  }

  /**
   * Pull from remote
   */
  async pull(workspacePath: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_pull', { workspacePath });
  }

  /**
   * Push to remote
   */
  async push(workspacePath: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_push', { workspacePath });
  }

  /**
   * Get diff for a file
   */
  async getDiff(workspacePath: string, filePath: string, staged: boolean = false): Promise<string> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    return await invoke<string>('git_get_diff', { workspacePath, filePath, staged });
  }

  /**
   * Get current branch name
   */
  async getCurrentBranch(workspacePath: string): Promise<string> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    return await invoke<string>('git_current_branch', { workspacePath });
  }
}

export const gitService = new GitService();
