// ─────────────────────────────────────────────────────────────
// extension.ts  –  VS Code Extension entry point
// ─────────────────────────────────────────────────────────────
import * as vscode from 'vscode';
import { detectEnvironment } from './cliDetector';
import { getAgenticFlowDir, getRuntimeEnvPath, getSkillsDir, getStorageDirSetting, initWorkspace, loadSessionState } from './configManager';
import { writeRepoMd } from './repoSummaryWriter';
import { getProviderDefinitions } from './providerConfig';
import { deleteProviderApiKeySecret, initializeSecretStorage, setProviderApiKeySecret } from './secretStorage';
import { WorkflowEngine } from './workflowEngine';
import { AgenticFlowSidebarProvider } from './webviewProvider';
import { AgenticFlowDocsPanel } from './docsProvider';
import type { ApiProviderId, CliInfo, ModelInfo } from './types';

let _clis: CliInfo[] = [];
let _models: ModelInfo[] = [];
let _engine: WorkflowEngine | undefined;

export async function activate(ctx: vscode.ExtensionContext) {
  initializeSecretStorage(ctx);

  // Register sidebar WebviewView provider (activity bar panel)
  const sidebarProvider = new AgenticFlowSidebarProvider(ctx.extensionUri, () => ({
    engine: _engine,
    models: _models,
    clis: _clis,
  }));

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agenticFlow.panel', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('agenticFlow.open', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showErrorMessage('[Agentic Flow] Open a workspace first.');
        return;
      }
      await initWorkspace(_models[0]?.id);
      ensureEngine(root);
      // Focus the sidebar view
      vscode.commands.executeCommand('agenticFlow.panel.focus');
    }),

    vscode.commands.registerCommand('agenticFlow.refreshModels', async () => {
      await refreshEnvironment();
      sidebarProvider.refresh(_engine, _models, _clis);
      vscode.window.showInformationMessage(
        `[Agentic Flow] Detected ${_clis.length} CLI(s), ${_models.length} model(s).`,
      );
    }),

    vscode.commands.registerCommand('agenticFlow.initWorkspace', async () => {
      await initWorkspace(_models[0]?.id);
      vscode.window.showInformationMessage('[Agentic Flow] Workspace initialised – check .agentic-flow/');
    }),

    vscode.commands.registerCommand('agenticFlow.openSettings', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:agentic-flow.agentic-flow agenticFlow',
      );
    }),

    vscode.commands.registerCommand('agenticFlow.openWorkspaceConfig', async () => {
      await initWorkspace(_models[0]?.id);
      const dir = getAgenticFlowDir();
      if (!dir) {
        vscode.window.showErrorMessage('[Agentic Flow] Open a workspace first.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.Uri.file(dir), 'config.json'));
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('agenticFlow.openRuntimeEnv', async () => {
      await initWorkspace(_models[0]?.id);
      const runtimeEnvPath = getRuntimeEnvPath();
      if (!runtimeEnvPath) {
        vscode.window.showErrorMessage('[Agentic Flow] Open a workspace first.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument(runtimeEnvPath);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('agenticFlow.revealSkillsFolder', async () => {
      await initWorkspace(_models[0]?.id);
      const skillsDir = getSkillsDir();
      if (!skillsDir) {
        vscode.window.showErrorMessage('[Agentic Flow] Open a workspace first.');
        return;
      }
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(skillsDir));
    }),

    vscode.commands.registerCommand('agenticFlow.setProviderApiKey', async () => {
      const providerId = await pickProvider('Store API key for which provider?');
      if (!providerId) return;
      const label = getProviderDefinitions()[providerId].label;
      const value = await vscode.window.showInputBox({
        title: `Agentic Flow: ${label} API key`,
        password: true,
        ignoreFocusOut: true,
        prompt: `Store the ${label} API key in VS Code secret storage`,
      });
      if (!value?.trim()) return;
      await setProviderApiKeySecret(providerId, value);
      await refreshEnvironment();
      sidebarProvider.refresh(_engine, _models, _clis);
      vscode.window.showInformationMessage(`[Agentic Flow] Stored ${label} API key in secret storage.`);
    }),

    vscode.commands.registerCommand('agenticFlow.openDocs', () => {
      AgenticFlowDocsPanel.createOrShow(ctx.extensionUri);
    }),

    vscode.commands.registerCommand('agenticFlow.generateRepoMd', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { vscode.window.showErrorMessage('[Agentic Flow] Open a workspace first.'); return; }
      const session = loadSessionState();
      if (!session) { vscode.window.showErrorMessage('[Agentic Flow] No session found. Run the pipeline first.'); return; }
      const afDir = getAgenticFlowDir();
      if (!afDir) return;
      const filePath = writeRepoMd(session, afDir);
      if (!filePath) { vscode.window.showErrorMessage('[Agentic Flow] Could not write REPO.md.'); return; }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('agenticFlow.clearProviderApiKey', async () => {
      const providerId = await pickProvider('Clear API key for which provider?');
      if (!providerId) return;
      const label = getProviderDefinitions()[providerId].label;
      await deleteProviderApiKeySecret(providerId);
      await refreshEnvironment();
      sidebarProvider.refresh(_engine, _models, _clis);
      vscode.window.showInformationMessage(`[Agentic Flow] Cleared ${label} API key from secret storage.`);
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${getStorageDirSetting()}/config.json`);
  watcher.onDidChange(() => {
    vscode.commands.executeCommand('agenticFlow.refreshModels');
  });
  ctx.subscriptions.push(watcher);

  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('agenticFlow')) return;
    void refreshEnvironment().then(() => {
      sidebarProvider.refresh(_engine, _models, _clis);
    });
  }));

  void refreshEnvironment().then(() => {
    sidebarProvider.refresh(_engine, _models, _clis);
  }, err => {
    console.error('[Agentic Flow] Environment refresh failed during activation.', err);
  });
}

export function deactivate() {}

async function refreshEnvironment() {
  const env = await detectEnvironment();
  _clis = env.clis;
  _models = env.models;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) ensureEngine(root);
}

function ensureEngine(workspaceRoot: string) {
  if (!_engine) {
    _engine = new WorkflowEngine(_models, _clis, workspaceRoot);
    return;
  }
  _engine.setEnvironment(_models, _clis);
}

async function pickProvider(placeHolder: string): Promise<ApiProviderId | undefined> {
  const items = Object.values(getProviderDefinitions()).map(provider => ({
    label: provider.label,
    description: provider.id,
    providerId: provider.id,
  }));
  const selection = await vscode.window.showQuickPick(items, { placeHolder, ignoreFocusOut: true });
  return selection?.providerId;
}
