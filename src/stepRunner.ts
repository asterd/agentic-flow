import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { getConfiguredApiProviders } from './providerConfig';
import type { CliInfo, ModelInfo, TokenUsage } from './types';

function buildCliArgs(cli: CliInfo, modelName: string): string[] {
  switch (cli.id) {
    case 'claude':
      return ['--model', modelName, '--print', '--output-format', 'text'];
    case 'codex':
      return ['exec', '--full-auto', '--skip-git-repo-check', '-m', modelName, '-'];
    case 'continue':
      return [];
    case 'copilot':
      return ['copilot', 'explain', '--model', modelName];
    default:
      return ['--model', modelName];
  }
}

async function runViaVSCodeLM(
  modelName: string,
  prompt: string,
  onChunk: (chunk: string) => void,
  cancelToken: vscode.CancellationToken,
): Promise<string> {
  const [model] = await vscode.lm.selectChatModels({ id: modelName });
  if (!model) throw new Error(`VS Code LM model not found: ${modelName}`);

  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  const response = await model.sendRequest(messages, {}, cancelToken);
  let output = '';
  for await (const chunk of response.text) {
    output += chunk;
    onChunk(chunk);
  }
  return output;
}

export interface StepRunResult {
  output: string;
  exitCode: number;
  stderr: string;
  durationMs: number;
  promptTokens: number;
  outputTokens: number;
  tokenUsage?: TokenUsage;
}

export async function runStep(opts: {
  cli?: CliInfo;
  model: ModelInfo;
  prompt: string;
  workspaceRoot: string;
  onChunk: (chunk: string) => void;
  cancellationToken?: vscode.CancellationToken;
  env?: Record<string, string>;
}): Promise<StepRunResult> {
  const { cli, model, prompt, workspaceRoot, onChunk, cancellationToken, env } = opts;
  const start = Date.now();
  const promptTokens = estimateTokens(prompt);

  if (model.source === 'vscode') {
    const ct = cancellationToken ?? new vscode.CancellationTokenSource().token;
    const output = await runViaVSCodeLM(model.modelName, prompt, onChunk, ct);
    return {
      output,
      exitCode: 0,
      stderr: '',
      durationMs: Date.now() - start,
      promptTokens,
      outputTokens: estimateTokens(output),
      tokenUsage: {
        inputTokens: promptTokens,
        outputTokens: estimateTokens(output),
        totalTokens: promptTokens + estimateTokens(output),
        accounting: 'estimated',
      },
    };
  }

  if (model.source === 'api') {
    const apiResult = await runViaApi(model, prompt, onChunk, cancellationToken, env);
    return {
      ...apiResult,
      durationMs: Date.now() - start,
      promptTokens: apiResult.tokenUsage?.inputTokens ?? promptTokens,
      outputTokens: apiResult.tokenUsage?.outputTokens ?? estimateTokens(apiResult.output),
    };
  }

  if (!cli) throw new Error(`No CLI available for model "${model.label}".`);
  const args = [...(model.launchArgs ?? []), ...buildCliArgs(cli, model.modelName)];

  return await new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const stderrChunks: string[] = [];
    const proc = spawn(cli.path, args, {
      cwd: workspaceRoot,
      env: { ...process.env, ...(model.env ?? {}), ...(env ?? {}) },
      shell: process.platform === 'win32',
    });

    proc.stdin.on('error', () => {});
    proc.stdin.end(prompt, 'utf8');

    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      chunks.push(text);
      onChunk(text);
    });

    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderrChunks.push(text);
      onChunk(`[stderr] ${text}`);
    });

    cancellationToken?.onCancellationRequested(() => {
      proc.kill('SIGTERM');
      reject(new Error('Cancelled'));
    });

    proc.on('close', (code: number | null) => {
      const raw = chunks.join('');
      const output = cli.id === 'codex' ? extractCodexOutput(raw) : raw;
      const stderr = stderrChunks.join('').trim();
      const outputTokens = estimateTokens(output);
      resolve({
        output,
        exitCode: code ?? 0,
        stderr,
        durationMs: Date.now() - start,
        promptTokens,
        outputTokens,
        tokenUsage: {
          inputTokens: promptTokens,
          outputTokens,
          totalTokens: promptTokens + outputTokens,
          accounting: 'estimated',
        },
      });
    });

    proc.on('error', (err: Error) => {
      reject(err);
    });
  });
}

async function runViaApi(
  model: ModelInfo,
  prompt: string,
  onChunk: (chunk: string) => void,
  cancellationToken?: vscode.CancellationToken,
  env?: Record<string, string>,
): Promise<Omit<StepRunResult, 'durationMs' | 'promptTokens' | 'outputTokens'>> {
  const providerId = model.apiProviderId;
  if (!providerId) throw new Error(`Model "${model.label}" is missing API provider configuration.`);

  const provider = (await getConfiguredApiProviders())[providerId];
  if (!provider?.enabled) throw new Error(`API provider "${providerId}" is disabled in settings.`);

  const controller = createAbortController(90_000, cancellationToken);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(provider.extraHeaders ?? {}),
  };

  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  if (providerId === 'anthropic') {
    delete headers.Authorization;
    headers['x-api-key'] = provider.apiKey ?? '';
    headers['anthropic-version'] = '2023-06-01';
  }
  if (providerId === 'openrouter') {
    headers['HTTP-Referer'] = headers['HTTP-Referer'] ?? 'https://github.com/agentic-flow';
    headers['X-Title'] = headers['X-Title'] ?? 'Agentic Flow';
  }

  const mergedEnv = Object.entries({ ...process.env, ...(model.env ?? {}), ...(env ?? {}) }).reduce((acc, [key, value]) => {
    if (typeof value === 'string') acc[key] = value;
    return acc;
  }, {} as Record<string, string>);
  const requestHeaders = substituteHeaderEnv(headers, mergedEnv);

  const response = providerId === 'anthropic'
    ? await fetchAnthropicCompletion(provider.baseUrl, model.modelName, prompt, requestHeaders, controller.signal)
    : await fetchOpenAiCompatibleCompletion(provider.baseUrl, model.modelName, prompt, requestHeaders, controller.signal);

  onChunk(response.output);
  return {
    output: response.output,
    exitCode: 0,
    stderr: '',
    tokenUsage: estimateCost(response.tokenUsage, model),
  };
}

