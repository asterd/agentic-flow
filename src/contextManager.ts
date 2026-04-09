// ─────────────────────────────────────────────────────────────
// contextManager.ts  –  Token-efficient shared context
// ─────────────────────────────────────────────────────────────
import * as fs from 'fs';
import * as path from 'path';
import type { AgenticFlowConfig, GitContextSnapshot, SessionState, StepConfig, StepFinding, StepOutputData, StepState } from './types';
import { getAgenticFlowDir, getStateFilePath, readSkill } from './configManager';
import { getRepoMdPath } from './repoSummaryWriter';
import { formatGitContextSection } from './gitUtils';

const SECTION_SEP = '\n---\n';
const STEP_HDR = (id: string, name: string, ts: string) => `## [${id}] ${name}  ·  ${ts}`;

export function parseStateFile(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const sections = content.split(SECTION_SEP);
  for (const sec of sections) {
    const m = sec.match(/^##\s+\[([^\]]+)\]/m);
    if (m) map.set(m[1], sec.trim());
  }
  return map;
}

export function writeStepSummary(
  stateFilePath: string,
  stepId: string,
  stepName: string,
  parsed: StepOutputData,
  filesChanged: string[],
): void {
  const dir = path.dirname(stateFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const header = STEP_HDR(stepId, stepName, ts);
  const artifactList = parsed.artifacts.length
    ? `\n**Artifacts:** ${parsed.artifacts.map(a => `\`${a}\``).join(', ')}\n`
    : '';
  const changedFiles = filesChanged.length
    ? `\n**Files Changed:** ${filesChanged.map(a => `\`${a}\``).join(', ')}\n`
    : '';
  const findings = parsed.findings.length
    ? `\n**Findings:**\n${parsed.findings.map(f => `- [${f.severity}] ${f.title}${f.location ? ` (${f.location})` : ''}`).join('\n')}\n`
    : '';
  const block = `${header}${artifactList}${changedFiles}${findings}\n${parsed.summary.trim()}`;

  let existing = fs.existsSync(stateFilePath) ? fs.readFileSync(stateFilePath, 'utf8') : '';
  const stepRe = new RegExp(`${SECTION_SEP}## \\[${escapeRe(stepId)}\\][\\s\\S]*?(?=${SECTION_SEP}|$)`, 'g');
  if (stepRe.test(existing)) {
    existing = existing.replace(stepRe, `${SECTION_SEP}${block}`);
  } else {
    existing = existing ? `${existing}${SECTION_SEP}${block}` : `# Workflow State\n\n${block}`;
  }
  fs.writeFileSync(stateFilePath, existing, 'utf8');
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface BuiltPrompt {
  text: string;
  estimatedTokens: number;
}

export async function buildStepPrompt(opts: {
  step: StepConfig;
  task: string;
  session: SessionState;
  completedSteps: StepState[];
  config: AgenticFlowConfig;
  workspaceRoot: string;
  /** Git context captured once at run start. Undefined when no git repo detected. */
  gitContext?: GitContextSnapshot;
}): Promise<BuiltPrompt> {
  const { step, task, session, completedSteps, config, workspaceRoot, gitContext } = opts;
  const stateFile = getStateFilePath();
  const parts: string[] = [];
  const relevantCompletedSteps = filterRelevantCompletedSteps(step, completedSteps);

  // ── 1. Skill (full content, capped at 800 tokens — skills are now concise) ──
  if (step.skill) {
    const skill = readSkill(step.skill);
    if (skill) parts.push(`# SKILL\n\n${truncate(skill, 800)}`);
  }

  // ── 2. Session context (minimal — just what the model needs to orient itself) ──
  const isNewSession = session.iteration === 1;
  parts.push(
    `# SESSION\n\n` +
    `Title: ${session.title}\n` +
    `Iteration: ${session.iteration}${isNewSession ? ' (new)' : ' (continue)'}\n` +
    `Step goal: ${step.goal ?? step.id}`
  );

  // ── 2b. REPO.md — project context from previous runs ─────────────────────────
  // Injected only when the file exists. Aggressively truncated (600 tokens) since
  // it is background context, not the primary input for this step.
  const afDir = getAgenticFlowDir();
  if (afDir) {
    const repoMdPath = getRepoMdPath(afDir);
    if (fs.existsSync(repoMdPath)) {
      const repoContent = safeReadFile(repoMdPath);
      if (repoContent) {
        parts.push(`# PROJECT CONTEXT (REPO.md)\n\n${truncate(repoContent, 600)}`);
      }
    }
  }

  // ── 3. Objective — current task ──────────────────────────────────────────────
  parts.push(`# OBJECTIVE\n\n${task}`);

  parts.push(
    '# WORKSPACE\n\n' +
    `Workspace root: ${workspaceRoot}\n` +
    'You may create and modify files inside this workspace, including dot-directories such as `.github/` and `.agentic-flow/`, when the step requires it.'
  );

  // ── 3b. Git context — injected once per run, only when repo is present ───────
  if (gitContext?.isRepo) {
    const gitSection = formatGitContextSection(gitContext);
    if (gitSection) parts.push(gitSection);
  }

  // ── 4. Requirement history — only prior iterations, not current ──────────────
  if (session.requirements.length > 1) {
    const hist = session.requirements.slice(0, -1).slice(-3)
      .map(r => `Iter ${r.iteration}: ${r.text}`)
      .join('\n');
    parts.push(`# PRIOR ITERATIONS\n\n${hist}`);
  }

  // ── 5. Prior step context — mode-dependent ───────────────────────────────────
  if (step.contextMode !== 'none' && relevantCompletedSteps.length > 0) {
    const summaryMap = stateFile && fs.existsSync(stateFile)
      ? parseStateFile(fs.readFileSync(stateFile, 'utf8'))
      : new Map<string, string>();

    if (step.contextMode === 'full') {
      // Full: last step's raw output only (most expensive, used sparingly)
      const prev = relevantCompletedSteps[relevantCompletedSteps.length - 1];
      if (prev?.output) {
        parts.push(`# PREVIOUS STEP OUTPUT\n\n${truncate(prev.output, config.contextMaxTokens ?? 1400)}`);
      }
    } else {
      // Summary: compact structured summaries, token-budgeted
      const tokenBudget = config.contextMaxTokens ?? 1400;
      const perStepBudget = config.summaryMaxTokens ?? 250;
      const summaryBlocks: string[] = [];
      let used = 0;

      for (const completed of relevantCompletedSteps) {
        if (used >= tokenBudget) break;
        const summary = completed.parsed
          ? compactStepSummary(completed)
          : (summaryMap.get(completed.id) ?? completed.output ?? '');
        const snippet = truncate(summary, Math.min(perStepBudget, tokenBudget - used));
        summaryBlocks.push(snippet);
        used += estimateTokens(snippet);
      }

      if (summaryBlocks.length) {
        parts.push(`# PRIOR STEPS\n\n${summaryBlocks.join('\n\n')}`);
      }
    }
  }

  // ── 6. Open findings — only unresolved, de-duplicated ───────────────────────
  const openFindings = collectOpenFindings(relevantCompletedSteps);
  if (openFindings.length) {
    const formatted = openFindings.slice(0, 12).map(formatFinding).join('\n');
    const overflow = openFindings.length > 12 ? `\n…and ${openFindings.length - 12} more.` : '';
    parts.push(`# OPEN FINDINGS\n\n${formatted}${overflow}`);
  }

  // ── 7. Relevant project files (contextFiles glob) ────────────────────────────
  if (step.contextFiles?.length) {
    const files = await resolvePatterns(step.contextFiles, workspaceRoot);
    if (files.length) {
      const snippets = files.slice(0, 6).map(file => {
        const content = safeReadFile(file);
        return `### ${path.relative(workspaceRoot, file)}\n\`\`\`\n${truncate(content, 220)}\n\`\`\``;
      });
      parts.push(`# PROJECT FILES\n\n${snippets.join('\n\n')}`);
    }
  }

  // ── 8. Response format instruction ──────────────────────────────────────────
  parts.push(
    '# RESPONSE FORMAT\n\n' +
    'Complete the step, then close with this exact fenced block:\n\n' +
    '```agenticflow\n' +
    '{\n' +
    '  "stepId": "' + step.id + '",\n' +
    '  "status": "ok | issues | blocked",\n' +
    '  "summary": "1-2 sentence outcome",\n' +
    '  "decisions": [],\n' +
    '  "constraints": [],\n' +
    '  "artifacts": ["relative/path"],\n' +
    '  "nextActions": [],\n' +
    '  "findings": [\n' +
    '    { "severity": "critical|high|medium|low|info", "title": "...", "location": "...", "recommendation": "..." }\n' +
    '  ]\n' +
    '}\n' +
    '```\n\n' +
    'Keep `summary` ≤ 2 sentences. List only genuine findings — skip style nits.'
  );

  const text = parts.join('\n\n' + '─'.repeat(40) + '\n\n');
  return { text, estimatedTokens: estimateTokens(text) };
}

function filterRelevantCompletedSteps(step: StepConfig, completedSteps: StepState[]): StepState[] {
  if (!step.contextStepIds?.length) return completedSteps;
  const wanted = new Set(step.contextStepIds);
  return completedSteps.filter(completed => wanted.has(completed.id));
}

export function extractStructuredOutput(rawOutput: string, stepId: string): StepOutputData {
  const match = rawOutput.match(/```agenticflow\s*([\s\S]*?)```/i);
  if (!match) {
    return fallbackOutput(stepId, rawOutput);
  }

  try {
    const parsed = JSON.parse(match[1]) as Partial<StepOutputData>;
    return normalizeOutput(stepId, parsed);
  } catch {
    return fallbackOutput(stepId, rawOutput);
  }
}

function normalizeOutput(stepId: string, parsed: Partial<StepOutputData>): StepOutputData {
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map(normalizeFinding).filter(Boolean) as StepFinding[]
    : [];
  return {
    stepId,
    summary: String(parsed.summary ?? '').trim() || 'Step completed.',
    status: parsed.status === 'issues' || parsed.status === 'blocked' ? parsed.status : 'ok',
    decisions: normalizeStringArray(parsed.decisions),
    constraints: normalizeStringArray(parsed.constraints),
    artifacts: normalizeStringArray(parsed.artifacts),
    nextActions: normalizeStringArray(parsed.nextActions),
    findings,
  };
}

function normalizeFinding(value: unknown): StepFinding | null {
  if (!value || typeof value !== 'object') return null;
  const finding = value as Record<string, unknown>;
  const severity = String(finding.severity ?? 'info').toLowerCase();
  if (!['critical', 'high', 'medium', 'low', 'info'].includes(severity)) return null;
  return {
    severity: severity as StepFinding['severity'],
    title: String(finding.title ?? '').trim() || 'Untitled finding',
    location: finding.location ? String(finding.location) : undefined,
    recommendation: finding.recommendation ? String(finding.recommendation) : undefined,
  };
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => String(item).trim()).filter(Boolean)
    : [];
}

