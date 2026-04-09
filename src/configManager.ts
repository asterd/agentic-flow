// ─────────────────────────────────────────────────────────────
// configManager.ts  –  Load, validate and persist config
// ─────────────────────────────────────────────────────────────
import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { AgenticFlowConfig, GitContextConfig, ModelInfo, ModelRouter, RunProfileId, RuntimeConfig, SessionState, StepCategory, StepConfig, StorageInfo } from './types';

const DEFAULT_STORAGE_DIR = '.agentic-flow';
const USER_STORAGE_HOME_DIR = '.agentic-flow';
const CONFIG_BASENAME = 'config.json';
const STATE_BASENAME = 'WORKFLOW_STATE.md';
const SESSION_BASENAME = 'session.json';
const RUNTIME_ENV_BASENAME = 'runtime.env';
const SKILLS_DIRNAME = 'skills';

export const RUN_PROFILE_PRESETS: Record<Exclude<RunProfileId, 'custom'>, { label: string; description: string; enabledStepIds: string[] }> = {
  lite: {
    label: 'Lite',
    description: 'Fastest practical flow for small or iterative changes.',
    enabledStepIds: ['spec', 'implement', 'review', 'fix', 'final-report'],
  },
  standard: {
    label: 'Standard',
    description: 'Balanced flow with architecture and formal pre-check before coding.',
    enabledStepIds: ['spec', 'architecture', 'formal-precheck', 'implement', 'review', 'fix', 'final-report'],
  },
  full: {
    label: 'Full',
    description: 'Extended flow with planning, testing, security, docs and runtime verification.',
    enabledStepIds: ['spec', 'architecture', 'implementation-plan', 'formal-precheck', 'implement', 'review', 'fix', 'test', 'security', 'docs', 'hard-check', 'final-report'],
  },
  evolutive: {
    label: 'Evolutive',
    description: 'For features and changes on an existing codebase. Starts with diff analysis to understand the current state, then implements and reviews.',
    enabledStepIds: ['diff-analysis', 'implement', 'review', 'fix', 'final-report'],
  },
  hotfix: {
    label: 'Hotfix',
    description: 'Minimal flow for urgent fixes. Analyses the diff, implements the fix and closes with a final report.',
    enabledStepIds: ['diff-analysis', 'implement', 'fix', 'final-report'],
  },
};