async function fetchOpenAiCompatibleCompletion(
  baseUrl: string,
  modelName: string,
  prompt: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ output: string; tokenUsage?: TokenUsage }> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const json = await response.json() as Record<string, unknown>;
  return {
    output: extractOpenAiText(json),
    tokenUsage: extractOpenAiUsage(json),
  };
}

async function fetchAnthropicCompletion(
  baseUrl: string,
  modelName: string,
  prompt: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ output: string; tokenUsage?: TokenUsage }> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/messages`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: modelName,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const json = await response.json() as Record<string, unknown>;
  return {
    output: extractAnthropicText(json),
    tokenUsage: extractAnthropicUsage(json),
  };
}

function estimateCost(tokenUsage: TokenUsage | undefined, model: ModelInfo): TokenUsage | undefined {
  if (!tokenUsage) return tokenUsage;
  if (!model.pricing) return tokenUsage;

  const inputCost = ((tokenUsage.inputTokens ?? 0) / 1_000_000) * (model.pricing.inputPer1MTokensUsd ?? 0);
  const outputCost = ((tokenUsage.outputTokens ?? 0) / 1_000_000) * (model.pricing.outputPer1MTokensUsd ?? 0);
  const cachedCost = ((tokenUsage.cachedInputTokens ?? 0) / 1_000_000) * (model.pricing.cachedInputPer1MTokensUsd ?? 0);

  return {
    ...tokenUsage,
    costUsd: roundUsd(inputCost + outputCost + cachedCost),
  };
}

function extractOpenAiText(json: Record<string, unknown>): string {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;

  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(item => typeof item === 'string' ? item : typeof item === 'object' && item && 'text' in item ? String((item as Record<string, unknown>).text ?? '') : '')
      .join('\n')
      .trim();
  }

  return '';
}

function extractAnthropicText(json: Record<string, unknown>): string {
  const blocks = Array.isArray(json.content) ? json.content : [];
  return blocks
    .map(block => typeof block === 'object' && block && 'text' in block ? String((block as Record<string, unknown>).text ?? '') : '')
    .join('\n')
    .trim();
}

function extractOpenAiUsage(json: Record<string, unknown>): TokenUsage | undefined {
  const usage = json.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const raw = usage as Record<string, unknown>;
  const promptDetails = asRecord(raw.prompt_tokens_details ?? raw.input_tokens_details);
  const completionDetails = asRecord(raw.completion_tokens_details ?? raw.output_tokens_details);

  return {
    inputTokens: numberOrUndefined(raw.prompt_tokens ?? raw.input_tokens),
    outputTokens: numberOrUndefined(raw.completion_tokens ?? raw.output_tokens),
    totalTokens: numberOrUndefined(raw.total_tokens),
    reasoningTokens: numberOrUndefined(completionDetails?.reasoning_tokens),
    cachedInputTokens: numberOrUndefined(promptDetails?.cached_tokens),
    accounting: 'reported',
  };
}

function extractAnthropicUsage(json: Record<string, unknown>): TokenUsage | undefined {
  const usage = asRecord(json.usage);
  if (!usage) return undefined;
  const inputTokens = numberOrUndefined(usage.input_tokens);
  const outputTokens = numberOrUndefined(usage.output_tokens);
  const cacheRead = numberOrUndefined(usage.cache_read_input_tokens);
  const cacheCreation = numberOrUndefined(usage.cache_creation_input_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: sumNumbers(inputTokens, outputTokens),
    cachedInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    accounting: 'reported',
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractCodexOutput(raw: string): string {
  const match = raw.match(/^codex\n([\s\S]*?)\ntokens used/m);
  if (match) return match[1].trim();
  const parts = raw.split('--------\n');
  if (parts.length >= 3) return parts.slice(2).join('--------\n').trim();
  return raw.trim();
}

async function readApiError(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return `API error ${response.status}: ${body || response.statusText}`;
  } catch {
    return `API error ${response.status}: ${response.statusText}`;
  }
}

function substituteHeaderEnv(headers: Record<string, string>, env: Record<string, string>): Record<string, string> {
  return Object.entries(headers).reduce((acc, [key, value]) => {
    acc[key] = value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => env[name] ?? '');
    return acc;
  }, {} as Record<string, string>);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sumNumbers(...values: Array<number | undefined>): number | undefined {
  if (!values.some(value => value !== undefined)) return undefined;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function roundUsd(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function createAbortController(timeoutMs: number, cancellationToken?: vscode.CancellationToken): AbortController {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  controller.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
  cancellationToken?.onCancellationRequested(() => controller.abort());
  return controller;
}
