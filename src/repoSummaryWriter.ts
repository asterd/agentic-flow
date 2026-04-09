// ─────────────────────────────────────────────────────────────
// repoSummaryWriter.ts  –  Generate and persist REPO.md
// ─────────────────────────────────────────────────────────────
// REPO.md is a machine-readable + human-readable markdown file
// written to .agentic-flow/REPO.md after every completed run.
// It captures everything needed to restart the agentic flow from
// scratch on a fresh clone, without re-analysing the whole repo.
// ─────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import type { RunHistoryEntry, SessionState, StepFinding } from './types';

const REPO_MD_FILENAME = 'REPO.md';

export function getRepoMdPath(agenticFlowDir: string): string {
  return path.join(agenticFlowDir, REPO_MD_FILENAME);
}

/**
 * Generate the full REPO.md markdown content from the current session state.
 */
export function generateRepoMd(session: SessionState): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const lines: string[] = [];

  lines.push(`# Project Context — Agentic Flow`);
  lines.push(`\n> Generated: ${now}  `);
  lines.push(`> Session: ${session.title}  `);
  lines.push(`> Iterations: ${session.iteration}  `);
  lines.push(`> Runs: ${session.runs.length}`);

  // ── Objective history ──────────────────────────────────────────
  lines.push(`\n## Objectives`);
  lines.push(`\nEvolution of the project objectives across all iterations:\n`);
  for (const req of session.requirements) {
    const date = new Date(req.createdAt).toISOString().slice(0, 10);
    lines.push(`- **Iter ${req.iteration}** (${date}): ${req.text}`);
  }

  // ── Cumulative decisions ───────────────────────────────────────
  const allDecisions = collectFromRuns(session.runs, step => step.decisions ?? []);
  if (allDecisions.length) {
    lines.push(`\n## Architectural Decisions`);
    lines.push(`\nDecisions made by the agent across all runs:\n`);
    for (const d of allDecisions) lines.push(`- ${d}`);
  }

  // ── Cumulative constraints ─────────────────────────────────────
  const allConstraints = collectFromRuns(session.runs, step => step.constraints ?? []);
  if (allConstraints.length) {
    lines.push(`\n## Constraints`);
    lines.push(`\nConstraints identified and enforced across all runs:\n`);
    for (const c of allConstraints) lines.push(`- ${c}`);
  }

  // ── Artifacts ─────────────────────────────────────────────────
  const allArtifacts = collectFromRuns(session.runs, step => step.artifacts ?? []);
  const uniqueArtifacts = [...new Set(allArtifacts)].sort();
  if (uniqueArtifacts.length) {
    lines.push(`\n## Artifacts`);
    lines.push(`\nFiles and resources produced by the agent:\n`);
    for (const a of uniqueArtifacts) lines.push(`- \`${a}\``);
  }

  // ── Open findings ──────────────────────────────────────────────
  const latestFindings = collectLatestFindings(session.runs);
  if (latestFindings.length) {
    lines.push(`\n## Open Findings`);
    lines.push(`\nUnresolved issues from the latest run:\n`);
    for (const f of latestFindings) {
      const loc = f.location ? ` @ \`${f.location}\`` : '';
      const rec = f.recommendation ? `\n  > ${f.recommendation}` : '';
      lines.push(`- **[${f.severity.toUpperCase()}]** ${f.title}${loc}${rec}`);
    }
  }

  // ── Run history ────────────────────────────────────────────────
  lines.push(`\n## Run History`);
  lines.push(`\n| # | Date | Task | Status | Steps | Tokens |`);
  lines.push(`|---|------|------|--------|-------|--------|`);
  for (const run of [...session.runs].reverse().slice(0, 10)) {
    const date = new Date(run.startedAt).toISOString().slice(0, 16).replace('T', ' ');
    const task = truncate(run.task, 60);
    const stepsOk = run.steps.filter(s => s.status === 'done').length;
    const stepsTotal = run.steps.length;
    const tokens = run.steps.reduce((sum, s) => sum + (s.tokensUsed ?? 0), 0);
    const tokStr = tokens > 0 ? `≈${fmtNum(tokens)}` : '—';
    lines.push(`| ${run.iteration} | ${date} | ${escMd(task)} | ${run.status} | ${stepsOk}/${stepsTotal} | ${tokStr} |`);
  }
  if (session.runs.length > 10) {
    lines.push(`\n_Showing last 10 of ${session.runs.length} runs._`);
  }

  // ── Files changed across all runs ─────────────────────────────
  const allFiles = collectFromRuns(session.runs, step => step.filesChanged ?? []);
  const uniqueFiles = [...new Set(allFiles)].sort();
  if (uniqueFiles.length) {
    lines.push(`\n## Files Touched`);
    lines.push(`\nAll files modified by the agent across all runs:\n`);
    const showFiles = uniqueFiles.slice(0, 60);
    for (const f of showFiles) lines.push(`- \`${f}\``);
    if (uniqueFiles.length > 60) lines.push(`\n_…and ${uniqueFiles.length - 60} more._`);
  }

  // ── How to restart ────────────────────────────────────────────
  lines.push(`\n## How to Restart the Agentic Flow`);
  lines.push(`
1. Open this workspace in VS Code with the **Agentic Flow** extension installed.
2. Open the Agentic Flow panel (activity bar icon or \`Cmd+Shift+A\`).
3. The session will reload automatically from \`.agentic-flow/session.json\`.
4. To continue where you left off, type a new requirement and click **Continue**.
5. To start fresh, click the **New Session** icon in the panel header.

**Presets available:**
- \`Lite\` — fast iteration (spec → implement → review → fix → report)
- \`Standard\` — with architecture review and pre-check
- \`Full\` — with testing, security, docs and runtime verification
- \`Evolutive\` — for changes on existing code (diff-analysis → implement → review → fix → report)
- \`Hotfix\` — minimal urgent fixes (diff-analysis → implement → fix → report)

**Micro-actions:** Use the ⚡ Quick Action button for single targeted instructions without running the full pipeline.

**Context note:** This file (\`REPO.md\`) is automatically injected into every step prompt when present, so agents have full context without re-analysing the repository.
`);

  lines.push(`---`);
  lines.push(`_This file is auto-generated by Agentic Flow. Do not edit manually — changes will be overwritten on the next run._`);

  return lines.join('\n');
}