const DEFAULT_STEPS: StepConfig[] = [
  {
    id: 'diff-analysis',
    name: '🔎 Diff Analysis',
    enabled: false,
    model: 'claude-sonnet-4-6',
    category: 'planning',
    skill: '.agentic-flow/skills/diff-analysis.md',
    contextMode: 'none',
    goal: 'Analyse the current git diff to understand scope, intent and constraints before implementing changes.',
  },
  {
    id: 'spec',
    name: '📋 Refine Specification',
    enabled: true,
    model: 'claude-sonnet-4-6',
    category: 'planning',
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
    category: 'planning',
    skill: '.agentic-flow/skills/architecture.md',
    contextMode: 'summary',
    contextStepIds: ['spec'],
    goal: 'Turn the specification into architectural building blocks and delivery slices.',
  },
  {
    id: 'implementation-plan',
    name: '🗺 Development Plan',
    enabled: false,
    model: 'claude-sonnet-4-6',
    category: 'planning',
    skill: '.agentic-flow/skills/implementation-plan.md',
    contextMode: 'summary',
    contextStepIds: ['spec', 'architecture'],
    goal: 'Create an execution-ready implementation plan with file-level steps.',
  },
  {
    id: 'formal-precheck',
    name: '🧭 Formal Pre-Check',
    enabled: true,
    model: 'gpt-5.4',
    category: 'review',
    skill: '.agentic-flow/skills/formal-precheck.md',
    contextMode: 'summary',
    contextStepIds: ['spec', 'architecture', 'implementation-plan'],
    goal: 'Validate contracts, structure, runtime assumptions and logical consistency before implementation starts.',
  },
  {
    id: 'implement',
    name: '🛠 Implement',
    enabled: true,
    model: 'claude-sonnet-4-6',
    category: 'generation',
    skill: '.agentic-flow/skills/implement.md',
    contextMode: 'summary',
    contextStepIds: ['diff-analysis', 'spec', 'architecture', 'implementation-plan', 'formal-precheck'],
    goal: 'Implement the planned changes in the workspace.',
  },
  {
    id: 'review',
    name: '🔍 Technical Review',
    enabled: true,
    model: 'gpt-5.4',
    category: 'review',
    skill: '.agentic-flow/skills/arch-review.md',
    contextMode: 'summary',
    contextStepIds: ['spec', 'implementation-plan', 'formal-precheck', 'implement'],
    goal: 'Review the implementation for correctness, architecture and regressions.',
  },
  {
    id: 'fix',
    name: '🧯 Fix Findings',
    enabled: true,
    model: 'claude-sonnet-4-6',
    category: 'generation',
    skill: '.agentic-flow/skills/fix.md',
    contextMode: 'summary',
    contextStepIds: ['review', 'test', 'security'],
    runCondition: 'ifIssues',
    goal: 'Address review, test and security findings before closing the run.',
  },
  {
    id: 'test',
    name: '🧪 Tests & Verification',
    enabled: false,
    model: 'claude-sonnet-4-6',
    category: 'verification',
    skill: '.agentic-flow/skills/testing.md',
    contextMode: 'summary',
    contextStepIds: ['spec', 'implementation-plan', 'formal-precheck', 'implement', 'fix'],
    goal: 'Add or update tests and summarize verification results.',
  },
  {
    id: 'security',
    name: '🔒 Security Review',
    enabled: false,
    model: 'gpt-5.4',
    category: 'review',
    skill: '.agentic-flow/skills/security.md',
    contextMode: 'summary',
    contextStepIds: ['spec', 'architecture', 'formal-precheck', 'implement', 'fix'],
    goal: 'Review security impact, unsafe flows and hardening gaps.',
  },
  {
    id: 'docs',
    name: '📚 Documentation',
    enabled: false,
    model: 'gpt-5.4-mini',
    category: 'reporting',
    skill: '.agentic-flow/skills/docs.md',
    contextMode: 'summary',
    contextStepIds: ['spec', 'implementation-plan', 'formal-precheck', 'implement', 'review', 'fix', 'test', 'security'],
    goal: 'Update the documentation and operational notes required by the change.',
  },
  {
    id: 'hard-check',
    name: '💥 Runtime Hard Check',
    enabled: false,
    model: 'claude-sonnet-4-6',
    category: 'verification',
    executor: 'hard-check',
    skill: '.agentic-flow/skills/hard-check.md',
    contextMode: 'summary',
    contextStepIds: ['spec', 'implementation-plan', 'formal-precheck', 'implement', 'fix', 'test', 'docs'],
    goal: 'Try to boot the generated application for real, read runtime logs, fix startup issues and retry a bounded number of times.',
    hardCheck: {
      strategy: 'auto',
      maxAttempts: 3,
      startupTimeoutMs: 120000,
      stableWindowMs: 12000,
    },
  },
  {
    id: 'final-report',
    name: '✅ Final Report',
    enabled: true,
    model: 'gpt-5.4-mini',
    category: 'reporting',
    skill: '.agentic-flow/skills/done.md',
    contextMode: 'summary',
    goal: 'Summarize the session outcome, open risks and next actions.',
  },
];

