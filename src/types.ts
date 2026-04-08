// ─────────────────────────────────────────────────────────────
// types.ts  –  Shared type definitions for Agentic Flow
// ─────────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';
export type ContextMode = 'summary' | 'full' | 'none';
export type RunMode = 'new' | 'continue';
export type StepRunCondition = 'always' | 'ifIssues';
export type StepResultStatus = 'ok' | 'issues' | 'blocked';
export type StepExecutor = 'model' | 'hard-check';
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

export interface AgenticFlowConfig {
  version: string;
  steps: StepConfig[];
  stateFile?: string;
  sessionFile?: string;
  summaryMaxTokens?: number;
  contextMaxTokens?: number;
  defaultModel?: string;
  runtime?: RuntimeConfig;
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
}

export type ExtToWebMsg =
  | { type: 'init'; models: ModelInfo[]; config: AgenticFlowConfig; session: SessionState | null }
  | { type: 'runState'; state: WorkflowRunState }
  | { type: 'stepLog'; stepId: string; chunk: string }
  | { type: 'configSaved' }
  | { type: 'sessionUpdated'; session: SessionState | null }
  | { type: 'error'; message: string };

export interface StepOverride {
  id: string;
  enabled?: boolean;
  model?: string;
  skill?: string;
}

export type WebToExtMsg =
  | { type: 'startRun'; task: string; mode: RunMode; stepOverrides?: StepOverride[] }
  | { type: 'cancelRun' }
  | { type: 'saveConfig'; config: AgenticFlowConfig }
  | { type: 'refreshModels' }
  | { type: 'openSettingsUi' }
  | { type: 'newSession' }
  | { type: 'openSkillFile'; skillPath: string }
  | { type: 'resetLocalSettings' }
  | { type: 'ready' };
