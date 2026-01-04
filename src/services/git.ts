/**
 * Git Service
 * Frontend wrapper for Rust git commands via Tauri
 */
import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "../lib/tauri";

export interface BranchResult {
  branches: GitBranch[];
  current: string;
}

export interface GitBranch {
  isCurrent: boolean;
  isRemote: boolean;
  lastCommit?: string;
  name: string;
  upstream?: string;
}

export interface GitCommit {
  author: string;
  date: string;
  email: string;
  hash: string;
  message: string;
  refs: string[];
  shortHash: string;
}

export interface GitFileChange {
  oldPath?: string; // For renames
  path: string;
  staged: boolean;
  status: GitFileStatus;
}

export interface GitStatus {
  ahead: number;
  behind: number;
  conflicted: GitFileChange[];
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
}

// Service implementation
class GitService {
  /**
   * Checkout a branch
   */
  public async checkout(workspacePath: string, branch: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_checkout', { workspacePath, branch });
  }

  /**
   * Create a commit
   */
  public async commit(workspacePath: string, message: string): Promise<string> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    return await invoke<string>('git_commit', { workspacePath, message });
  }

  /**
   * Create a new branch
   */
  public async createBranch(workspacePath: string, name: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_create_branch', { workspacePath, name });
  }

  /**
   * Discard changes in a file
   */
  public async discardChanges(workspacePath: string, filePath: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_discard_changes', { workspacePath, filePath });
  }

  /**
   * Get all branches (local and remote)
   */
  public async getBranches(workspacePath: string): Promise<BranchResult> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    return await invoke<BranchResult>('git_get_branches', { workspacePath });
  }

  /**
   * Get commit history
   */
  public async getCommits(workspacePath: string, limit: number = 50): Promise<GitCommit[]> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    return await invoke<GitCommit[]>('git_get_commits', { workspacePath, limit });
  }

  /**
   * Get current branch name
   */
  public async getCurrentBranch(workspacePath: string): Promise<string> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    return await invoke<string>('git_current_branch', { workspacePath });
  }

  /**
   * Get diff for a file
   */
  public async getDiff(workspacePath: string, filePath: string, staged: boolean = false): Promise<string> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    return await invoke<string>('git_get_diff', { workspacePath, filePath, staged });
  }

  /**
   * Get current git status (staged, unstaged, untracked files)
   */
  public async getStatus(workspacePath: string): Promise<GitStatus> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    return await invoke<GitStatus>('git_get_status', { workspacePath });
  }

  /**
   * Check if directory is a git repository
   */
  public async isGitRepository(workspacePath: string): Promise<boolean> {
    if (!isTauri()) return false;
    try {
      return await invoke<boolean>('git_is_repository', { workspacePath });
    } catch {
      return false;
    }
  }

  /**
   * Pull from remote
   */
  public async pull(workspacePath: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_pull', { workspacePath });
  }

  /**
   * Push to remote
   */
  public async push(workspacePath: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_push', { workspacePath });
  }

  /**
   * Stage all changes
   */
  public async stageAll(workspacePath: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_stage_all', { workspacePath });
  }

  /**
   * Stage a file for commit
   */
  public async stageFile(workspacePath: string, filePath: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_stage_file', { workspacePath, filePath });
  }

  /**
   * Unstage all changes
   */
  public async unstageAll(workspacePath: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_unstage_all', { workspacePath });
  }

  /**
   * Unstage a file
   */
  public async unstageFile(workspacePath: string, filePath: string): Promise<void> {
    if (!isTauri()) {
      throw new Error('Git operations require desktop app');
    }
    await invoke('git_unstage_file', { workspacePath, filePath });
  }
}

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

export const gitService = new GitService();