export const DEFAULT_CONFIG: AgenticFlowConfig = {
  version: '2.0',
  runProfile: 'standard',
  steps: DEFAULT_STEPS,
  stateFile: STATE_BASENAME,
  sessionFile: SESSION_BASENAME,
  summaryMaxTokens: 250,
  contextMaxTokens: 1400,
  // Model router: maps step categories to model IDs.
  // When a step has no explicit model set, the router picks the model for its category.
  // Leave empty ({}) to keep per-step model assignments only.
  modelRouter: {},
  // Git context: captured once at run start and injected into every step prompt.
  gitContext: {
    enabled: true,
    maxTokens: 500,
    recentCommits: 5,
  },
  runtime: {
    env: {},
    envFiles: [RUNTIME_ENV_BASENAME],
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
  const dir = getActiveStorageDir();
  return dir ? path.join(dir, CONFIG_BASENAME) : undefined;
}

export function getAgenticFlowDir(): string | undefined {
  return getActiveStorageDir();
}

export function getWorkspaceOverrideDir(): string | undefined {
  const root = workspaceRoot();
  return root ? path.join(root, getStorageDirSetting()) : undefined;
}

export function getUserStorageDir(): string | undefined {
  const root = workspaceRoot();
  if (!root) return undefined;
  const home = os.homedir();
  const workspaceName = path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const workspaceHash = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);
  return path.join(home, USER_STORAGE_HOME_DIR, 'workspaces', `${workspaceName}-${workspaceHash}`);
}

export function getActiveStorageDir(): string | undefined {
  const workspaceDir = getWorkspaceOverrideDir();
  if (workspaceDir && fs.existsSync(path.join(workspaceDir, CONFIG_BASENAME))) return workspaceDir;
  return getUserStorageDir();
}

export function hasWorkspaceOverride(): boolean {
  const workspaceDir = getWorkspaceOverrideDir();
  return Boolean(workspaceDir && fs.existsSync(path.join(workspaceDir, CONFIG_BASENAME)));
}

export function getStorageInfo(): StorageInfo {
  const userDir = getUserStorageDir();
  const workspaceDir = getWorkspaceOverrideDir();
  const hasLocal = hasWorkspaceOverride();
  return {
    activeScope: hasLocal ? 'workspace' : 'user',
    activeDir: hasLocal ? workspaceDir : userDir,
    userDir,
    workspaceDir,
    hasWorkspaceOverride: hasLocal,
  };
}

export function getSkillsDir(): string | undefined {
  const dir = getActiveStorageDir();
  return dir ? path.join(dir, SKILLS_DIRNAME) : undefined;
}

export function getRuntimeEnvPath(): string | undefined {
  const dir = getActiveStorageDir();
  return dir ? path.join(dir, RUNTIME_ENV_BASENAME) : undefined;
}

export function loadConfig(): AgenticFlowConfig {
  const p = configPath();
  const vscodeOverrides = readVsCodeConfigOverrides();
  if (!p || !fs.existsSync(p)) {
    return mergeConfigSources(undefined, vscodeOverrides);
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AgenticFlowConfig>;
    return mergeConfigSources(parsed, vscodeOverrides);
  } catch (e) {
    vscode.window.showWarningMessage(`[Agentic Flow] Could not parse config: ${e}. Using defaults.`);
    return mergeConfigSources(undefined, vscodeOverrides);
  }
}

function mergeConfigSources(
  fileConfig?: Partial<AgenticFlowConfig>,
  vscodeOverrides: Partial<AgenticFlowConfig> = {},
): AgenticFlowConfig {
  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...vscodeOverrides,
    runProfile: normalizeRunProfile(vscodeOverrides.runProfile ?? fileConfig?.runProfile),
    steps: mergeSteps(vscodeOverrides.steps ?? fileConfig?.steps),
    modelRouter: {
      ...DEFAULT_CONFIG.modelRouter,
      ...fileConfig?.modelRouter,
      ...vscodeOverrides.modelRouter,
    },
    gitContext: {
      ...DEFAULT_CONFIG.gitContext,
      ...fileConfig?.gitContext,
      ...vscodeOverrides.gitContext,
    },
    runtime: {
      ...DEFAULT_CONFIG.runtime,
      ...fileConfig?.runtime,
      ...vscodeOverrides.runtime,
      envFiles: vscodeOverrides.runtime?.envFiles ?? fileConfig?.runtime?.envFiles ?? DEFAULT_CONFIG.runtime?.envFiles ?? [],
      customClis: vscodeOverrides.runtime?.customClis ?? fileConfig?.runtime?.customClis ?? DEFAULT_CONFIG.runtime?.customClis ?? [],
      customModels: vscodeOverrides.runtime?.customModels ?? fileConfig?.runtime?.customModels ?? DEFAULT_CONFIG.runtime?.customModels ?? [],
      env: {
        ...DEFAULT_CONFIG.runtime?.env,
        ...fileConfig?.runtime?.env,
        ...vscodeOverrides.runtime?.env,
      },
    },
  };
}

