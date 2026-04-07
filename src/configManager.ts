// ─────────────────────────────────────────────────────────────
// configManager.ts  –  Load, validate and persist config
// ─────────────────────────────────────────────────────────────
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { AgenticFlowConfig, SessionState, StepConfig } from './types';

const DEFAULT_STORAGE_DIR = '.agentic-flow';
const CONFIG_BASENAME = 'config.json';
const STATE_BASENAME = 'WORKFLOW_STATE.md';
const SESSION_BASENAME = 'session.json';
const RUNTIME_ENV_BASENAME = 'runtime.env';
const SKILLS_DIRNAME = 'skills';

const DEFAULT_STEPS: StepConfig[] = [
  {
    id: 'spec',
    name: '📋 Refine Specification',
    enabled: true,
    model: 'claude-sonnet-4-6',
    skill: '.agentic-flow/skills/spec.md',
    contextMode: 'none',
    contextFiles: ['README.md', 'docs/**/*.md'],
    goal: 'Transform the requirement into a precise specification.',
  },
  {
    id: 'architecture',
    name: '🏛 Architecture Breakdown',
    enabled: true,
    model: 'claude-sonnet-4-6',
    skill: '.agentic-flow/skills/architecture.md',
    contextMode: 'summary',
    contextStepIds: ['spec'],
    goal: 'Turn the specification into architectural building blocks and delivery slices.',
  },
  {
    id: 'implementation-plan',
    name: '🗺 Development Plan',
    enabled: true,
    model: 'claude-sonnet-4-6',
    skill: '.agentic-flow/skills/implementation-plan.md',
    contextMode: 'summary',
    contextStepIds: ['spec', 'architecture'],
    goal: 'Create an execution-ready implementation plan with file-level steps.',
  },
  {
    id: 'implement',
    name: '🛠 Implement',
    enabled: true,
    model: 'claude-sonnet-4-6',
    skill: '.agentic-flow/skills/implement.md',
    contextMode: 'summary',
    contextStepIds: ['spec', 'architecture', 'implementation-plan'],
    goal: 'Implement the planned changes in the workspace.',
  },
  {
    id: 'review',
    name: '🔍 Technical Review',
    enabled: true,
    model: 'gpt-5.4',
    skill: '.agentic-flow/skills/arch-review.md',
    contextMode: 'summary',
    contextStepIds: ['spec', 'implementation-plan', 'implement'],
    goal: 'Review the implementation for correctness, architecture and regressions.',
  },
  {
    id: 'fix',
    name: '🧯 Fix Findings',
    enabled: true,
    model: 'claude-sonnet-4-6',
    skill: '.agentic-flow/skills/fix.md',
    contextMode: 'summary',
    contextStepIds: ['review', 'test', 'security'],
    runCondition: 'ifIssues',
    goal: 'Address review, test and security findings before closing the run.',
  },
  {
    id: 'test',
    name: '🧪 Tests & Verification',
    enabled: true,
    model: 'claude-sonnet-4-6',
    skill: '.agentic-flow/skills/testing.md',
    contextMode: 'summary',
    contextStepIds: ['spec', 'implementation-plan', 'implement', 'fix'],
    goal: 'Add or update tests and summarize verification results.',
  },
  {
    id: 'security',
    name: '🔒 Security Review',
    enabled: true,
    model: 'gpt-5.4',
    skill: '.agentic-flow/skills/security.md',
    contextMode: 'summary',
    contextStepIds: ['spec', 'architecture', 'implement', 'fix'],
    goal: 'Review security impact, unsafe flows and hardening gaps.',
  },
  {
    id: 'docs',
    name: '📚 Documentation',
    enabled: true,
    model: 'gpt-5.4-mini',
    skill: '.agentic-flow/skills/docs.md',
    contextMode: 'summary',
    contextStepIds: ['spec', 'implementation-plan', 'implement', 'review', 'fix', 'test', 'security'],
    goal: 'Update the documentation and operational notes required by the change.',
  },
  {
    id: 'final-report',
    name: '✅ Final Report',
    enabled: true,
    model: 'gpt-5.4-mini',
    skill: '.agentic-flow/skills/done.md',
    contextMode: 'summary',
    goal: 'Summarize the session outcome, open risks and next actions.',
  },
];

