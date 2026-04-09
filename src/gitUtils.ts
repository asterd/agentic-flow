// ─────────────────────────────────────────────────────────────
// gitUtils.ts  –  Safe git context capture for prompt injection
// ─────────────────────────────────────────────────────────────
// All functions are fully defensive: they never throw.
// When git is unavailable or the workspace is not a repo, they
// return graceful fallbacks so the caller can treat git context
// as optional enrichment, not a hard dependency.
// ─────────────────────────────────────────────────────────────

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { GitContextSnapshot } from './types';

const GIT_TIMEOUT_MS = 8_000;
const MAX_DIFF_CHARS = 6_000; // ~1500 tokens at 4 chars/token

/** Run a git command and return trimmed stdout. Returns '' on any error. */
async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 512 * 1024 }, (err, stdout) => {
      resolve(err ? '' : (stdout ?? '').trim());
    });
  });
}

/** Check whether a directory is inside a git repo by looking for a .git ancestor. */
function hasGitRepo(dir: string): boolean {
  let current = path.resolve(dir);
  const root = path.parse(current).root;
  while (current !== root) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/**
 * Truncate diff output to stay within a sensible character budget.
 * Prefers keeping the beginning (file headers) and notes the truncation.
 */
function truncateDiff(diff: string, maxChars: number): string {
  if (!diff || diff.length <= maxChars) return diff;
  return diff.slice(0, maxChars) + '\n… [diff truncated — showing first ' + maxChars + ' chars]';
}

/**
 * Capture a snapshot of the current git state.
 * Safe to call on any workspace — returns `isRepo: false` when git
 * is not available or the directory is not a git repository.
 *
 * Results are intended to be captured ONCE per run and injected into
 * every step prompt, not recomputed per step.
 */
export async function captureGitContext(
  workspaceRoot: string,
  opts: { maxTokens?: number; recentCommits?: number } = {},
): Promise<GitContextSnapshot> {
  // Guard: no git binary or not a repo
  if (!hasGitRepo(workspaceRoot)) {
    return { isRepo: false };
  }

  const maxChars = (opts.maxTokens ?? 500) * 4; // rough token→char conversion
  const logCount = Math.min(Math.max(1, opts.recentCommits ?? 5), 20);

  // Run all git queries in parallel — fast path when all succeed
  const [branch, status, stagedRaw, unstagedRaw, log] = await Promise.all([
    git(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(workspaceRoot, ['status', '--porcelain']),
    git(workspaceRoot, ['diff', '--cached']),
    git(workspaceRoot, ['diff']),
    git(workspaceRoot, ['log', `--oneline`, `-${logCount}`]),
  ]);

  // If branch came back empty, git is present but HEAD is detached or errored
  if (!branch) {
    // Still a repo, but HEAD is not useful — return minimal context
    return { isRepo: true };
  }

  // Budget the two diffs: staged gets priority (it's intentional), unstaged secondary
  const halfBudget = Math.floor(maxChars / 2);
  const stagedDiff   = truncateDiff(stagedRaw,   halfBudget);
  const unstagedDiff = truncateDiff(unstagedRaw, maxChars - (stagedDiff?.length ?? 0));

  return {
    isRepo: true,
    branch,
    status:       status   || undefined,
    stagedDiff:   stagedDiff   || undefined,
    unstagedDiff: unstagedDiff || undefined,
    recentLog:    log      || undefined,
  };
}

/**
 * Render a GitContextSnapshot into a markdown section for prompt injection.
 * Returns an empty string when there is nothing useful to show.
 */
export function formatGitContextSection(snapshot: GitContextSnapshot): string {
  if (!snapshot.isRepo) return '';

  const lines: string[] = ['# GIT CONTEXT'];

  if (snapshot.branch) {
    lines.push(`Branch: \`${snapshot.branch}\``);
  }

  if (snapshot.status) {
    lines.push(`\nWorking tree status:\n\`\`\`\n${snapshot.status}\n\`\`\``);
  } else {
    lines.push('\nWorking tree: clean');
  }

  if (snapshot.stagedDiff) {
    lines.push(`\nStaged changes (will be committed):\n\`\`\`diff\n${snapshot.stagedDiff}\n\`\`\``);
  }

  if (snapshot.unstagedDiff) {
    lines.push(`\nUnstaged changes:\n\`\`\`diff\n${snapshot.unstagedDiff}\n\`\`\``);
  }

  if (snapshot.recentLog) {
    lines.push(`\nRecent commits:\n\`\`\`\n${snapshot.recentLog}\n\`\`\``);
  }

  // If branch is the only info (clean repo, no recent activity), skip the section
  if (lines.length === 2 && !snapshot.status) return '';

  return lines.join('\n');
}
