import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { loadConfig } from './configManager';
import { getConfiguredApiProviders, providerDefaultModels, providerRequiresApiKey } from './providerConfig';
import type {
  AgenticFlowConfig,
  CliInfo,
  CustomCliConfig,
  CustomModelConfig,
  ModelInfo,
  ModelPricing,
  ResolvedApiProviderSettings,
  StepConfig,
} from './types';

const execFileAsync = promisify(execFile);

interface CliDescriptor {
  id: string;
  providerLabel: string;
  bins: string[];
  versionFlag: string;
  staticModels?: Array<{ id: string; label: string; description?: string }>;
}

const KNOWN_CLIS: CliDescriptor[] = [
  {
    id: 'claude',
    providerLabel: 'Claude Code',
    bins: ['claude'],
    versionFlag: '--version',
    staticModels: [
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Balanced implementation model.' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'Fast review and lightweight tasks.' },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', description: 'High-end architecture and planning.' },
    ],
  },
  {
    id: 'codex',
    providerLabel: 'OpenAI',
    bins: ['codex'],
    versionFlag: '--version',
    staticModels: [
      { id: 'gpt-5-codex', label: 'GPT-5 Codex', description: 'Coding-oriented model.' },
      { id: 'gpt-5.4', label: 'GPT-5.4', description: 'Frontier general model.' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4-mini', description: 'Lower-cost fast model.' },
    ],
  },
  {
    id: 'continue',
    providerLabel: 'Continue',
    bins: ['cn', 'continue'],
    versionFlag: '--version',
    staticModels: [],
  },
  {
    id: 'copilot',
    providerLabel: 'GitHub Copilot',
    bins: ['gh'],
    versionFlag: 'copilot --version',
    staticModels: [
      { id: 'copilot-gpt-4o', label: 'Copilot GPT-4o' },
      { id: 'copilot-claude', label: 'Copilot Claude Sonnet' },
    ],
  },
];

export interface DetectedEnvironment {
  clis: CliInfo[];
  models: ModelInfo[];
}

export async function detectEnvironment(): Promise<DetectedEnvironment> {
  const config = loadConfig();
  const clis: CliInfo[] = [];
  const models: ModelInfo[] = [];

  for (const descriptor of KNOWN_CLIS) {
    const binPath = await resolveBin(descriptor.bins);
    if (!binPath) continue;

    const version = await getBinVersion(binPath, descriptor.versionFlag);
    clis.push({ id: descriptor.id, label: descriptor.providerLabel, path: binPath, version, source: 'system' });

    const discoveredModels = await queryCliModels(descriptor);
    for (const model of discoveredModels) upsertModel(models, model);
  }

  for (const customCli of config.runtime?.customClis ?? []) {
    const cli = detectCustomCli(customCli);
    if (cli) upsertCli(clis, cli);
  }

  for (const customModel of config.runtime?.customModels ?? []) {
    upsertModel(models, customModelToModelInfo(customModel));
  }

  const providerSettings = await getConfiguredApiProviders();
  for (const provider of Object.values(providerSettings)) {
    const apiModels = await queryApiModels(provider);
    for (const model of apiModels) upsertModel(models, model);
  }

  const vscodeModels = await detectVSCodeExtensionModels();
  vscodeModels.forEach(model => upsertModel(models, model));

  if (models.length === 0) {
    models.push({
      id: '__none__',
      modelName: '__none__',
      label: 'No model detected',
      providerId: 'none',
      providerLabel: 'Unavailable',
      source: 'cli',
      sourceLabel: 'Unavailable',
      discovery: 'static',
      tokenAccounting: 'estimated',
    });
  }

  return { clis, models: sortModels(models) };
}

export function resolveCliForModel(model: ModelInfo, clis: CliInfo[]): CliInfo | undefined {
  if (model.source !== 'cli' || !model.cliId) return undefined;
  return clis.find(cli => cli.id === model.cliId);
}

