// ─────────────────────────────────────────────────────────────
// types.ts  –  Shared type definitions for Agentic Flow
// ─────────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';
export type ContextMode = 'summary' | 'full' | 'none';
export type RunMode = 'new' | 'continue';
export type StepRunCondition = 'always' | 'ifIssues';
export type StepResultStatus = 'ok' | 'issues' | 'blocked';
export type StepExecutor = 'model' | 'hard-check';
export type RunProfileId = 'lite' | 'standard' | 'full' | 'evolutive' | 'hotfix' | 'custom';
export type StepCategory = 'planning' | 'generation' | 'review' | 'verification' | 'reporting';
export type ModelSource = 'cli' | 'api' | 'vscode';
export type TokenAccounting = 'estimated' | 'reported';
export type ApiProviderId = 'openai' | 'anthropic' | 'xai' | 'openrouter' | 'ollama';
export type HardCheckStrategy = 'auto' | 'docker-compose' | 'local-node' | 'laravel';

export interface CliInfo {
  id: string;
  label: string;
  path: string;
  version?: string;
  source: 'system' | 'vscode-extension' | 'node_modules';
}

export interface ModelInfo {
  id: string;
  modelName: string;
  label: string;
  providerId: string;
  providerLabel: string;
  source: ModelSource;
  sourceLabel: string;
  cliId?: string;
  apiProviderId?: ApiProviderId;
  contextWindow?: number;
  launchArgs?: string[];
  env?: Record<string, string>;
  discovery?: 'cli' | 'cache' | 'static' | 'manual';
  description?: string;
  tokenAccounting?: TokenAccounting;
  pricing?: ModelPricing;
}

export interface ModelPricing {
  inputPer1MTokensUsd?: number;
  outputPer1MTokensUsd?: number;
  cachedInputPer1MTokensUsd?: number;
}

export interface StepFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  location?: string;
  recommendation?: string;
}

export interface StepOutputData {
  stepId: string;
  summary: string;
  status: StepResultStatus;
  decisions: string[];
  constraints: string[];
  artifacts: string[];
  nextActions: string[];
  findings: StepFinding[];
}

export interface SkillRef {
  path: string;
  label?: string;
}

export interface StepConfig {
  id: string;
  name: string;
  enabled: boolean;
  model: string;
  executor?: StepExecutor;
  cli?: string;
  skill?: string;
  contextMode?: ContextMode;
  contextStepIds?: string[];
  contextFiles?: string[];
  runCondition?: StepRunCondition;
  goal?: string;
  hardCheck?: HardCheckConfig;
  /** Optional category used by the model router when no explicit model is set for this step. */
  category?: StepCategory;
  meta?: Record<string, unknown>;
}

export interface HardCheckConfig {
  strategy?: HardCheckStrategy;
  maxAttempts?: number;
  startupTimeoutMs?: number;
  stableWindowMs?: number;
  healthUrl?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  healthCommand?: string;
  logCommand?: string;
  teardownCommand?: string;
  env?: Record<string, string>;
}

/**
 * Maps step categories to model IDs used when a step has no explicit model set.
 * Example: { "planning": "claude-opus-4-6", "generation": "claude-sonnet-4-6", "review": "gpt-5.4" }
 */
export type ModelRouter = Partial<Record<StepCategory, string>>;

export interface GitContextConfig {
  /** Whether to capture git context before each run. Defaults to true when a git repo is detected. */
  enabled?: boolean;
  /** Max tokens to budget for the git diff section. Defaults to 500. */
  maxTokens?: number;
  /** Number of recent commits to include in context. Defaults to 5. */
  recentCommits?: number;
}

export interface AgenticFlowConfig {
  version: string;
  runProfile?: RunProfileId;
  steps: StepConfig[];
  stateFile?: string;
  sessionFile?: string;
  summaryMaxTokens?: number;
  contextMaxTokens?: number;
  defaultModel?: string;
  /** Per-category model routing. Applied when a step has no explicit model set. */
  modelRouter?: ModelRouter;
  /** Git context injection settings. */
  gitContext?: GitContextConfig;
  runtime?: RuntimeConfig;
}

export interface StorageInfo {
  activeScope: 'user' | 'workspace';
  activeDir?: string;
  userDir?: string;
  workspaceDir?: string;
  hasWorkspaceOverride: boolean;
}

export interface RuntimeConfig {
  env?: Record<string, string>;
  envFiles?: string[];
  customClis?: CustomCliConfig[];
  customModels?: CustomModelConfig[];
}

export interface CustomCliConfig {
  id: string;
  label: string;
  path: string;
}

export interface CustomModelConfig {
  id: string;
  label: string;
  cliId: string;
  modelName?: string;
  contextWindow?: number;
  launchArgs?: string[];
  env?: Record<string, string>;
  description?: string;
}