function readVsCodeConfigOverrides(): Partial<AgenticFlowConfig> {
  const cfg = vscode.workspace.getConfiguration('agenticFlow');

  return {
    runProfile: cfg.get<RunProfileId>('runProfile'),
    defaultModel: cfg.get<string>('defaultModel'),
    summaryMaxTokens: cfg.get<number>('summaryMaxTokens'),
    contextMaxTokens: cfg.get<number>('contextMaxTokens'),
    steps: cfg.get<StepConfig[]>('steps'),
    modelRouter: cfg.get<ModelRouter>('modelRouter'),
    gitContext: cfg.get<GitContextConfig>('gitContext'),
    runtime: cfg.get<RuntimeConfig>('runtime'),
  };
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

export function normalizeRunProfile(profile?: string): RunProfileId {
  return profile === 'lite' || profile === 'standard' || profile === 'full' ||
    profile === 'evolutive' || profile === 'hotfix' || profile === 'custom'
    ? profile
    : 'standard';
}

export function applyRunProfileToSteps(steps: StepConfig[], profile: RunProfileId): StepConfig[] {
  if (profile === 'custom') return structuredClone(steps);
  const preset = RUN_PROFILE_PRESETS[profile];
  const enabled = new Set(preset.enabledStepIds);
  return steps.map(step => ({ ...step, enabled: enabled.has(step.id) }));
}

export function saveConfig(config: AgenticFlowConfig): void {
  const dir = getActiveStorageDir();
  if (!dir) throw new Error('No workspace open');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, CONFIG_BASENAME);
  fs.writeFileSync(p, JSON.stringify({ ...config, runProfile: normalizeRunProfile(config.runProfile) }, null, 2), 'utf8');
}

export async function initWorkspace(availableModels: ModelInfo[] = []): Promise<void> {
  const dir = getUserStorageDir();
  const skillsDir = dir ? path.join(dir, SKILLS_DIRNAME) : undefined;
  if (!dir || !skillsDir) return;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });

  const cp = path.join(dir, CONFIG_BASENAME);
  if (!fs.existsSync(cp)) {
    const cfg = buildInitialConfig(availableModels);
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

export async function createWorkspaceOverride(availableModels: ModelInfo[] = []): Promise<void> {
  const dir = getWorkspaceOverrideDir();
  const skillsDir = dir ? path.join(dir, SKILLS_DIRNAME) : undefined;
  if (!dir || !skillsDir) throw new Error('No workspace open');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });

  const userDir = getUserStorageDir();
  const userConfigPath = userDir ? path.join(userDir, CONFIG_BASENAME) : undefined;
  const workspaceConfigPath = path.join(dir, CONFIG_BASENAME);
  if (!fs.existsSync(workspaceConfigPath)) {
    if (userConfigPath && fs.existsSync(userConfigPath)) {
      fs.copyFileSync(userConfigPath, workspaceConfigPath);
    } else {
      fs.writeFileSync(workspaceConfigPath, JSON.stringify(buildInitialConfig(availableModels), null, 2), 'utf8');
    }
  }

  const userRuntimePath = userDir ? path.join(userDir, RUNTIME_ENV_BASENAME) : undefined;
  const workspaceRuntimePath = path.join(dir, RUNTIME_ENV_BASENAME);
  if (!fs.existsSync(workspaceRuntimePath)) {
    if (userRuntimePath && fs.existsSync(userRuntimePath)) {
      fs.copyFileSync(userRuntimePath, workspaceRuntimePath);
    } else {
      writeRuntimeEnvTemplate(workspaceRuntimePath);
    }
  }

  const sourceSkillsDir = userDir && fs.existsSync(path.join(userDir, SKILLS_DIRNAME))
    ? path.join(userDir, SKILLS_DIRNAME)
    : undefined;
  copySkillsTemplate(skillsDir, sourceSkillsDir);
}