export function resolveModelSelection(selection: string, models: ModelInfo[]): ModelInfo | undefined {
  if (!selection) return undefined;

  const exact = models.find(model => model.id === selection);
  if (exact) return exact;

  const byName = models.filter(model => model.modelName === selection);
  if (!byName.length) return undefined;

  return byName.sort((left, right) => sourcePriority(left.source) - sourcePriority(right.source))[0];
}

/**
 * Resolve the model for a step using the priority chain:
 * 1. Step's explicit `model` field
 * 2. Model router entry for the step's `category`
 * 3. `config.defaultModel`
 *
 * Falls back to undefined only when nothing resolves.
 */
export function resolveModelForStep(
  step: StepConfig,
  config: AgenticFlowConfig,
  models: ModelInfo[],
): ModelInfo | undefined {
  // 1. Explicit step model
  if (step.model) {
    const m = resolveModelSelection(step.model, models);
    if (m) return m;
  }

  // 2. Category-based router
  if (step.category && config.modelRouter) {
    const routedId = config.modelRouter[step.category];
    if (routedId) {
      const m = resolveModelSelection(routedId, models);
      if (m) return m;
    }
  }

  // 3. Global default model
  if (config.defaultModel) {
    return resolveModelSelection(config.defaultModel, models);
  }

  return undefined;
}

function sourcePriority(source: ModelInfo['source']): number {
  switch (source) {
    case 'cli':
      return 0;
    case 'api':
      return 1;
    case 'vscode':
      return 2;
  }
}

async function resolveBin(names: string[]): Promise<string | null> {
  const extraPaths = vscode.workspace.getConfiguration('agenticFlow').get<string[]>('extraCliPaths', []);
  for (const name of names) {
    const direct = resolveFromExtraPaths(name, extraPaths);
    if (direct) return direct;
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const { stdout } = await execFileAsync(cmd, [name], { timeout: 3000 });
      const resolved = stdout.trim().split('\n')[0];
      if (resolved) return resolved;
    } catch {}
  }
  return null;
}

