import * as vscode from 'vscode';
import { loadConfig, resolveRuntimeEnv } from './configManager';
import { getProviderApiKeySecret } from './secretStorage';
import type {
  ApiProviderId,
  ApiProviderSettings,
  ModelPricing,
  ResolvedApiProviderSettings,
} from './types';

interface ProviderDefinition {
  id: ApiProviderId;
  label: string;
  defaultBaseUrl: string;
  apiKeyEnv?: string;
  defaultModels: Array<{
    id: string;
    label: string;
    description?: string;
    contextWindow?: number;
    pricing?: ModelPricing;
  }>;
}

const PROVIDER_DEFINITIONS: Record<ApiProviderId, ProviderDefinition> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModels: [
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
    ],
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    defaultModels: [
      { id: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1', contextWindow: 200_000 },
      { id: 'claude-opus-4-20250514', label: 'Claude Opus 4', contextWindow: 200_000 },
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', contextWindow: 200_000 },
      { id: 'claude-3-7-sonnet-20250219', label: 'Claude Sonnet 3.7', contextWindow: 200_000 },
      { id: 'claude-3-5-haiku-20241022', label: 'Claude Haiku 3.5', contextWindow: 200_000 },
    ],
  },
  xai: {
    id: 'xai',
    label: 'xAI',
    defaultBaseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    defaultModels: [
      { id: 'grok-4', label: 'Grok 4' },
      { id: 'grok-3-mini', label: 'Grok 3 Mini' },
      { id: 'grok-3', label: 'Grok 3' },
    ],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    defaultModels: [],
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultModels: [],
  },
};

export function getProviderDefinitions(): Record<ApiProviderId, ProviderDefinition> {
  return PROVIDER_DEFINITIONS;
}

export async function getConfiguredApiProviders(): Promise<Record<ApiProviderId, ResolvedApiProviderSettings>> {
  const settings = vscode.workspace.getConfiguration('agenticFlow').get<Record<string, ApiProviderSettings>>('apiProviders', {});
  const runtimeEnv = resolveRuntimeEnv(loadConfig());
  const secretEntries = await Promise.all(
    Object.values(PROVIDER_DEFINITIONS).map(async definition => [definition.id, await getProviderApiKeySecret(definition.id)] as const),
  );
  const secretMap = new Map(secretEntries);

  return Object.values(PROVIDER_DEFINITIONS).reduce((acc, definition) => {
    const raw = settings?.[definition.id] ?? {};
    const secretApiKey = secretMap.get(definition.id);
    const envApiKey = definition.apiKeyEnv ? runtimeEnv[definition.apiKeyEnv] : undefined;
    const apiKey = secretApiKey || raw.apiKey?.trim() || envApiKey;
    const apiKeySource: ResolvedApiProviderSettings['apiKeySource'] =
      secretApiKey ? 'secret' : raw.apiKey?.trim() ? 'settings' : envApiKey ? 'env' : 'none';
    const enabled = definition.id === 'ollama'
      ? Boolean(raw.enabled)
      : Boolean(apiKey) || raw.enabled === true;

    acc[definition.id] = {
      id: definition.id,
      label: definition.label,
      enabled,
      apiKey,
      baseUrl: sanitizeBaseUrl(raw.baseUrl || runtimeEnv[providerBaseUrlEnv(definition.id)] || definition.defaultBaseUrl),
      modelAllowList: Array.isArray(raw.modelAllowList) ? raw.modelAllowList.filter(Boolean) : [],
      extraHeaders: sanitizeHeaders(raw.extraHeaders),
      apiKeySource,
    };

    return acc;
  }, {} as Record<ApiProviderId, ResolvedApiProviderSettings>);
}

export function providerRequiresApiKey(providerId: ApiProviderId): boolean {
  return providerId !== 'ollama';
}

export function providerDefaultModels(providerId: ApiProviderId): ProviderDefinition['defaultModels'] {
  return PROVIDER_DEFINITIONS[providerId].defaultModels;
}

function sanitizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function sanitizeHeaders(value: ApiProviderSettings['extraHeaders']): Record<string, string> {
  if (!value) return {};
  return Object.entries(value).reduce((acc, [key, raw]) => {
    const name = key.trim();
    const headerValue = String(raw ?? '').trim();
    if (name && headerValue) acc[name] = headerValue;
    return acc;
  }, {} as Record<string, string>);
}

function providerBaseUrlEnv(providerId: ApiProviderId): string {
  switch (providerId) {
    case 'openai':
      return 'OPENAI_BASE_URL';
    case 'anthropic':
      return 'ANTHROPIC_BASE_URL';
    case 'xai':
      return 'XAI_BASE_URL';
    case 'openrouter':
      return 'OPENROUTER_BASE_URL';
    case 'ollama':
      return 'OLLAMA_BASE_URL';
  }
}