export function resolveSkillPath(skillPath: string): string | undefined {
  if (!skillPath) return undefined;
  if (path.isAbsolute(skillPath)) return fs.existsSync(skillPath) ? skillPath : undefined;
  const activeDir = getActiveStorageDir();
  const normalized = normalizeStorageRelativePath(skillPath);
  const candidates = [
    activeDir && path.join(activeDir, normalized),
    activeDir && path.join(activeDir, skillPath),
    workspaceRoot() && path.join(workspaceRoot()!, skillPath),
  ].filter(Boolean) as string[];
  return candidates.find(candidate => fs.existsSync(candidate));
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
  const abs = resolveManagedPath(targetPath);
  if (!abs) throw new Error('Path must stay inside the current workspace or Agentic Flow storage.');
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, initialContent, 'utf8');
  return abs;
}

export async function resetLocalSettings(): Promise<void> {
  const dir = getWorkspaceOverrideDir();
  if (!dir) throw new Error('No workspace open');
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

export function getStateFilePath(): string | undefined {
  const cfg = loadConfig();
  return resolveStorageScopedPath(cfg.stateFile, STATE_BASENAME);
}

export function getSessionFilePath(): string | undefined {
  const cfg = loadConfig();
  return resolveStorageScopedPath(cfg.sessionFile, SESSION_BASENAME);
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
  const resolved: Record<string, string> = {};

  for (const envFile of config.runtime?.envFiles ?? []) {
    const abs = resolveStorageScopedPath(envFile, RUNTIME_ENV_BASENAME);
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

function buildInitialConfig(availableModels: ModelInfo[]): AgenticFlowConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  const sanitizedModels = availableModels.filter(model => model.id !== '__none__');
  cfg.defaultModel = chooseRecommendedModel(sanitizedModels, 'generation')?.id;
  cfg.steps = cfg.steps.map(step => ({
    ...step,
    model: chooseRecommendedModel(sanitizedModels, step.category, step.model)?.id || '',
    skill: normalizeStorageRelativePath(step.skill || ''),
  }));
  return cfg;
}

function chooseRecommendedModel(models: ModelInfo[], category?: StepCategory, preferredSelection?: string): ModelInfo | undefined {
  if (!models.length) return undefined;

  const preferredProvider = inferProviderHint(preferredSelection);
  if (preferredProvider) {
    const exactProvider = models.find(model => inferProviderHint(model.id) === preferredProvider || inferProviderHint(model.modelName) === preferredProvider);
    if (exactProvider) return exactProvider;
  }

  const categoryPreference = categoryPreferredProviders(category);
  for (const provider of categoryPreference) {
    const match = models.find(model => providerMatches(model, provider));
    if (match) return match;
  }

  return models[0];
}

function categoryPreferredProviders(category?: StepCategory): string[] {
  switch (category) {
    case 'review':
    case 'reporting':
      return ['openai', 'anthropic', 'xai', 'ollama', 'vscode'];
    case 'planning':
    case 'generation':
    case 'verification':
    default:
      return ['anthropic', 'openai', 'xai', 'ollama', 'vscode'];
  }
}

function providerMatches(model: ModelInfo, provider: string): boolean {
  const haystack = `${model.providerId} ${model.providerLabel} ${model.source} ${model.sourceLabel} ${model.id} ${model.modelName}`.toLowerCase();
  return haystack.includes(provider.toLowerCase());
}

function inferProviderHint(selection?: string): string | undefined {
  const value = selection?.toLowerCase() || '';
  if (!value) return undefined;
  if (value.includes('claude') || value.includes('anthropic')) return 'anthropic';
  if (value.includes('gpt') || value.includes('openai') || value.includes('codex')) return 'openai';
  if (value.includes('grok') || value.includes('xai')) return 'xai';
  if (value.includes('ollama')) return 'ollama';
  if (value.includes('vscode')) return 'vscode';
  return undefined;
}

function writeRuntimeEnvTemplate(filePath: string): void {
  fs.writeFileSync(
    filePath,
    '# Runtime environment for Agentic Flow\n' +
    '# Put API keys or local-provider URLs here when a step cannot rely on local CLI auth.\n' +
    '# OPENAI_API_KEY=\n' +
    '# ANTHROPIC_API_KEY=\n' +
    '# OPENAI_BASE_URL=http://localhost:11434/v1\n',
    'utf8',
  );
}

function copySkillsTemplate(destinationDir: string, sourceSkillsDir?: string): void {
  if (sourceSkillsDir && fs.existsSync(sourceSkillsDir)) {
    for (const file of fs.readdirSync(sourceSkillsDir)) {
      const dest = path.join(destinationDir, file);
      if (!fs.existsSync(dest)) fs.copyFileSync(path.join(sourceSkillsDir, file), dest);
    }
    return;
  }

  const ext = vscode.extensions.getExtension('agentic-flow.agentic-flow');
  const extPath = ext?.extensionPath ?? path.join(__dirname, '..');
  const tmplDir = fs.existsSync(path.join(extPath, 'skills'))
    ? path.join(extPath, 'skills')
    : path.join(extPath, 'templates', 'skills');
  if (!fs.existsSync(tmplDir)) return;
  for (const file of fs.readdirSync(tmplDir)) {
    const dest = path.join(destinationDir, file);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(tmplDir, file), dest);
  }
}

function normalizeStorageRelativePath(targetPath: string): string {
  const trimmed = targetPath.trim();
  if (!trimmed || path.isAbsolute(trimmed)) return trimmed;
  const configuredDir = getStorageDirSetting().replace(/\\/g, '/');
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized === DEFAULT_STORAGE_DIR || normalized === configuredDir) return '';
  if (normalized.startsWith(`${DEFAULT_STORAGE_DIR}/`)) return normalized.slice(DEFAULT_STORAGE_DIR.length + 1);
  if (normalized.startsWith(`${configuredDir}/`)) return normalized.slice(configuredDir.length + 1);
  return normalized;
}