export const DEFAULT_CONFIG: AgenticFlowConfig = {
  version: '2.0',
  steps: DEFAULT_STEPS,
  stateFile: path.join(DEFAULT_STORAGE_DIR, STATE_BASENAME),
  sessionFile: path.join(DEFAULT_STORAGE_DIR, SESSION_BASENAME),
  summaryMaxTokens: 250,
  contextMaxTokens: 1400,
  runtime: {
    env: {},
    envFiles: [path.join(DEFAULT_STORAGE_DIR, RUNTIME_ENV_BASENAME)],
    customClis: [],
    customModels: [],
  },
};

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function getWorkspaceRoot(): string | undefined {
  return workspaceRoot();
}

function configPath(): string | undefined {
  const dir = getAgenticFlowDir();
  return dir ? path.join(dir, CONFIG_BASENAME) : undefined;
}

export function getAgenticFlowDir(): string | undefined {
  const root = workspaceRoot();
  return root ? path.join(root, getStorageDirSetting()) : undefined;
}

export function getSkillsDir(): string | undefined {
  const dir = getAgenticFlowDir();
  return dir ? path.join(dir, SKILLS_DIRNAME) : undefined;
}

export function getRuntimeEnvPath(): string | undefined {
  const dir = getAgenticFlowDir();
  return dir ? path.join(dir, RUNTIME_ENV_BASENAME) : undefined;
}

export function loadConfig(): AgenticFlowConfig {
  const p = configPath();
  if (!p || !fs.existsSync(p)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AgenticFlowConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      steps: mergeSteps(parsed.steps),
      runtime: {
        ...DEFAULT_CONFIG.runtime,
        ...parsed.runtime,
        envFiles: parsed.runtime?.envFiles ?? [],
        customClis: parsed.runtime?.customClis ?? [],
        customModels: parsed.runtime?.customModels ?? [],
      },
    };
  } catch (e) {
    vscode.window.showWarningMessage(`[Agentic Flow] Could not parse config: ${e}. Using defaults.`);
    return structuredClone(DEFAULT_CONFIG);
  }
}

function mergeSteps(parsedSteps?: StepConfig[]): StepConfig[] {
  if (!parsedSteps?.length) return structuredClone(DEFAULT_STEPS);

  const defaultsById = new Map(DEFAULT_STEPS.map(step => [step.id, step]));
  const merged = parsedSteps.map(step => {
    const defaults = defaultsById.get(step.id);
    if (!defaults) return step;
    const mergedStep = { ...defaults, ...step };
    if (step.id === 'architecture' && step.skill === '.agentic-flow/skills/plan.md') {
      mergedStep.skill = defaults.skill;
    }
    if (step.id === 'implementation-plan' && step.skill === '.agentic-flow/skills/plan.md') {
      mergedStep.skill = defaults.skill;
    }
    return mergedStep;
  });

  for (const defaults of DEFAULT_STEPS) {
    if (!merged.some(step => step.id === defaults.id)) merged.push(structuredClone(defaults));
  }

  return merged;
}

export function saveConfig(config: AgenticFlowConfig): void {
  const dir = getAgenticFlowDir();
  if (!dir) throw new Error('No workspace open');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, CONFIG_BASENAME);
  fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf8');
}