function resolveFromExtraPaths(name: string, extraPaths: string[]): string | null {
  for (const extraPath of extraPaths) {
    const candidate = path.join(extraPath, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function getBinVersion(binPath: string, versionFlag: string): Promise<string | undefined> {
  try {
    const args = versionFlag.split(' ');
    const { stdout } = await execFileAsync(binPath, args, { timeout: 5000 });
    return stdout.trim().split('\n')[0];
  } catch {
    return undefined;
  }
}

async function detectVSCodeExtensionModels(): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  try {
    const available = await vscode.lm.selectChatModels({});
    for (const model of available) {
      models.push({
        id: `vscode:${model.id}`,
        modelName: model.id,
        label: model.name,
        providerId: 'vscode-lm',
        providerLabel: 'VS Code LM',
        source: 'vscode',
        sourceLabel: 'VS Code LM',
        contextWindow: model.maxInputTokens,
        discovery: 'cli',
        tokenAccounting: 'estimated',
      });
    }
  } catch {}
  return models;
}

async function queryCliModels(descriptor: CliDescriptor): Promise<ModelInfo[]> {
  if (descriptor.id === 'codex') {
    const cached = readCodexModelsFromCache();
    if (cached.length) {
      return cached.map(model => createCliModel(descriptor, model.id, model.label, {
        contextWindow: model.contextWindow,
        description: model.description,
        discovery: 'cache',
      }));
    }
  }

  if (descriptor.id === 'claude') {
    return readClaudeKnownModels().map(model => createCliModel(descriptor, model.id, model.label, {
      description: model.description,
      discovery: 'static',
    }));
  }

  return (descriptor.staticModels ?? []).map(model => createCliModel(descriptor, model.id, model.label, {
    description: model.description,
    discovery: 'static',
  }));
}

async function queryApiModels(provider: ResolvedApiProviderSettings): Promise<ModelInfo[]> {
  if (!provider.enabled) return [];
  if (providerRequiresApiKey(provider.id) && !provider.apiKey) return [];

  try {
    const discovered = await fetchProviderModels(provider);
    if (discovered.length) return applyAllowList(discovered, provider.modelAllowList);
  } catch {}

  return applyAllowList(
    providerDefaultModels(provider.id).map(model => createApiModel(provider, model.id, model.label, {
      contextWindow: model.contextWindow,
      description: model.description,
      pricing: model.pricing,
      discovery: 'static',
    })),
    provider.modelAllowList,
  );
}

async function fetchProviderModels(provider: ResolvedApiProviderSettings): Promise<ModelInfo[]> {
  switch (provider.id) {
    case 'anthropic':
      return fetchAnthropicModels(provider);
    case 'ollama':
      return fetchOllamaModels(provider);
    default:
      return fetchOpenAiCompatibleModels(provider);
  }
}

async function fetchAnthropicModels(provider: ResolvedApiProviderSettings): Promise<ModelInfo[]> {
  const response = await fetchJson<{ data?: Array<Record<string, unknown>> }>(
    `${provider.baseUrl}/models`,
    { method: 'GET', headers: buildApiHeaders(provider) },
  );

  const items = Array.isArray(response.data) ? response.data : [];
  return items
    .map(item => {
      const modelName = String(item.id ?? '').trim();
      if (!modelName) return undefined;
      const displayName = stringOrUndefined(item.display_name)
        || stringOrUndefined(item.name)
        || humanizeAnthropicModelName(modelName);
      return createApiModel(provider, modelName, displayName, {
        contextWindow: 200_000,
        description: stringOrUndefined(item.description),
        discovery: 'cli',
      });
    })
    .filter((model): model is ModelInfo => Boolean(model));
}

async function fetchOpenAiCompatibleModels(provider: ResolvedApiProviderSettings): Promise<ModelInfo[]> {
  const response = await fetchJson<{ data?: Array<Record<string, unknown>> }>(
    `${provider.baseUrl}/models`,
    { method: 'GET', headers: buildApiHeaders(provider) },
  );

  const items = Array.isArray(response.data) ? response.data : [];
  return items
    .map(item => {
      const modelName = String(item.id ?? '').trim();
      if (!modelName || !isLikelyChatModel(modelName)) return undefined;
      const label = String(item.name ?? item.display_name ?? modelName);
      const pricing = extractPricing(item);
      return createApiModel(provider, modelName, label, {
        contextWindow: numberOrUndefined(item.context_length ?? item.context_window),
        description: stringOrUndefined(item.description),
        pricing,
        discovery: 'cli',
      });
    })
    .filter((model): model is ModelInfo => Boolean(model));
}

async function fetchOllamaModels(provider: ResolvedApiProviderSettings): Promise<ModelInfo[]> {
  const baseOrigin = provider.baseUrl.replace(/\/v1$/, '');
  const response = await fetchJson<{ models?: Array<Record<string, unknown>> }>(
    `${baseOrigin}/api/tags`,
    { method: 'GET', headers: buildApiHeaders(provider) },
  );

  const models = Array.isArray(response.models) ? response.models : [];
  return models
    .map(item => {
      const modelName = String(item.name ?? '').trim();
      if (!modelName) return undefined;
      return createApiModel(provider, modelName, modelName, { discovery: 'cli' });
    })
    .filter((model): model is ModelInfo => Boolean(model));
}

function createCliModel(
  descriptor: CliDescriptor,
  modelName: string,
  label: string,
  extras: Partial<ModelInfo> = {},
): ModelInfo {
  return {
    id: makeModelId('cli', descriptor.id, modelName),
    modelName,
    label,
    providerId: descriptor.id,
    providerLabel: descriptor.providerLabel,
    source: 'cli',
    sourceLabel: `Local CLI · ${descriptor.providerLabel}`,
    cliId: descriptor.id,
    tokenAccounting: 'estimated',
    ...extras,
  };
}

function createApiModel(
  provider: ResolvedApiProviderSettings,
  modelName: string,
  label: string,
  extras: Partial<ModelInfo> = {},
): ModelInfo {
  return {
    id: makeModelId('api', provider.id, modelName),
    modelName,
    label,
    providerId: provider.id,
    providerLabel: provider.label,
    source: 'api',
    sourceLabel: `API · ${provider.label}`,
    apiProviderId: provider.id,
    tokenAccounting: 'reported',
    ...extras,
  };
}

function makeModelId(source: ModelInfo['source'], providerId: string, modelName: string): string {
  return `${source}:${providerId}:${modelName}`;
}

function applyAllowList(models: ModelInfo[], allowList: string[]): ModelInfo[] {
  if (!allowList.length) return models;
  const allowed = new Set(allowList);
  return models.filter(model => allowed.has(model.modelName) || allowed.has(model.id));
}

function readCodexModelsFromCache(): Array<Pick<ModelInfo, 'modelName' | 'label' | 'contextWindow' | 'description'> & { id: string }> {
  const cachePath = path.join(os.homedir(), '.codex', 'models_cache.json');
  if (!fs.existsSync(cachePath)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
      models?: Array<{
        slug?: string;
        display_name?: string;
        context_window?: number;
        description?: string;
        visibility?: string;
      }>;
    };
    const models = raw.models ?? [];
    return models
      .filter(model => model.slug && model.visibility !== 'hidden')
      .map(model => ({
        id: String(model.slug),
        modelName: String(model.slug),
        label: String(model.display_name ?? model.slug),
        contextWindow: model.context_window,
        description: model.description,
      }));
  } catch {
    return [];
  }
}

function readClaudeKnownModels(): Array<Pick<ModelInfo, 'modelName' | 'label' | 'description'> & { id: string }> {
  const base = [
    { id: 'claude-sonnet-4-6', modelName: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Balanced implementation model.' },
    { id: 'claude-haiku-4-5', modelName: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'Fast low-cost Claude model.' },
    { id: 'claude-opus-4-6', modelName: 'claude-opus-4-6', label: 'Claude Opus 4.6', description: 'High-end architecture and planning.' },
    { id: 'opus', modelName: 'opus', label: 'Claude alias: opus', description: 'Claude Code alias mapped by the local CLI.' },
    { id: 'sonnet', modelName: 'sonnet', label: 'Claude alias: sonnet', description: 'Claude Code alias mapped by the local CLI.' },
    { id: 'haiku', modelName: 'haiku', label: 'Claude alias: haiku', description: 'Claude Code alias mapped by the local CLI.' },
  ];

  const customModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
  if (customModel) {
    base.push({
      id: customModel,
      modelName: customModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME || `Claude custom: ${customModel}`,
      description: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION || 'Custom Claude model configured via environment.',
    });
  }

  return base;
}

function detectCustomCli(customCli: CustomCliConfig): CliInfo | null {
  if (!customCli.path || !fs.existsSync(customCli.path)) return null;
  return {
    id: customCli.id,
    label: customCli.label,
    path: customCli.path,
    source: 'system',
  };
}

function customModelToModelInfo(model: CustomModelConfig): ModelInfo {
  return {
    id: makeModelId('cli', model.cliId, model.modelName ?? model.id),
    modelName: model.modelName ?? model.id,
    label: model.label,
    providerId: model.cliId,
    providerLabel: model.cliId,
    source: 'cli',
    sourceLabel: `Local CLI · ${model.cliId}`,
    cliId: model.cliId,
    contextWindow: model.contextWindow,
    launchArgs: model.launchArgs,
    env: model.env,
    description: model.description,
    discovery: 'manual',
    tokenAccounting: 'estimated',
  };
}

function upsertCli(target: CliInfo[], cli: CliInfo): void {
  if (!target.find(item => item.id === cli.id)) target.push(cli);
}

function upsertModel(target: ModelInfo[], model: ModelInfo): void {
  const existing = target.find(item => item.id === model.id);
  if (!existing) {
    target.push(model);
    return;
  }
  Object.assign(existing, {
    ...existing,
    ...model,
    launchArgs: model.launchArgs ?? existing.launchArgs,
    env: model.env ?? existing.env,
    pricing: model.pricing ?? existing.pricing,
  });
}

function sortModels(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((left, right) => {
    const sourceOrder = sourcePriority(left.source) - sourcePriority(right.source);
    if (sourceOrder !== 0) return sourceOrder;
    const providerOrder = left.sourceLabel.localeCompare(right.sourceLabel);
    if (providerOrder !== 0) return providerOrder;
    return left.label.localeCompare(right.label);
  });
}

function extractPricing(item: Record<string, unknown>): ModelPricing | undefined {
  const pricing = item.pricing;
  if (!pricing || typeof pricing !== 'object') return undefined;
  const raw = pricing as Record<string, unknown>;
  const inputPerToken = parseNumericString(raw.prompt ?? raw.input ?? raw.input_cost);
  const outputPerToken = parseNumericString(raw.completion ?? raw.output ?? raw.output_cost);
  const cachedPerToken = parseNumericString(raw.cached_prompt ?? raw.cached_input);

  if (inputPerToken === undefined && outputPerToken === undefined && cachedPerToken === undefined) return undefined;
  return {
    inputPer1MTokensUsd: inputPerToken === undefined ? undefined : inputPerToken * 1_000_000,
    outputPer1MTokensUsd: outputPerToken === undefined ? undefined : outputPerToken * 1_000_000,
    cachedInputPer1MTokensUsd: cachedPerToken === undefined ? undefined : cachedPerToken * 1_000_000,
  };
}

function buildApiHeaders(provider: ResolvedApiProviderSettings): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...provider.extraHeaders,
  };

  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  if (provider.id === 'anthropic') {
    delete headers.Authorization;
    headers['x-api-key'] = provider.apiKey ?? '';
    headers['anthropic-version'] = '2023-06-01';
  }
  if (provider.id === 'openrouter') {
    headers['HTTP-Referer'] = headers['HTTP-Referer'] ?? 'https://github.com/agentic-flow';
    headers['X-Title'] = headers['X-Title'] ?? 'Agentic Flow';
  }

  return headers;
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

function isLikelyChatModel(modelName: string): boolean {
  const name = modelName.toLowerCase();
  return !(
    name.includes('embedding')
    || name.includes('embed-')
    || name.includes('whisper')
    || name.includes('tts')
    || name.includes('transcri')
    || name.includes('moderation')
    || name.includes('dall-e')
    || name.includes('gpt-image')
    || name.includes('imagegen')
  );
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseNumericString(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function humanizeAnthropicModelName(modelName: string): string {
  const trimmed = modelName.trim();
  if (!trimmed) return modelName;

  const withoutPrefix = trimmed.replace(/^claude-/, '');
  const parts = withoutPrefix.split('-');
  const family = parts[0] ? capitalize(parts[0]) : 'Claude';
  const versionParts: string[] = [];

  for (let index = 1; index < parts.length; index++) {
    const part = parts[index];
    if (/^\d+$/.test(part) && parts[index + 1] && /^\d+$/.test(parts[index + 1])) {
      versionParts.push(`${part}.${parts[index + 1]}`);
      index += 1;
      continue;
    }
    if (/^\d{8}$/.test(part)) break;
    if (part === 'latest') break;
    versionParts.push(part);
  }

  const version = versionParts
    .map(part => /^\d+\.\d+$/.test(part) ? part : capitalize(part))
    .join(' ')
    .trim();

  return version ? `Claude ${family} ${version}` : `Claude ${family}`;
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
