import * as vscode from 'vscode';
import type { ApiProviderId } from './types';

let secretStorage: vscode.SecretStorage | undefined;

const SECRET_PREFIX = 'agenticFlow.apiKey';

export function initializeSecretStorage(ctx: vscode.ExtensionContext): void {
  secretStorage = ctx.secrets;
}

export async function getProviderApiKeySecret(providerId: ApiProviderId): Promise<string | undefined> {
  if (!secretStorage) return undefined;
  const value = await secretStorage.get(secretKey(providerId));
  return value?.trim() || undefined;
}

export async function setProviderApiKeySecret(providerId: ApiProviderId, value: string): Promise<void> {
  if (!secretStorage) throw new Error('Secret storage not initialised.');
  await secretStorage.store(secretKey(providerId), value.trim());
}

export async function deleteProviderApiKeySecret(providerId: ApiProviderId): Promise<void> {
  if (!secretStorage) throw new Error('Secret storage not initialised.');
  await secretStorage.delete(secretKey(providerId));
}

function secretKey(providerId: ApiProviderId): string {
  return `${SECRET_PREFIX}.${providerId}`;
}