function fallbackOutput(stepId: string, rawOutput: string): StepOutputData {
  // Take the last 800 chars as a best-effort summary when JSON is missing
  const summary = rawOutput.trim().slice(-800) || 'No output captured.';
  return {
    stepId,
    status: 'ok',
    summary,
    decisions: [],
    constraints: [],
    artifacts: [],
    nextActions: [],
    findings: [],
  };
}

/**
 * Compact one-liner summary for a completed step used in downstream context.
 * Format: "[stepId] Status: X | Summary | Findings: N | Files: a, b"
 * Intentionally dense to preserve token budget for multiple steps.
 */
function compactStepSummary(step: StepState): string {
  const p = step.parsed!;
  const lines = [`[${step.id}] ${step.name ?? step.id} — ${p.status}`];
  if (p.summary) lines.push(p.summary);
  if (step.filesChanged?.length) lines.push(`Files: ${step.filesChanged.slice(0, 5).join(', ')}${step.filesChanged.length > 5 ? '…' : ''}`);
  if (p.findings.length) {
    const critical = p.findings.filter(f => f.severity === 'critical' || f.severity === 'high');
    if (critical.length) lines.push(`HIGH+ findings: ${critical.map(f => f.title).join('; ')}`);
    else lines.push(`Findings: ${p.findings.length} (no critical/high)`);
  }
  if (p.decisions.length) lines.push(`Decisions: ${p.decisions.slice(0, 3).join('; ')}`);
  return lines.join('\n');
}

