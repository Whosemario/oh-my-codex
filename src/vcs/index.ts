import { execFileSync, spawnSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { findGitLayout, readGitLayoutFile } from '../utils/git-layout.js';

export type WorkspaceKind = 'git' | 'svn' | 'none';

export interface WorkspaceCapabilities {
  supportsIsolatedWorkspace: boolean;
  supportsCheckpointing: boolean;
  supportsCommitIdentity: boolean;
}

export interface WorkspaceDetection {
  kind: WorkspaceKind;
  root: string | null;
  capabilities: WorkspaceCapabilities;
}

export interface VcsDisplayOptions {
  gitStyle?: 'branch' | 'repo-branch';
  remoteName?: string;
  repoLabel?: string;
  svnStyle?: 'working-copy-revision' | 'repo-revision';
}

export type GitRunner = (cwd: string, args: string[]) => string | null;

const GIT_CAPABILITIES: WorkspaceCapabilities = {
  supportsIsolatedWorkspace: true,
  supportsCheckpointing: true,
  supportsCommitIdentity: true,
};

const SVN_CAPABILITIES: WorkspaceCapabilities = {
  supportsIsolatedWorkspace: false,
  supportsCheckpointing: true,
  supportsCommitIdentity: false,
};

const NONE_CAPABILITIES: WorkspaceCapabilities = {
  supportsIsolatedWorkspace: false,
  supportsCheckpointing: false,
  supportsCommitIdentity: false,
};

function runCommand(cwd: string, command: string, args: string[], timeout = 2000): string | null {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf-8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

function runGitExec(cwd: string, args: string[]): string | null {
  return runCommand(cwd, 'git', args);
}

export function runGit(cwd: string, args: string[]): string | null {
  if (process.platform === 'win32') {
    try {
      const gitLayout = findGitLayout(cwd);
      if (gitLayout) {
        const cmd = args.join(' ');

        if (cmd === 'rev-parse --abbrev-ref HEAD') {
          const head = readGitLayoutFile(gitLayout.gitDir, 'HEAD');
          if (head?.startsWith('ref: refs/heads/')) {
            return head.slice('ref: refs/heads/'.length);
          }
          return head;
        }

        if (cmd.startsWith('remote get-url ')) {
          const remoteName = args[2];
          const config = readGitLayoutFile(gitLayout.gitDir, 'config')
            ?? readGitLayoutFile(gitLayout.commonDir, 'config');
          if (config) {
            const re = new RegExp(`\\[remote "${remoteName}"\\][\\s\\S]*?url\\s*=\\s*(.+)`, 'm');
            const m = config.match(re);
            if (m) return m[1].trim();
          }
          return null;
        }

        if (cmd === 'remote') {
          const config = readGitLayoutFile(gitLayout.gitDir, 'config')
            ?? readGitLayoutFile(gitLayout.commonDir, 'config');
          if (config) {
            const matches = [...config.matchAll(/\[remote "([^"]+)"\]/g)];
            if (matches.length > 0) return matches.map((m) => m[1]).join('\n');
          }
          return null;
        }

        if (cmd === 'rev-parse --show-toplevel') {
          return gitLayout.worktreeRoot;
        }
      }
    } catch {
      // Fall back to normal git execution.
    }
  }

  return runGitExec(cwd, args);
}

function tryRunSvn(cwd: string, args: string[]): string | null {
  return runCommand(cwd, 'svn', args, 4000);
}

function findSvnRootByMetadata(startCwd: string): string | null {
  let dir = resolve(startCwd);
  let found: string | null = null;

  for (;;) {
    const candidate = join(dir, '.svn');
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory() || stat.isFile()) {
        found = dir;
      }
    } catch {
      // Keep walking.
    }

    const parent = dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

function findSvnRoot(startCwd: string): string | null {
  const fromCli = tryRunSvn(startCwd, ['info', '--show-item', 'wc-root']);
  if (fromCli) return resolve(startCwd, fromCli);
  return findSvnRootByMetadata(startCwd);
}

export function detectWorkspace(cwd: string): WorkspaceDetection {
  const gitLayout = findGitLayout(cwd);
  if (gitLayout) {
    return {
      kind: 'git',
      root: gitLayout.worktreeRoot,
      capabilities: GIT_CAPABILITIES,
    };
  }

  const svnRoot = findSvnRoot(cwd);
  if (svnRoot) {
    return {
      kind: 'svn',
      root: svnRoot,
      capabilities: SVN_CAPABILITIES,
    };
  }

  return {
    kind: 'none',
    root: null,
    capabilities: NONE_CAPABILITIES,
  };
}

export function resolveWorkspaceRoot(cwd: string): string | null {
  return detectWorkspace(cwd).root;
}

export function readGitBranchName(cwd: string, gitRunner: GitRunner = runGit): string | null {
  return gitRunner(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

function readGitRemoteUrl(cwd: string, remoteName: string, gitRunner: GitRunner = runGit): string | null {
  return gitRunner(cwd, ['remote', 'get-url', remoteName]);
}

function readFirstGitRemoteName(cwd: string, gitRunner: GitRunner = runGit): string | null {
  const remotes = gitRunner(cwd, ['remote']);
  if (!remotes) return null;
  for (const remote of remotes.split(/\r?\n/)) {
    const trimmed = remote.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function extractRepoName(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const repoMatch = remoteUrl.match(/[:/]([^/]+?)(?:\.git)?$/);
  return repoMatch?.[1] ?? null;
}

function readRepoBasename(cwd: string, gitRunner: GitRunner = runGit): string | null {
  const topLevel = gitRunner(cwd, ['rev-parse', '--show-toplevel']);
  return topLevel ? basename(topLevel) : null;
}

function resolveGitRepoLabel(cwd: string, options: VcsDisplayOptions, gitRunner: GitRunner = runGit): string | null {
  if (options.repoLabel) return options.repoLabel;

  if (options.remoteName) {
    const configured = extractRepoName(readGitRemoteUrl(cwd, options.remoteName, gitRunner));
    if (configured) return configured;
  }

  const origin = extractRepoName(readGitRemoteUrl(cwd, 'origin', gitRunner));
  if (origin) return origin;

  const firstRemoteName = readFirstGitRemoteName(cwd, gitRunner);
  if (firstRemoteName) {
    const first = extractRepoName(readGitRemoteUrl(cwd, firstRemoteName, gitRunner));
    if (first) return first;
  }

  return readRepoBasename(cwd, gitRunner);
}

function readSvnInfoField(cwd: string, field: string): string | null {
  const value = tryRunSvn(cwd, ['info', '--show-item', field]);
  return value?.trim() || null;
}

function readSvnRevision(cwd: string): string | null {
  return readSvnInfoField(cwd, 'revision');
}

function readSvnRepoLabel(cwd: string, options: VcsDisplayOptions): string | null {
  if (options.repoLabel) return options.repoLabel;
  const url = readSvnInfoField(cwd, 'url');
  if (url) {
    const parts = url.split('/').filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  const root = resolveWorkspaceRoot(cwd);
  return root ? basename(root) : 'working-copy';
}

export function getDisplayRef(
  cwd: string,
  options: VcsDisplayOptions = {},
  gitRunner: GitRunner = runGit,
): string | null {
  const workspace = detectWorkspace(cwd);
  if (workspace.kind === 'git') {
    const branch = readGitBranchName(cwd, gitRunner);
    if (!branch) return null;
    if ((options.gitStyle ?? 'repo-branch') === 'branch') return branch;
    const repoLabel = resolveGitRepoLabel(cwd, options, gitRunner);
    return repoLabel ? `${repoLabel}/${branch}` : branch;
  }

  if (workspace.kind === 'svn') {
    const revision = readSvnRevision(cwd);
    if (!revision) return null;
    const label = readSvnRepoLabel(cwd, options);
    if ((options.svnStyle ?? 'repo-revision') === 'working-copy-revision') {
      return `${basename(workspace.root || cwd)}@${revision}`;
    }
    return `${label || 'working-copy'}@${revision}`;
  }

  return null;
}

export function getStatus(cwd: string): string[] {
  const workspace = detectWorkspace(cwd);
  if (workspace.kind === 'git') {
    const output = runGit(cwd, ['status', '--porcelain', '--untracked-files=all']);
    return (output || '')
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
  }

  if (workspace.kind === 'svn') {
    const output = tryRunSvn(cwd, ['status']);
    return (output || '')
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
  }

  return [];
}

export function getDiff(cwd: string, extraArgs: string[] = []): string {
  const workspace = detectWorkspace(cwd);
  if (workspace.kind === 'git') {
    return runGit(cwd, ['diff', ...extraArgs]) || '';
  }
  if (workspace.kind === 'svn') {
    return tryRunSvn(cwd, ['diff', ...extraArgs]) || '';
  }
  return '';
}

export function getHistory(cwd: string, extraArgs: string[] = []): string {
  const workspace = detectWorkspace(cwd);
  if (workspace.kind === 'git') {
    return runGit(cwd, ['log', ...extraArgs]) || '';
  }
  if (workspace.kind === 'svn') {
    return tryRunSvn(cwd, ['log', ...extraArgs]) || '';
  }
  return '';
}

export function isGitWorkspace(cwd: string): boolean {
  return detectWorkspace(cwd).kind === 'git';
}

export function isSvnWorkspace(cwd: string): boolean {
  return detectWorkspace(cwd).kind === 'svn';
}

export function commandExists(command: string): boolean {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  return result.status === 0;
}

export function hasWorkspaceMetadata(cwd: string): boolean {
  const resolved = resolve(cwd);
  return existsSync(join(resolved, '.git')) || existsSync(join(resolved, '.svn'));
}
