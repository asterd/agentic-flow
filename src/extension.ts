// ─────────────────────────────────────────────────────────────
// extension.ts  –  VS Code Extension entry point
// ─────────────────────────────────────────────────────────────
import * as vscode from 'vscode';
import { detectEnvironment } from './cliDetector';
import { getAgenticFlowDir, getRuntimeEnvPath, getSkillsDir, getStorageDirSetting, initWorkspace } from './configManager';
import { WorkflowEngine } from './workflowEngine';
import { AgenticFlowSidebarProvider } from './webviewProvider';
import type { CliInfo, ModelInfo } from './types';

let _clis: CliInfo[] = [];
let _models: ModelInfo[] = [];
let _engine: WorkflowEngine | undefined;

export async function activate(ctx: vscode.ExtensionContext) {
  await refreshEnvironment();

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
      sidebarProvider.refresh(_engine!, _models, _clis);
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
  );

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${getStorageDirSetting()}/config.json`);
  watcher.onDidChange(() => {
    vscode.commands.executeCommand('agenticFlow.refreshModels');
  });
  ctx.subscriptions.push(watcher);

  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('agenticFlow')) return;
    void refreshEnvironment().then(() => {
      if (_engine) sidebarProvider.refresh(_engine, _models, _clis);
    });
  }));
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