export async function initWorkspace(defaultModel?: string): Promise<void> {
  const dir = getAgenticFlowDir();
  const skillsDir = getSkillsDir();
  if (!dir || !skillsDir) return;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });

  const cp = path.join(dir, CONFIG_BASENAME);
  if (!fs.existsSync(cp)) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    if (defaultModel) {
      cfg.defaultModel = defaultModel;
      cfg.steps = cfg.steps.map((step, index) => ({
        ...step,
        model: index === 0 && !step.model ? defaultModel : step.model || defaultModel,
      }));
    }
    fs.writeFileSync(cp, JSON.stringify(cfg, null, 2), 'utf8');
  }

  const runtimeEnvPath = path.join(dir, RUNTIME_ENV_BASENAME);
  if (!fs.existsSync(runtimeEnvPath)) {
    fs.writeFileSync(
      runtimeEnvPath,
      '# Runtime environment for Agentic Flow\n' +
      '# Put API keys or local-provider URLs here when a step cannot rely on local CLI auth.\n' +
      '# OPENAI_API_KEY=\n' +
      '# ANTHROPIC_API_KEY=\n' +
      '# OPENAI_BASE_URL=http://localhost:11434/v1\n',
      'utf8',
    );
  }

  const ext = vscode.extensions.getExtension('agentic-flow.agentic-flow');
  const extPath = ext?.extensionPath ?? path.join(__dirname, '..');
  // Skills can be in <ext>/skills or <ext>/templates/skills
  const tmplDir = fs.existsSync(path.join(extPath, 'skills'))
    ? path.join(extPath, 'skills')
    : path.join(extPath, 'templates', 'skills');
  if (fs.existsSync(tmplDir)) {
    for (const f of fs.readdirSync(tmplDir)) {
      const dest = path.join(skillsDir, f);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(tmplDir, f), dest);
      }
    }
  }
}

export function resolveSkillPath(skillPath: string): string | undefined {
  if (!skillPath) return undefined;
  if (path.isAbsolute(skillPath)) return fs.existsSync(skillPath) ? skillPath : undefined;
  const root = workspaceRoot();
  if (!root) return undefined;
  const abs = path.join(root, skillPath);
  return fs.existsSync(abs) ? abs : undefined;
}

export function resolveWorkspacePath(targetPath: string): string | undefined {
  if (!targetPath) return undefined;
  const root = workspaceRoot();
  if (!root) return undefined;
  const abs = path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
  const normalRoot = path.resolve(root);
  const normalAbs = path.resolve(abs);
  return normalAbs === normalRoot || normalAbs.startsWith(`${normalRoot}${path.sep}`) ? normalAbs : undefined;
}

export function readSkill(skillPath: string): string {
  const abs = resolveSkillPath(skillPath);
  if (!abs) return '';
  return fs.readFileSync(abs, 'utf8');
}

export function ensureWorkspaceFile(targetPath: string, initialContent = ''): string {
  const abs = resolveWorkspacePath(targetPath);
  if (!abs) throw new Error('Path must stay inside the current workspace.');
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, initialContent, 'utf8');
  return abs;
}

export async function resetLocalSettings(defaultModel?: string): Promise<void> {
  const dir = getAgenticFlowDir();
  if (!dir) throw new Error('No workspace open');
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  await initWorkspace(defaultModel);
}

export function getStateFilePath(): string | undefined {
  const root = workspaceRoot();
  if (!root) return undefined;
  const cfg = loadConfig();
  return path.join(root, cfg.stateFile ?? path.join(getStorageDirSetting(), STATE_BASENAME));
}

export function getSessionFilePath(): string | undefined {
  const root = workspaceRoot();
  if (!root) return undefined;
  const cfg = loadConfig();
  return path.join(root, cfg.sessionFile ?? path.join(getStorageDirSetting(), SESSION_BASENAME));
}

export function loadSessionState(): SessionState | null {
  const sessionPath = getSessionFilePath();
  if (!sessionPath || !fs.existsSync(sessionPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as SessionState;
  } catch {
    return null;
  }
}

export function saveSessionState(session: SessionState): void {
  const sessionPath = getSessionFilePath();
  if (!sessionPath) throw new Error('No workspace open');
  const dir = path.dirname(sessionPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
}

export function resolveRuntimeEnv(config: AgenticFlowConfig): Record<string, string> {
  const root = workspaceRoot();
  const resolved: Record<string, string> = {};

  for (const envFile of config.runtime?.envFiles ?? []) {
    const abs = root && !path.isAbsolute(envFile) ? path.join(root, envFile) : envFile;
    if (!abs || !fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key) resolved[key] = value;
    }
  }

  Object.assign(resolved, config.runtime?.env ?? {});
  return resolved;
}

export function getStorageDirSetting(): string {
  const configured = vscode.workspace.getConfiguration('agenticFlow').get<string>('workspaceStorageDir', DEFAULT_STORAGE_DIR)?.trim();
  return configured || DEFAULT_STORAGE_DIR;
}