function resolveStorageScopedPath(targetPath: string | undefined, fallbackBasename: string): string | undefined {
  const activeDir = getActiveStorageDir();
  if (!activeDir) return undefined;
  const value = targetPath?.trim();
  if (!value) return path.join(activeDir, fallbackBasename);
  if (path.isAbsolute(value)) return value;
  return path.join(activeDir, normalizeStorageRelativePath(value) || fallbackBasename);
}

function resolveManagedPath(targetPath: string): string | undefined {
  if (!targetPath) return undefined;
  if (path.isAbsolute(targetPath)) {
    const activeDir = getActiveStorageDir();
    const workspace = workspaceRoot();
    const resolved = path.resolve(targetPath);
    const allowedRoots = [activeDir, workspace].filter(Boolean).map(root => path.resolve(root!));
    return allowedRoots.some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`)) ? resolved : undefined;
  }
  const activeDir = getActiveStorageDir();
  const normalized = normalizeStorageRelativePath(targetPath);
  if (activeDir) {
    const insideStorage = path.resolve(path.join(activeDir, normalized));
    const storageRoot = path.resolve(activeDir);
    if (insideStorage === storageRoot || insideStorage.startsWith(`${storageRoot}${path.sep}`)) return insideStorage;
  }
  return resolveWorkspacePath(targetPath);
}