export interface ApiProviderSettings {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  modelAllowList?: string[];
  extraHeaders?: Record<string, string>;
}

export interface ResolvedApiProviderSettings {
  id: ApiProviderId;
  label: string;
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  modelAllowList: string[];
  extraHeaders: Record<string, string>;
  apiKeySource: 'secret' | 'settings' | 'env' | 'none';
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUsd?: number;
  accounting: TokenAccounting;
}

export interface StepState {
  id: string;
  name?: string;
  status: StepStatus;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  parsed?: StepOutputData;
  error?: string;
  tokensUsed?: number;
  promptTokens?: number;
  outputTokens?: number;
  tokenUsage?: TokenUsage;
  durationMs?: number;
  modelId?: string;
  modelLabel?: string;
  cliId?: string;
  source?: ModelSource;
  sourceLabel?: string;
  skillPath?: string;
  filesChanged?: string[];
  attempts?: number;
  verificationStatus?: 'passed' | 'failed' | 'timeout' | 'blocked';
}

export interface WorkflowRunState {
  runId: string;
  sessionId: string;
  iteration: number;
  startedAt: number;
  task: string;
  mode: RunMode;
  steps: StepState[];
  currentStepIndex: number;
  finished: boolean;
  cancelled: boolean;
  title?: string;
  /** Git context captured once at run start. Undefined when workspace has no git repo. */
  gitContext?: GitContextSnapshot;
}

export interface SessionRequirement {
  iteration: number;
  text: string;
  createdAt: number;
}

export interface RunHistoryEntry {
  runId: string;
  iteration: number;
  startedAt: number;
  finishedAt?: number;
  task: string;
  status: 'running' | 'completed' | 'cancelled' | 'error';
  steps: Array<{
    id: string;
    name?: string;
    status: StepStatus;
    modelId?: string;
    modelLabel?: string;
    cliId?: string;
    source?: ModelSource;
    sourceLabel?: string;
    summary?: string;
    filesChanged?: string[];
    findings?: StepFinding[];
    durationMs?: number;
    tokensUsed?: number;
    promptTokens?: number;
    outputTokens?: number;
    tokenUsage?: TokenUsage;
    attempts?: number;
    verificationStatus?: 'passed' | 'failed' | 'timeout' | 'blocked';
  }>;
}

export interface SessionState {
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  iteration: number;
  currentObjective: string;
  requirements: SessionRequirement[];
  latestRun?: RunHistoryEntry;
  runs: RunHistoryEntry[];
  microActions?: MicroActionEntry[];
}

export type ExtToWebMsg =
  | { type: 'init'; models: ModelInfo[]; config: AgenticFlowConfig; session: SessionState | null; language?: string; storage?: StorageInfo }
  | { type: 'runState'; state: WorkflowRunState }
  | { type: 'stepLog'; stepId: string; chunk: string }
  | { type: 'configSaved' }
  | { type: 'sessionUpdated'; session: SessionState | null }
  | { type: 'microActionChunk'; chunk: string }
  | { type: 'microActionDone'; entry: MicroActionEntry }
  | { type: 'microActionError'; message: string }
  | { type: 'error'; message: string };

export interface StepOverride {
  id: string;
  enabled?: boolean;
  model?: string;
  skill?: string;
}

export interface MicroActionEntry {
  id: string;
  prompt: string;
  modelId: string;
  modelLabel: string;
  output: string;
  createdAt: number;
  durationMs: number;
  tokensUsed?: number;
  tokenUsage?: TokenUsage;
}

/** Snapshot of git state captured once at run start. Undefined when no git repo is detected. */
export interface GitContextSnapshot {
  isRepo: boolean;
  branch?: string;
  status?: string;       // git status --porcelain output
  stagedDiff?: string;   // git diff --cached
  unstagedDiff?: string; // git diff
  recentLog?: string;    // git log --oneline -N
}

export type WebToExtMsg =
  | { type: 'startRun'; task: string; mode: RunMode; stepOverrides?: StepOverride[] }
  | { type: 'cancelRun' }
  | { type: 'rerunStep'; stepId: string }
  | { type: 'runMicroAction'; prompt: string; modelId: string; includeContext: boolean }
  | { type: 'cancelMicroAction' }
  | { type: 'openDocs' }
  | { type: 'saveConfig'; config: AgenticFlowConfig }
  | { type: 'refreshModels' }
  | { type: 'openSettingsUi' }
  | { type: 'newSession' }
  | { type: 'openSkillFile'; skillPath: string }
  | { type: 'createWorkspaceOverride' }
  | { type: 'resetLocalSettings' }
  | { type: 'ready' };