/**
 * Write REPO.md to the .agentic-flow directory.
 * Returns the absolute path written, or null if the dir cannot be resolved.
 */
export function writeRepoMd(session: SessionState, agenticFlowDir: string): string | null {
  try {
    if (!fs.existsSync(agenticFlowDir)) {
      fs.mkdirSync(agenticFlowDir, { recursive: true });
    }
    const filePath = getRepoMdPath(agenticFlowDir);
    const content = generateRepoMd(session);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  } catch {
    return null;
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────────

type StepWithData = RunHistoryEntry['steps'][number] & {
  decisions?: string[];
  constraints?: string[];
  artifacts?: string[];
};

function collectFromRuns<T>(
  runs: RunHistoryEntry[],
  pick: (step: StepWithData) => T[],
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const run of runs) {
    for (const step of run.steps as StepWithData[]) {
      for (const item of pick(step)) {
        const key = String(item);
        if (!seen.has(key)) { seen.add(key); result.push(item); }
      }
    }
  }
  return result;
}

function collectLatestFindings(runs: RunHistoryEntry[]): StepFinding[] {
  const latest = [...runs].reverse().find(r => r.status === 'completed' || r.status === 'error');
  if (!latest) return [];
  const seen = new Set<string>();
  const findings: StepFinding[] = [];
  for (const step of latest.steps) {
    for (const f of step.findings ?? []) {
      if (f.severity === 'info') continue;
      const key = `${f.severity}:${f.title}`;
      if (!seen.has(key)) { seen.add(key); findings.push(f); }
    }
  }
  return findings.sort((a, b) => severityWeight(a.severity) - severityWeight(b.severity));
}

function severityWeight(s: string): number {
  return ({ critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>)[s] ?? 9;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function fmtNum(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function escMd(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