/**
 * Collect only non-info findings from all completed steps.
 * De-duplicate by title to avoid noise when fix step re-reports.
 */
function collectOpenFindings(steps: StepState[]): StepFinding[] {
  const seen = new Set<string>();
  const findings: StepFinding[] = [];
  for (const step of steps) {
    for (const f of (step.parsed?.findings ?? [])) {
      if (f.severity === 'info') continue; // info is noise in the context
      const key = `${f.severity}:${f.title}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push(f);
      }
    }
  }
  // Sort by severity weight
  const weight: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return findings.sort((a, b) => (weight[a.severity] ?? 9) - (weight[b.severity] ?? 9));
}

function formatFinding(finding: StepFinding): string {
  const loc = finding.location ? ` @ ${finding.location}` : '';
  const rec = finding.recommendation ? ` → ${finding.recommendation}` : '';
  return `- [${finding.severity.toUpperCase()}] ${finding.title}${loc}${rec}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncate(text: string, maxTokens: number): string {
  const maxChars = Math.max(200, maxTokens * 4);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n… [truncated]';
}

async function resolvePatterns(patterns: string[], root: string): Promise<string[]> {
  const allFiles = walkFiles(root, []);
  const matches = new Set<string>();
  for (const pattern of patterns) {
    const regex = globToRegExp(pattern);
    for (const file of allFiles) {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      if (regex.test(rel)) matches.add(file);
    }
  }
  return Array.from(matches);
}

function walkFiles(dir: string, acc: string[]): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.agentic-flow' || entry.name === 'out') {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, acc);
    } else {
      acc.push(fullPath);
    }
  }
  return acc;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function safeReadFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}
