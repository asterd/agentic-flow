// ─────────────────────────────────────────────────────────────
// webviewProvider.ts  –  VS Code WebviewPanel provider
// ─────────────────────────────────────────────────────────────
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgenticFlowConfig, CliInfo, ExtToWebMsg, MicroActionEntry, ModelInfo, WebToExtMsg } from './types';
import { RUN_PROFILE_PRESETS, ensureWorkspaceFile, getAgenticFlowDir, loadConfig, loadSessionState, resetLocalSettings, saveConfig, saveSessionState } from './configManager';
import { WorkflowEngine } from './workflowEngine';
import { resolveCliForModel, resolveModelSelection } from './cliDetector';
import { runStep } from './stepRunner';
import { getRepoMdPath } from './repoSummaryWriter';
import { randomUUID } from 'crypto';

// ── Sidebar WebviewView Provider (activity bar) ───────────────
export class AgenticFlowSidebarProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | undefined;
  private _engineDisposable: vscode.Disposable | undefined;
  private _engine: WorkflowEngine | undefined;
  private _models: ModelInfo[] = [];
  private _clis: CliInfo[] = [];
  private _microActionCancel: vscode.CancellationTokenSource | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _getContext: () => { engine: WorkflowEngine | undefined; models: ModelInfo[]; clis: CliInfo[] },
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this._view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };

    const cssUri = view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'panel.css'));
    view.webview.html = getWebviewHtml(cssUri.toString(), RUN_PROFILE_PRESETS);

    const ctx = this._getContext();
    this._engine = ctx.engine;
    this._models = ctx.models;
    this._clis = ctx.clis;

    this._bindEngine();

    view.webview.onDidReceiveMessage((msg: WebToExtMsg) => this._handleMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) this._sendInit();
    });
  }

  refresh(engine: WorkflowEngine | undefined, models: ModelInfo[], clis: CliInfo[]): void {
    this._engine = engine;
    this._models = models;
    this._clis = clis;
    this._bindEngine();
    if (this._view?.visible) this._sendInit();
  }

  private _bindEngine() {
    this._engineDisposable?.dispose();
    if (!this._engine) return;
    this._engineDisposable = this._engine.onEvent(event => {
      if (event.type === 'stateChange') {
        this._post({ type: 'runState', state: event.state });
      } else if (event.type === 'stepLog') {
        this._post({ type: 'stepLog', stepId: event.stepId, chunk: event.chunk });
      } else if (event.type === 'sessionUpdated') {
        this._post({ type: 'sessionUpdated', session: event.session });
      } else if (event.type === 'finished') {
        this._post({ type: 'runState', state: event.state });
      }
    });
  }

  private _post(msg: ExtToWebMsg) {
    this._view?.webview.postMessage(msg).then(undefined, () => {});
  }

  private _sendInit() {
    const config = loadConfig();
    const session = this._engine?.currentSession ?? loadSessionState();
    this._post({ type: 'init', models: this._models, config, session, language: vscode.env.language });
    if (this._engine?.currentState) {
      this._post({ type: 'runState', state: this._engine.currentState });
    }
  }

  private async _handleMessage(msg: WebToExtMsg) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    switch (msg.type) {
      case 'ready':
        if (root) {
          const { initWorkspace } = await import('./configManager');
          await initWorkspace(this._models[0]?.id); // always ensure skills are present
          if (!this._engine) {
            const { WorkflowEngine: WE } = await import('./workflowEngine');
            this._engine = new WE(this._models, this._clis, root);
            this._bindEngine();
          }
        }
        this._sendInit();
        break;
      case 'startRun':
        if (!root) { this._post({ type: 'error', message: 'Open a workspace folder first.' }); return; }
        if (!this._engine) { this._post({ type: 'error', message: 'Engine not initialised.' }); return; }
        if (this._engine.isRunning) { this._post({ type: 'error', message: 'A run is already in progress.' }); return; }
        loadConfig(); // reload
        this._engine.start(msg.task, loadConfig(), msg.mode, msg.stepOverrides).catch(err => {
          this._post({ type: 'error', message: String(err.message ?? err) });
        });
        break;
      case 'cancelRun':
        this._engine?.cancel();
        break;
      case 'rerunStep':
        if (!root) { this._post({ type: 'error', message: 'Open a workspace folder first.' }); return; }
        if (!this._engine) { this._post({ type: 'error', message: 'Engine not initialised.' }); return; }
        if (this._engine.isRunning) { this._post({ type: 'error', message: 'A run is already in progress.' }); return; }
        this._engine.rerunStep(msg.stepId, loadConfig()).catch(err => {
          this._post({ type: 'error', message: String(err.message ?? err) });
        });
        break;
      case 'runMicroAction': {
        if (!root) { this._post({ type: 'microActionError', message: 'Open a workspace folder first.' }); return; }
        if (this._engine?.isRunning) { this._post({ type: 'microActionError', message: 'Stop the active pipeline run first.' }); return; }
        if (this._microActionCancel) { this._post({ type: 'microActionError', message: 'A micro-action is already running.' }); return; }

        const maModel = resolveModelSelection(msg.modelId, this._models);
        if (!maModel) { this._post({ type: 'microActionError', message: `Model "${msg.modelId}" not found.` }); return; }
        const maCli = resolveCliForModel(maModel, this._clis);

        let maPrompt = msg.prompt.trim();
        if (msg.includeContext) {
          const session = loadSessionState();
          const afDir = getAgenticFlowDir();
          const repoPath = afDir ? getRepoMdPath(afDir) : null;
          const repoContent = repoPath && fs.existsSync(repoPath)
            ? fs.readFileSync(repoPath, 'utf8').slice(0, 8000)
            : null;
          const sessionSummary = session
            ? `Session: ${session.title} | Iteration: ${session.iteration} | Last objective: ${session.currentObjective}`
            : null;
          const ctx: string[] = [];
          if (repoContent) ctx.push(`# PROJECT CONTEXT (REPO.md)\n\n${repoContent}`);
          if (sessionSummary) ctx.push(`# SESSION CONTEXT\n\n${sessionSummary}`);
          if (ctx.length) maPrompt = ctx.join('\n\n---\n\n') + '\n\n---\n\n# INSTRUCTION\n\n' + maPrompt;
        }

        this._microActionCancel = new vscode.CancellationTokenSource();
        const maStart = Date.now();
        const maConfig = loadConfig();

        runStep({
          cli: maCli,
          model: maModel,
          prompt: maPrompt,
          workspaceRoot: root,
          onChunk: chunk => this._post({ type: 'microActionChunk', chunk }),
          cancellationToken: this._microActionCancel.token,
          env: (await import('./configManager')).resolveRuntimeEnv(maConfig),
        }).then(result => {
          const entry: MicroActionEntry = {
            id: randomUUID(),
            prompt: msg.prompt,
            modelId: maModel.id,
            modelLabel: maModel.label,
            output: result.output,
            createdAt: maStart,
            durationMs: result.durationMs,
            tokensUsed: result.tokenUsage?.totalTokens,
            tokenUsage: result.tokenUsage,
          };
          // Persist to session
          const session = loadSessionState();
          if (session) {
            session.microActions = [...(session.microActions ?? []), entry].slice(-50);
            saveSessionState(session);
          }
          this._post({ type: 'microActionDone', entry });
        }).catch(err => {
          if (String(err.message ?? err) !== 'Cancelled') {
            this._post({ type: 'microActionError', message: String(err.message ?? err) });
          }
        }).finally(() => {
          this._microActionCancel?.dispose();
          this._microActionCancel = null;
        });
        break;
      }
      case 'cancelMicroAction':
        this._microActionCancel?.cancel();
        break;
      case 'openDocs':
        vscode.commands.executeCommand('agenticFlow.openDocs');
        break;
      case 'saveConfig':
        try {
          saveConfig(msg.config);
          this._post({ type: 'configSaved' });
          this._sendInit();
        } catch (err) {
          this._post({ type: 'error', message: String(err) });
        }
        break;
      case 'refreshModels':
        vscode.commands.executeCommand('agenticFlow.refreshModels');
        break;
      case 'openSettingsUi':
        vscode.commands.executeCommand('agenticFlow.openSettings');
        break;
      case 'newSession': {
        const { getSessionFilePath, getStateFilePath } = await import('./configManager');
        const sessionPath = getSessionFilePath();
        const statePath = getStateFilePath();
        if (sessionPath && fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
        if (statePath && fs.existsSync(statePath)) fs.unlinkSync(statePath);
        if (this._engine) this._engine.reloadSession();
        this._sendInit();
        this._post({ type: 'sessionUpdated', session: null });
        break;
      }
      case 'openSkillFile': {
        if (!msg.skillPath?.trim()) {
          this._post({ type: 'error', message: 'Enter a skill path first.' });
          return;
        }
        try {
          const abs = ensureWorkspaceFile(
            msg.skillPath.trim(),
            skillTemplateForPath(msg.skillPath),
          );
          const doc = await vscode.workspace.openTextDocument(abs);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
          this._post({ type: 'error', message: String(err instanceof Error ? err.message : err) });
        }
        break;
      }
      case 'resetLocalSettings':
        if (this._engine?.isRunning) {
          this._post({ type: 'error', message: 'Stop the current run before resetting local settings.' });
          return;
        }
        try {
          await resetLocalSettings(this._models[0]?.id);
          this._engine?.reloadSession();
          this._sendInit();
          this._post({ type: 'sessionUpdated', session: null });
        } catch (err) {
          this._post({ type: 'error', message: String(err instanceof Error ? err.message : err) });
        }
        break;
    }
  }
}

export class AgenticFlowPanel {
  public static currentPanel: AgenticFlowPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _engineDisposable: vscode.Disposable | undefined;
  private _engine: WorkflowEngine;
  private _models: ModelInfo[];
  private _config: AgenticFlowConfig;

  static createOrShow(
    extensionUri: vscode.Uri,
    engine: WorkflowEngine,
    models: ModelInfo[],
    clis: CliInfo[],
  ): AgenticFlowPanel {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

    if (AgenticFlowPanel.currentPanel) {
      AgenticFlowPanel.currentPanel._panel.reveal(column);
      AgenticFlowPanel.currentPanel.updateContext(engine, models, clis);
      return AgenticFlowPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'agenticFlow',
      'Agentic Flow',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );

    AgenticFlowPanel.currentPanel = new AgenticFlowPanel(panel, extensionUri, engine, models);
    return AgenticFlowPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    engine: WorkflowEngine,
    models: ModelInfo[],
  ) {
    this._panel = panel;
    this._engine = engine;
    this._models = models;
    this._config = loadConfig();

    const cssUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.css'));
    this._panel.webview.html = getWebviewHtml(cssUri.toString(), RUN_PROFILE_PRESETS);

    this.bindEngine();

    this._panel.webview.onDidReceiveMessage(
      (msg: WebToExtMsg) => this._handleMessage(msg),
      null,
      this._disposables,
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  private updateContext(engine: WorkflowEngine, models: ModelInfo[], clis: CliInfo[]) {
    this._engine = engine;
    this._models = models;
    void clis;
    this.bindEngine();
    this._sendInit();
  }

  private bindEngine() {
    this._engineDisposable?.dispose();
    this._engineDisposable = this._engine.onEvent(event => {
      if (event.type === 'stateChange') {
        this._post({ type: 'runState', state: event.state });
      } else if (event.type === 'stepLog') {
        this._post({ type: 'stepLog', stepId: event.stepId, chunk: event.chunk });
      } else if (event.type === 'sessionUpdated') {
        this._post({ type: 'sessionUpdated', session: event.session });
      } else if (event.type === 'finished') {
        this._post({ type: 'runState', state: event.state });
      }
    });
  }

  private _post(msg: ExtToWebMsg) {
    this._panel.webview.postMessage(msg).then(undefined, () => {});
  }

  private _sendInit() {
    this._config = loadConfig();
    const session = this._engine.currentSession ?? loadSessionState();
    this._post({ type: 'init', models: this._models, config: this._config, session, language: vscode.env.language });
    if (this._engine.currentState) {
      this._post({ type: 'runState', state: this._engine.currentState });
    }
  }

  private async _handleMessage(msg: WebToExtMsg) {
    switch (msg.type) {
      case 'ready':
        this._sendInit();
        break;
      case 'startRun':
        if (this._engine.isRunning) {
          this._post({ type: 'error', message: 'A run is already in progress.' });
          return;
        }
        this._config = loadConfig();
        this._engine.start(msg.task, this._config, msg.mode, msg.stepOverrides).catch(err => {
          this._post({ type: 'error', message: String(err.message ?? err) });
        });
        break;
      case 'cancelRun':
        this._engine.cancel();
        break;
      case 'openDocs':
        vscode.commands.executeCommand('agenticFlow.openDocs');
        break;
      case 'rerunStep':
        if (this._engine.isRunning) {
          this._post({ type: 'error', message: 'A run is already in progress.' });
          return;
        }
        this._config = loadConfig();
        this._engine.rerunStep(msg.stepId, this._config).catch(err => {
          this._post({ type: 'error', message: String(err.message ?? err) });
        });
        break;
      case 'saveConfig':
        try {
          saveConfig(msg.config);
          this._config = msg.config;
          this._post({ type: 'configSaved' });
          this._sendInit();
        } catch (err) {
          this._post({ type: 'error', message: String(err) });
        }
        break;
      case 'refreshModels':
        vscode.commands.executeCommand('agenticFlow.refreshModels');
        break;
      case 'openSettingsUi':
        vscode.commands.executeCommand('agenticFlow.openSettings');
        break;
      case 'newSession': {
        const { getSessionFilePath, getStateFilePath } = await import('./configManager');
        const sessionPath = getSessionFilePath();
        const statePath = getStateFilePath();
        if (sessionPath && fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
        if (statePath && fs.existsSync(statePath)) fs.unlinkSync(statePath);
        this._engine.reloadSession();
        this._sendInit();
        this._post({ type: 'sessionUpdated', session: null });
        break;
      }
      case 'openSkillFile':
        if (!msg.skillPath?.trim()) {
          this._post({ type: 'error', message: 'Enter a skill path first.' });
          return;
        }
        try {
          const abs = ensureWorkspaceFile(
            msg.skillPath.trim(),
            skillTemplateForPath(msg.skillPath),
          );
          const doc = await vscode.workspace.openTextDocument(abs);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
          this._post({ type: 'error', message: String(err instanceof Error ? err.message : err) });
        }
        break;
      case 'resetLocalSettings':
        if (this._engine.isRunning) {
          this._post({ type: 'error', message: 'Stop the current run before resetting local settings.' });
          return;
        }
        try {
          await resetLocalSettings(this._models[0]?.id);
          this._engine.reloadSession();
          this._sendInit();
          this._post({ type: 'sessionUpdated', session: null });
        } catch (err) {
          this._post({ type: 'error', message: String(err instanceof Error ? err.message : err) });
        }
        break;
    }
  }

  dispose() {
    AgenticFlowPanel.currentPanel = undefined;
    this._engineDisposable?.dispose();
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}

function skillTemplateForPath(skillPath: string): string {
  const base = path.basename(skillPath);
  return [
    `# Skill: ${base}`,
    '',
    'Describe the role, constraints, and expected output for this step.',
    '',
  ].join('\n');
}

function getWebviewHtml(
  cssUri: string,
  runProfiles: Record<string, { label: string; description: string; enabledStepIds: string[] }>,
): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agentic Flow</title>
<link rel="stylesheet" href="${cssUri}"/>
</head>
<body>
<div class="app">

  <!-- Header -->
  <div class="header">
    <div class="header-brand">
      <svg class="header-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 1.5L3 9h5l-1 5.5L13 7H8L9 1.5Z" fill="currentColor"/>
      </svg>
      <span class="header-title" data-i18n="appTitle">Agentic Flow</span>
    </div>
    <div class="header-actions">
      <button class="icon-btn" id="btnOpenDocs" data-i18n="btnDocs" data-i18n-attr="title" title="Help &amp; Documentation">?</button>
      <button class="icon-btn" id="btnMicroAction" data-i18n="btnQuickAction" data-i18n-attr="title" title="Quick Action — run a single instruction on any model">⚡</button>
      <button class="icon-btn" id="btnNewSession" data-i18n="btnNewSession" data-i18n-attr="title" title="New session (clears history)">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8Z"/></svg>
      </button>
      <button class="icon-btn" id="btnTogglePipelineConfig" title="Configure pipeline steps">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 2h13a.5.5 0 0 1 0 1h-13a.5.5 0 0 1 0-1zm0 4h13a.5.5 0 0 1 0 1h-13a.5.5 0 0 1 0-1zm0 4h13a.5.5 0 0 1 0 1h-13a.5.5 0 0 1 0-1z"/></svg>
      </button>
      <button class="icon-btn" id="btnRefreshModels" title="Refresh models &amp; CLIs">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 1 1 .908-.418A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>
      </button>
      <button class="icon-btn" id="btnOpenSettings" title="Open VS Code settings">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/><path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.47l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z"/></svg>
      </button>
    </div>
  </div>

  <!-- Session config overlay (slides from right, session-local) -->
  <div class="settings-overlay" id="sessionConfig">
    <div class="settings-header">
      <span class="settings-header-title" data-i18n="runConfigTitle">Run Configuration</span>
      <button class="icon-btn" id="btnCloseSessionConfig" title="Close">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8 2.146 2.854Z"/></svg>
      </button>
    </div>
    <div class="settings-body" id="scBody"></div>
    <div class="settings-footer" style="display:flex;gap:6px">
      <button class="btn-primary-full" id="btnApplySessionConfig" data-i18n="applyClose">Apply &amp; Close</button>
      <button class="btn-ghost" id="btnResetSessionConfig" style="white-space:nowrap;flex-shrink:0" data-i18n="reset">Reset</button>
    </div>
  </div>

  <!-- Session info strip -->
  <div class="session-strip" id="sessionStrip">
    <span class="session-title" id="sessionTitle"></span>
    <span class="session-iter" id="sessionIter"></span>
    <span class="session-meta" id="sessionMeta"></span>
  </div>

  <!-- No-models warning -->
  <div class="no-models-bar" id="noModelsBar" data-i18n="noModels">
    No models detected. Install a local CLI or configure API providers in VS Code Settings, then click ↺.
  </div>

  <!-- Chat feed -->
  <div class="chat" id="chat">
    <div class="welcome" id="welcome">
      <div class="welcome-icon">⚡</div>
      <div class="welcome-title" data-i18n="welcomeTitle">Agentic Flow</div>
      <div class="welcome-desc" data-i18n="welcomeDesc">Orchestrate AI agents through your full development pipeline. Describe a task below to start.</div>
    </div>
  </div>

  <!-- Input -->
  <div class="input-area">
    <div class="input-box">
      <textarea
        id="taskInput"
        class="chat-textarea"
        placeholder="Describe what to build or change…"
        rows="1"
      ></textarea>
      <div class="input-footer">
        <span class="input-hint" id="inputHint"></span>
        <div class="input-btns">
          <span class="input-key-hint" data-i18n="runShortcut">⌘↵ run</span>
          <button class="btn-stop" id="btnCancel" disabled data-i18n="btnStop">■ Stop</button>
          <button class="btn-sec" id="btnContinue" disabled data-i18n="btnContinue">Continue</button>
          <button class="btn-run" id="btnStart" data-i18n="btnRun">Run</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Micro-action overlay -->
  <div class="settings-overlay" id="microActionOverlay">
    <div class="settings-header">
      <span class="settings-header-title" data-i18n="quickActionTitle">⚡ Quick Action</span>
      <button class="icon-btn" id="btnCloseMicroAction" title="Close">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8 2.146 2.854Z"/></svg>
      </button>
    </div>
    <div class="settings-body" style="gap:10px">
      <div style="font-size:11px;color:var(--muted)" data-i18n="quickActionDesc">Run a single instruction on any model. No pipeline — direct output only.</div>
      <label class="cfg-field"><span data-i18n="maModel">Model</span>
        <select id="maModelSelect"></select>
      </label>
      <label class="cfg-field" style="flex-direction:row;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="maIncludeContext" checked/>
        <span style="font-size:12px" data-i18n="maIncludeContext">Include session context (REPO.md + last run summary)</span>
      </label>
      <label class="cfg-field"><span data-i18n="maInstruction">Instruction</span>
        <textarea id="maPrompt" rows="5" style="resize:vertical;min-height:80px"></textarea>
      </label>
      <div id="maResultWrap" style="display:none">
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px" id="maResultMeta"></div>
        <pre class="step-log" id="maResult" style="max-height:260px;overflow-y:auto;white-space:pre-wrap;word-break:break-word"></pre>
      </div>
    </div>
    <div class="settings-footer" style="display:flex;gap:6px">
      <button class="btn-primary-full" id="btnRunMicroAction" data-i18n="maRun">⚡ Run</button>
      <button class="btn-stop" id="btnCancelMicroAction" disabled style="white-space:nowrap;flex-shrink:0" data-i18n="maStop">■ Stop</button>
    </div>
  </div>

  <!-- Settings overlay -->
  <div class="settings-overlay" id="settingsOverlay">
    <div class="settings-header">
      <span class="settings-header-title" data-i18n="workspaceConfigTitle">Workspace Configuration</span>
      <button class="icon-btn" id="btnCloseSettings" title="Close">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8 2.146 2.854Z"/></svg>
      </button>
    </div>
    <div class="settings-body">
      <div class="settings-section">
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px">
          Persistent configuration now lives in the standard VS Code settings UI and in the workspace files under <code>.agentic-flow/</code>.
        </div>
        <button class="btn-ghost" id="btnOpenSettingsUi" style="margin-bottom:10px">Open VS Code Settings</button>
      </div>
      <div class="settings-section">
        <div class="settings-section-title" data-i18n="pipelineSteps">Pipeline steps</div>
        <div id="stepsConfig"></div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title" data-i18n="modelRouter">Model Router</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:8px" data-i18n="modelRouterHint">Assign models to step categories. Applied when a step has no explicit model set. Leave blank to use per-step models only.</div>
        <div id="modelRouterConfig"></div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title" data-i18n="gitContext">Git Context</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:8px" data-i18n="gitContextHint">Inject the current git diff into every step prompt. Automatically disabled when the workspace has no git repo.</div>
        <div id="gitContextConfig"></div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title" data-i18n="runtime">Runtime</div>
        <div class="runtime-section" id="runtimeConfig"></div>
      </div>
    </div>
    <div class="settings-footer" style="display:flex;gap:6px">
      <button class="btn-primary-full" id="btnSaveConfig" data-i18n="saveConfig">Save configuration</button>
      <button class="btn-ghost" id="btnResetLocalSettings" style="white-space:nowrap;flex-shrink:0" data-i18n="resetLocalSettings">Reset local settings</button>
    </div>
  </div>

</div>
<script>
const vscode = acquireVsCodeApi();
const runProfiles = ${JSON.stringify(runProfiles)};
let models = [], config = null, session = null, runState = null;
let sessionOverrides = {}; // { [stepId]: { enabled, model, skill } }
let sessionRunProfile = 'custom';
const stepLogs = {};

// ── i18n ──────────────────────────────────────────────────────
const LANGS = {
  en: {
    appTitle: 'Agentic Flow',
    btnNewSession: 'New session (clears history)',
    btnPipelineConfig: 'Configure pipeline steps',
    btnRefreshModels: 'Refresh models & CLIs',
    btnOpenSettings: 'Open VS Code settings',
    btnDocs: 'Help & Documentation',
    btnQuickAction: 'Quick Action — run a single instruction on any model',
    runConfigTitle: 'Run Configuration',
    runConfigHint: 'Applies to the next run only — does not change global config',
    runProfileLabel: 'Run profile for next execution',
    applyPreset: 'Apply preset to this run',
    applyClose: 'Apply & Close',
    reset: 'Reset',
    workspaceConfigTitle: 'Workspace Configuration',
    workspaceConfigHint: 'Persistent configuration now lives in the standard VS Code settings UI and in the workspace files under',
    openVsCodeSettings: 'Open VS Code Settings',
    pipelineSteps: 'Pipeline steps',
    modelRouter: 'Model Router',
    modelRouterHint: 'Assign models to step categories. Applied when a step has no explicit model set. Leave blank to use per-step models only.',
    gitContext: 'Git Context',
    gitContextHint: 'Inject the current git diff into every step prompt. Automatically disabled when the workspace has no git repo.',
    gitContextEnabled: 'Enable git context injection',
    gitContextMaxTokens: 'Max tokens for diff',
    gitContextCommits: 'Recent commits to include',
    runtime: 'Runtime',
    envFilesLabel: 'Env files (one per line)',
    envVarsLabel: 'Environment variables',
    addVariable: '+ Add variable',
    runProfile: 'Run profile',
    saveConfig: 'Save configuration',
    resetLocalSettings: 'Reset local settings',
    welcomeTitle: 'Agentic Flow',
    welcomeDesc: 'Orchestrate AI agents through your full development pipeline. Describe a task below to start.',
    noModels: 'No models detected. Install a local CLI or configure API providers in VS Code Settings, then click ↺.',
    noModelsHint: 'No models — install a CLI or add provider API keys in VS Code settings, then refresh',
    taskPlaceholder: 'Describe what to build or change…',
    runShortcut: '⌘↵ run',
    btnStop: '■ Stop',
    btnContinue: 'Continue',
    btnRun: 'Run',
    runCompleted: (done, meta) => \`✓ All \${done} step\${done !== 1 ? 's' : ''} completed successfully.\${meta}\`,
    runErrors: (errors, done, meta) => \`Completed with \${errors} error\${errors > 1 ? 's' : ''}. \${done} step\${done !== 1 ? 's' : ''} succeeded.\${meta}\`,
    runCancelled: meta => \`Run cancelled.\${meta}\`,
    customProfileDesc: 'Custom keeps the current per-run step overrides as-is.',
    customProfileDescSettings: 'Custom keeps the current enabled/disabled step toggles as-is.',
    // Micro-action overlay
    quickActionTitle: '⚡ Quick Action',
    quickActionDesc: 'Run a single instruction on any model. No pipeline — direct output only.',
    maModel: 'Model',
    maIncludeContext: 'Include session context (REPO.md + last run summary)',
    maInstruction: 'Instruction',
    maPlaceholder: 'Type a quick instruction or question…',
    maRun: '⚡ Run',
    maStop: '■ Stop',
    maRunning: 'Running…',
    maDone: (tokens, dur, label) => \`✓ Done · \${tokens}\${dur} · \${label}\`,
    maWarning: msg => \`⚠ \${msg}\`,
  },
  it: {
    appTitle: 'Agentic Flow',
    btnNewSession: 'Nuova sessione (cancella la cronologia)',
    btnPipelineConfig: 'Configura gli step della pipeline',
    btnRefreshModels: 'Aggiorna modelli e CLI',
    btnOpenSettings: 'Apri impostazioni VS Code',
    btnDocs: 'Aiuto e Documentazione',
    btnQuickAction: "Azione rapida — esegui un'istruzione singola su qualsiasi modello",
    runConfigTitle: 'Configurazione Run',
    runConfigHint: 'Applicato solo al prossimo run — non modifica la configurazione globale',
    runProfileLabel: 'Profilo di run per la prossima esecuzione',
    applyPreset: 'Applica preset a questo run',
    applyClose: 'Applica e Chiudi',
    reset: 'Ripristina',
    workspaceConfigTitle: 'Configurazione Workspace',
    workspaceConfigHint: 'La configurazione persistente si trova nelle impostazioni standard di VS Code e nei file workspace in',
    openVsCodeSettings: 'Apri Impostazioni VS Code',
    pipelineSteps: 'Step della pipeline',
    modelRouter: 'Router Modelli',
    modelRouterHint: 'Assegna modelli alle categorie di step. Applicato quando uno step non ha un modello esplicito. Lascia vuoto per usare solo i modelli per step.',
    gitContext: 'Contesto Git',
    gitContextHint: 'Inietta il diff git corrente in ogni prompt di step. Disabilitato automaticamente quando il workspace non ha un repo git.',
    gitContextEnabled: 'Abilita iniezione contesto git',
    gitContextMaxTokens: 'Token massimi per il diff',
    gitContextCommits: 'Commit recenti da includere',
    runtime: 'Runtime',
    envFilesLabel: 'File env (uno per riga)',
    envVarsLabel: "Variabili d'ambiente",
    addVariable: '+ Aggiungi variabile',
    runProfile: 'Profilo di run',
    saveConfig: 'Salva configurazione',
    resetLocalSettings: 'Ripristina impostazioni locali',
    welcomeTitle: 'Agentic Flow',
    welcomeDesc: 'Orchestra agenti AI attraverso la tua pipeline di sviluppo completa. Descrivi un compito qui sotto per iniziare.',
    noModels: 'Nessun modello rilevato. Installa una CLI locale o configura i provider API nelle Impostazioni VS Code, poi clicca ↺.',
    noModelsHint: 'Nessun modello — installa una CLI o aggiungi chiavi API provider nelle impostazioni VS Code, poi aggiorna',
    taskPlaceholder: 'Descrivi cosa costruire o modificare…',
    runShortcut: '⌘↵ avvia',
    btnStop: '■ Ferma',
    btnContinue: 'Continua',
    btnRun: 'Avvia',
    runCompleted: (done, meta) => \`✓ Tutti i \${done} step completati con successo.\${meta}\`,
    runErrors: (errors, done, meta) => \`Completato con \${errors} errore\${errors > 1 ? 'i' : ''}. \${done} step riusciti.\${meta}\`,
    runCancelled: meta => \`Run annullato.\${meta}\`,
    customProfileDesc: 'Custom mantiene le sovrascritture di step per run correnti così come sono.',
    customProfileDescSettings: 'Custom mantiene i toggle di step abilitati/disabilitati correnti così come sono.',
    // Micro-action overlay
    quickActionTitle: '⚡ Azione Rapida',
    quickActionDesc: "Esegui un'istruzione singola su qualsiasi modello. Nessuna pipeline — output diretto.",
    maModel: 'Modello',
    maIncludeContext: 'Includi contesto sessione (REPO.md + ultimo run)',
    maInstruction: 'Istruzione',
    maPlaceholder: "Digita un'istruzione rapida o una domanda…",
    maRun: '⚡ Avvia',
    maStop: '■ Ferma',
    maRunning: 'In esecuzione…',
    maDone: (tokens, dur, label) => \`✓ Completato · \${tokens}\${dur} · \${label}\`,
    maWarning: msg => \`⚠ \${msg}\`,
  },
};
let _lang = 'en';
function _resolveVscodeLang(vsLang) {
  if (!vsLang) return 'en';
  const l = vsLang.toLowerCase();
  if (l.startsWith('it')) return 'it';
  return 'en';
}
function T(key) { return LANGS[_lang]?.[key] ?? LANGS.en[key] ?? key; }
function applyLang() {
  document.documentElement.lang = _lang;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const attr = el.dataset.i18nAttr;
    const val = T(key);
    if (typeof val === 'string') {
      if (attr) el.setAttribute(attr, val);
      else el.textContent = val;
    }
  });
  // Re-render dynamic sections that depend on language
  updateNoModelsBar();
  const ta = document.getElementById('taskInput');
  if (ta) ta.placeholder = T('taskPlaceholder');
}

// ── Messages in ───────────────────────────────────────────────
window.addEventListener('message', ({ data }) => {
  switch (data.type) {
    case 'init':
      models = data.models; config = data.config; session = data.session;
      if (data.language) _lang = _resolveVscodeLang(data.language);
      if (!Object.keys(sessionOverrides).length) sessionRunProfile = config?.runProfile || 'standard';
      applyLang();
      updateSessionStrip();
      updateNoModelsBar();
      renderSettingsConfig();
      syncSessionOverrideButton();
      updateControls();
      break;
    case 'runState':
      runState = data.state;
      updateSessionStrip();
      syncSteps();
      updateControls();
      break;
    case 'stepLog':
      stepLogs[data.stepId] = (stepLogs[data.stepId] || '') + data.chunk;
      patchLog(data.stepId);
      break;
    case 'sessionUpdated':
      session = data.session;
      if (!session) {
        runState = null;
        sessionOverrides = {};
        sessionRunProfile = config?.runProfile || 'standard';
        clearFeed();
        show('welcome');
      }
      syncSessionOverrideButton();
      updateSessionStrip();
      updateControls();
      break;
    case 'configSaved':
      toast('Configuration saved');
      closeSettings();
      break;
    case 'microActionChunk':
      appendMicroActionChunk(data.chunk);
      break;
    case 'microActionDone':
      finishMicroAction(data.entry);
      break;
    case 'microActionError':
      toast(data.message, true);
      setMicroActionRunning(false);
      document.getElementById('maResultMeta').textContent = T('maWarning')(data.message);
      document.getElementById('maResultWrap').style.display = '';
      break;
    case 'error':
      toast(data.message, true);
      appendError(data.message);
      break;
  }
});
vscode.postMessage({ type: 'ready' });

// ── Wiring ────────────────────────────────────────────────────
const taskInput = document.getElementById('taskInput');

document.getElementById('btnStart').onclick    = () => run('new');
document.getElementById('btnContinue').onclick = () => run('continue');
document.getElementById('btnCancel').onclick   = () => vscode.postMessage({ type: 'cancelRun' });
document.getElementById('btnRefreshModels').onclick      = () => vscode.postMessage({ type: 'refreshModels' });
document.getElementById('btnOpenSettings').onclick       = () => vscode.postMessage({ type: 'openSettingsUi' });
document.getElementById('btnOpenSettingsUi').onclick     = () => vscode.postMessage({ type: 'openSettingsUi' });
document.getElementById('btnCloseSettings').onclick      = closeSettings;
document.getElementById('btnSaveConfig').onclick         = saveConfig;
document.getElementById('btnNewSession').onclick          = newSession;
document.getElementById('btnTogglePipelineConfig').onclick = openSessionConfig;
document.getElementById('btnCloseSessionConfig').onclick   = closeSessionConfig;
document.getElementById('btnApplySessionConfig').onclick   = applySessionConfig;
document.getElementById('btnResetSessionConfig').onclick   = resetSessionConfig;
document.getElementById('btnResetLocalSettings').onclick   = resetLocalSettings;
document.getElementById('btnOpenDocs').onclick             = () => vscode.postMessage({ type: 'openDocs' });
document.getElementById('btnMicroAction').onclick          = openMicroAction;
document.getElementById('btnCloseMicroAction').onclick     = closeMicroAction;
document.getElementById('btnRunMicroAction').onclick       = runMicroAction;
document.getElementById('btnCancelMicroAction').onclick    = () => vscode.postMessage({ type: 'cancelMicroAction' });

taskInput.addEventListener('input', () => {
  autosize();
  updateControls();
});
taskInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run('new'); }
});

updateControls();

function autosize() {
  taskInput.style.height = 'auto';
  taskInput.style.height = Math.min(taskInput.scrollHeight, 180) + 'px';
}

// ── Run ───────────────────────────────────────────────────────
function run(mode) {
  const task = taskInput.value.trim();
  if (!task) { toast('Enter a requirement first.', true); return; }
  if (mode === 'new') {
    Object.keys(stepLogs).forEach(k => delete stepLogs[k]);
    clearFeed();
  }
  appendUserMsg(task);
  taskInput.value = ''; autosize();
  const stepOverridesList = Object.entries(sessionOverrides).map(([id, ov]) => ({ id, ...ov }));
  vscode.postMessage({ type: 'startRun', task, mode, stepOverrides: stepOverridesList.length ? stepOverridesList : undefined });
}

// ── Feed helpers ──────────────────────────────────────────────
function clearFeed() {
  document.querySelectorAll('#chat .msg-user, #chat .step-card, #chat .run-banner, #chat .msg-error').forEach(el => el.remove());
}

function appendUserMsg(text) {
  hide('welcome');
  const el = document.createElement('div');
  el.className = 'msg-user';
  el.innerHTML = \`<div class="msg-user-bubble">\${escapeHtml(text)}</div>\`;
  chat().appendChild(el);
  scrollBottom();
}

function appendError(text) {
  hide('welcome');
  const el = document.createElement('div');
  el.className = 'msg-error';
  el.innerHTML = \`<div class="msg-error-bubble">\${escapeHtml(text)}</div>\`;
  chat().appendChild(el);
  scrollBottom();
}

// ── Step cards ────────────────────────────────────────────────
function syncSteps() {
  if (!runState) return;
  hide('welcome');
  runState.steps.forEach(step => {
    let card = document.getElementById('sc-' + step.id);
    if (!card) { card = makeCard(step); chat().appendChild(card); }
    updateCard(step);
  });
  if (runState.finished) showBanner();
}

function makeCard(step) {
  const el = document.createElement('div');
  el.className = 'step-card';
  el.id = 'sc-' + step.id;
  el.innerHTML = \`
    <div class="step-card-header" id="sh-\${step.id}">
      <span class="step-si" id="si-\${step.id}"><span class="si-dot-pending"></span></span>
      <span class="step-label">\${escapeHtml(step.name || step.id)}</span>
      <div class="step-chips" id="chips-\${step.id}"></div>
      <button class="btn-rerun" id="rerun-\${step.id}" title="Re-run this step" style="display:none" onclick="rerunStep(event, '\${step.id}')">↩</button>
      <span class="step-chevron" id="chev-\${step.id}">▾</span>
    </div>
    <div class="step-body" id="sb-\${step.id}">
      <div class="step-body-inner">
        <div class="step-running-info" id="rinfo-\${step.id}" style="display:none">
          <span class="step-running-dots">Running</span>
        </div>
        <div class="step-summary" id="sum-\${step.id}" style="display:none"></div>
        <div class="step-summary" id="usage-\${step.id}" style="display:none"></div>
        <div class="step-files-wrap" id="files-\${step.id}" style="display:none"></div>
        <div class="findings-wrap" id="finds-\${step.id}" style="display:none"></div>
        <pre class="step-log" id="log-\${step.id}"></pre>
      </div>
    </div>
  \`;
  el.querySelector('.step-card-header').addEventListener('click', () => toggleBody(step.id));
  return el;
}

function rerunStep(event, stepId) {
  event.stopPropagation();
  if (runState && !runState.finished && !runState.cancelled) {
    toast('Stop the current run first.', true); return;
  }
  vscode.postMessage({ type: 'rerunStep', stepId });
}

function toggleBody(id) {
  const body = document.getElementById('sb-' + id);
  const chev = document.getElementById('chev-' + id);
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  chev.classList.toggle('open', !isOpen);
  if (!isOpen) scrollBottom();
}

function openBody(id) {
  document.getElementById('sb-' + id)?.classList.add('open');
  document.getElementById('chev-' + id)?.classList.add('open');
}

const STATUS_ICON = {
  pending: '<span class="si-dot-pending"></span>',
  running: '<span class="si-ring"></span>',
  done:    '<span class="si-check">✓</span>',
  error:   '<span class="si-cross">✗</span>',
  skipped: '<span class="si-skip">—</span>',
};

function updateCard(step) {
  const si = document.getElementById('si-' + step.id);
  if (si) si.innerHTML = STATUS_ICON[step.status] || STATUS_ICON.pending;

  // Chips
  const chips = document.getElementById('chips-' + step.id);
  if (chips) {
    const parts = [];
    if (step.modelId) parts.push(\`<span class="chip chip-model">\${escapeHtml(shortModel(step.modelId))}</span>\`);
    if (step.sourceLabel) parts.push(\`<span class="chip chip-time">\${escapeHtml(step.sourceLabel)}</span>\`);
    if (step.durationMs) parts.push(\`<span class="chip chip-time">\${(step.durationMs/1000).toFixed(1)}s</span>\`);
    if (step.tokensUsed) parts.push(\`<span class="chip chip-tokens">\${step.tokenUsage?.accounting === 'reported' ? '' : '≈'}\${fmtNum(step.tokensUsed)}t</span>\`);
    chips.innerHTML = parts.join('');
  }

  // Re-run button: visible only when step is done/error and no run is active
  const rerunBtn = document.getElementById('rerun-' + step.id);
  if (rerunBtn) {
    const runActive = runState && !runState.finished && !runState.cancelled;
    rerunBtn.style.display = (step.status === 'done' || step.status === 'error') && !runActive ? '' : 'none';
  }

  if (step.status === 'running') {
    openBody(step.id);
    const rinfo = document.getElementById('rinfo-' + step.id);
    if (rinfo) rinfo.style.display = '';
    scrollBottom();
  } else {
    const rinfo = document.getElementById('rinfo-' + step.id);
    if (rinfo) rinfo.style.display = 'none';
  }

  if (step.status === 'done' || step.status === 'error') {
    // Summary
    if (step.parsed?.summary) {
      const s = document.getElementById('sum-' + step.id);
      s.textContent = step.parsed.summary;
      s.style.display = '';
    }
    const usage = formatTokenUsage(step);
    if (usage) {
      const u = document.getElementById('usage-' + step.id);
      u.textContent = usage;
      u.style.display = '';
    }
    if (step.status === 'error' && step.error) {
      const s = document.getElementById('sum-' + step.id);
      s.textContent = step.error;
      s.className = 'step-summary is-error';
      s.style.display = '';
      openBody(step.id); // auto-expand on error so the message is visible
    }
    // Files
    if (step.filesChanged?.length) {
      const f = document.getElementById('files-' + step.id);
      f.innerHTML = \`<div class="step-files-label">Files changed</div><div class="step-files-list">\${
        step.filesChanged.map(f => \`<span class="file-chip">\${escapeHtml(f)}</span>\`).join('')
      }</div>\`;
      f.style.display = '';
    }
    // Findings
    if (step.parsed?.findings?.length) {
      const fi = document.getElementById('finds-' + step.id);
      fi.innerHTML = \`<div class="findings-label">Findings</div>\` + step.parsed.findings.map(f => \`
        <div class="finding-item sev-\${f.severity}">
          <span class="finding-sev">\${f.severity}</span>
          <span class="finding-title">\${escapeHtml(f.title)}</span>
          \${f.recommendation ? \`<span class="finding-rec">\${escapeHtml(f.recommendation)}</span>\` : ''}
        </div>
      \`).join('');
      fi.style.display = '';
    }
  }
}

function patchLog(stepId) {
  const el = document.getElementById('log-' + stepId);
  if (!el) return;
  el.textContent = stepLogs[stepId] || '';
  if (document.getElementById('sb-' + stepId)?.classList.contains('open')) scrollBottom();
}

function showBanner() {
  const bid = 'banner-' + runState.runId;
  if (document.getElementById(bid)) return;
  const errors = runState.steps.filter(s => s.status === 'error').length;
  const done   = runState.steps.filter(s => s.status === 'done').length;
  const el = document.createElement('div');
  el.id = bid;
  el.className = 'run-banner ' + (runState.cancelled ? 'cancelled' : errors ? 'error' : 'success');
  const totals = getRunTotals();
  const meta = formatTotalsMeta(totals);
  el.textContent = runState.cancelled
    ? T('runCancelled')(meta)
    : errors
      ? T('runErrors')(errors, done, meta)
      : T('runCompleted')(done, meta);
  chat().appendChild(el);
  scrollBottom();
}

// ── Session strip ─────────────────────────────────────────────
function updateSessionStrip() {
  const strip = document.getElementById('sessionStrip');
  const title = document.getElementById('sessionTitle');
  const iter  = document.getElementById('sessionIter');
  const meta  = document.getElementById('sessionMeta');
  if (!session) { strip.classList.remove('visible'); return; }
  title.textContent = session.title;
  iter.textContent  = session.iteration > 1 ? \`iter \${session.iteration}\` : '';
  iter.style.display = session.iteration > 1 ? '' : 'none';
  const totals = getRunTotals();
  meta.textContent = formatSessionMeta(totals);
  meta.style.display = totals.tokens ? '' : 'none';
  strip.classList.add('visible');
}

function updateNoModelsBar() {
  const bar = document.getElementById('noModelsBar');
  const noModels = !models.length || (models.length === 1 && models[0].id === '__none__');
  bar.classList.toggle('visible', noModels);
  if (noModels) bar.textContent = T('noModels');
  const hint = document.getElementById('inputHint');
  hint.textContent = noModels ? T('noModelsHint') : '';
}

// ── Controls ──────────────────────────────────────────────────
function updateControls() {
  const running = runState && !runState.finished && !runState.cancelled;
  const hasTask = !!taskInput.value.trim();
  const hasModels = !!models.length && !(models.length === 1 && models[0].id === '__none__');

  taskInput.disabled = !!running;
  document.getElementById('btnStart').disabled    = !!running || !hasTask || !hasModels;
  document.getElementById('btnContinue').disabled = !!running || !session || !hasTask || !hasModels;
  document.getElementById('btnCancel').disabled   = !running;
  document.getElementById('btnNewSession').disabled = !!running;
  document.getElementById('btnTogglePipelineConfig').disabled = !!running || !config;
  document.getElementById('btnOpenSettings').disabled = !!running || !config;
  document.getElementById('btnRefreshModels').disabled = !!running;
  document.getElementById('btnSaveConfig').disabled = !!running || !config;
  document.getElementById('btnResetLocalSettings').disabled = !!running || !config;
  document.getElementById('btnApplySessionConfig').disabled = !!running || !config;
  document.getElementById('btnResetSessionConfig').disabled = !!running || !config;
  document.getElementById('btnMicroAction').disabled = !!running;

  // Refresh re-run buttons visibility (depends on run active state)
  document.querySelectorAll('[id^="rerun-"]').forEach(btn => {
    const stepId = btn.id.replace('rerun-', '');
    const step = runState?.steps?.find(s => s.id === stepId);
    if (step) {
      btn.style.display = (step.status === 'done' || step.status === 'error') && !running ? '' : 'none';
    }
  });
}

// ── Session config (per-run, not persisted) ───────────────────
function openSessionConfig() {
  renderSessionConfig();
  document.getElementById('sessionConfig').classList.add('open');
  syncSessionOverrideButton(true);
}

function closeSessionConfig() {
  document.getElementById('sessionConfig').classList.remove('open');
  syncSessionOverrideButton();
}

function renderSessionConfig() {
  if (!config) return;
  const body = document.getElementById('scBody');
  const profileOptions = [
    ['lite', 'Lite'],
    ['standard', 'Standard'],
    ['full', 'Full'],
    ['evolutive', 'Evolutive'],
    ['hotfix', 'Hotfix'],
    ['custom', 'Custom'],
  ].map(([value, label]) => \`<option value="\${value}" \${sessionRunProfile === value ? 'selected' : ''}>\${label}</option>\`).join('');
  // Build effective state: config defaults merged with current sessionOverrides
  body.innerHTML = \`
    <div style="padding:7px 12px 4px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid var(--border)">
      Applies to the next run only — does not change global config
    </div>
    <div style="padding:12px 12px 10px;border-bottom:1px solid var(--border);margin-bottom:4px">
      <label class="cfg-field">Run profile for next execution
        <select id="scRunProfile">\${profileOptions}</select>
      </label>
      <div id="scRunProfileDesc" style="font-size:11px;color:var(--muted);margin-top:6px"></div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button type="button" class="btn-tiny" id="btnApplySessionProfile">Apply preset to this run</button>
      </div>
    </div>
    \` + config.steps.map((step, i) => {
    const ov = sessionOverrides[step.id] || {};
    const enabled = ov.enabled !== undefined ? ov.enabled : step.enabled;
    const model   = ov.model || step.model || '';
    const skill   = ov.skill !== undefined ? ov.skill : (step.skill || '');
    const mOpts   = renderModelOptions(model);
    return \`
      <div class="cfg-step" data-step-id="\${step.id}">
        <div class="cfg-step-toggle" role="button" tabindex="0" aria-expanded="false" onclick="toggleScStep(event, this)" onkeydown="toggleAccordionKey(event, this, toggleScStep)">
          <input type="checkbox" class="sc-enabled" \${enabled ? 'checked' : ''}/>
          <span class="cfg-step-toggle-name\${enabled ? '' : ' off'}" style="\${enabled ? '' : 'opacity:.5;text-decoration:line-through'}">\${i+1}. \${escapeHtml(step.name)}</span>
          <span class="cfg-step-expand">▾</span>
        </div>
        <div class="cfg-step-fields">
          <label class="cfg-field">Model
            <select class="sc-model">\${mOpts}</select>
          </label>
          <label class="cfg-field">Skill file (optional override)
            <div class="cfg-skill-row">
              <input type="text" class="sc-skill" value="\${escapeHtml(skill)}" placeholder="\${escapeHtml(step.skill || '')}"/>
              <button type="button" class="btn-tiny cfg-edit-skill" onclick="openSkillFromStep(event, this, '.sc-skill')">Edit</button>
            </div>
          </label>
        </div>
      </div>\`;
  }).join('');

  const profileSelect = document.getElementById('scRunProfile');
  const syncProfileDescription = () => {
    const selected = profileSelect.value;
    const desc = document.getElementById('scRunProfileDesc');
    desc.textContent = selected === 'custom'
      ? T('customProfileDesc')
      : (runProfiles[selected]?.description || '');
  };
  profileSelect.onchange = () => {
    sessionRunProfile = profileSelect.value;
    syncProfileDescription();
  };
  syncProfileDescription();
  document.getElementById('btnApplySessionProfile').onclick = () => applyProfilePresetToUi(profileSelect.value, 'session');
}

function toggleScStep(e, label) {
  if (shouldIgnoreAccordionToggle(e)) return;
  toggleAccordion(label);
}

function applySessionConfig() {
  if (!config) return;
  const profileSelect = document.getElementById('scRunProfile');
  if (profileSelect) sessionRunProfile = profileSelect.value;
  sessionOverrides = {};
  document.querySelectorAll('#scBody .cfg-step').forEach(el => {
    const stepId = el.dataset.stepId;
    const step   = config.steps.find(s => s.id === stepId);
    if (!step) return;
    const enabled = el.querySelector('.sc-enabled').checked;
    const model   = el.querySelector('.sc-model').value;
    const skill   = el.querySelector('.sc-skill').value.trim();
    const ov = {};
    if (enabled !== step.enabled) ov.enabled = enabled;
    if (model && model !== step.model) ov.model = model;
    if (skill && skill !== (step.skill || '')) ov.skill = skill;
    if (Object.keys(ov).length) sessionOverrides[stepId] = ov;
  });
  const count = Object.keys(sessionOverrides).length;
  closeSessionConfig();
  toast(count ? \`\${count} step override\${count > 1 ? 's' : ''} active for next run\` : 'No overrides — using global config');
}

function resetSessionConfig() {
  sessionOverrides = {};
  sessionRunProfile = 'custom';
  renderSessionConfig();
  syncSessionOverrideButton(true);
  toast('Overrides cleared');
}

// ── Settings ──────────────────────────────────────────────────
function openSettings()  { document.getElementById('settingsOverlay').classList.add('open'); renderSettingsConfig(); }
function closeSettings() { document.getElementById('settingsOverlay').classList.remove('open'); }

function renderSettingsConfig() {
  if (!config) return;
  renderStepsConfig();
  renderModelRouterConfig();
  renderGitContextConfig();
  renderRuntimeConfig();
}

function renderStepsConfig() {
  const profile = config.runProfile || 'standard';
  const profileOptions = [
    ['lite', 'Lite'],
    ['standard', 'Standard'],
    ['full', 'Full'],
    ['evolutive', 'Evolutive'],
    ['hotfix', 'Hotfix'],
    ['custom', 'Custom'],
  ].map(([value, label]) => \`<option value="\${value}" \${profile === value ? 'selected' : ''}>\${label}</option>\`).join('');

  document.getElementById('stepsConfig').innerHTML = \`
    <div style="padding:0 0 12px;border-bottom:1px solid var(--border);margin-bottom:12px">
      <label class="cfg-field">Run profile
        <select id="cfgRunProfile">\${profileOptions}</select>
      </label>
      <div id="cfgRunProfileDesc" style="font-size:11px;color:var(--muted);margin-top:6px"></div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button type="button" class="btn-tiny" id="btnApplyRunProfile">Apply preset to step toggles</button>
      </div>
    </div>
  \` + config.steps.map(step => {
    const mOpts = renderModelOptions(step.model);
    const cOpts = ['summary','full','none'].map(c =>
      \`<option value="\${c}" \${(step.contextMode || 'summary') === c ? 'selected' : ''}>\${c}</option>\`
    ).join('');
    return \`
      <div class="cfg-step" data-step-id="\${step.id}">
        <div class="cfg-step-toggle" role="button" tabindex="0" aria-expanded="false" onclick="toggleCfgStep(event, this)" onkeydown="toggleAccordionKey(event, this, toggleCfgStep)">
          <input type="checkbox" class="cfg-enabled" \${step.enabled ? 'checked' : ''}/>
          <span class="cfg-step-toggle-name">\${escapeHtml(step.name)}</span>
          <span class="cfg-step-expand">▾</span>
        </div>
        <div class="cfg-step-fields">
          <label class="cfg-field">Model<select class="cfg-model">\${mOpts}</select></label>
          <label class="cfg-field">Context<select class="cfg-context">\${cOpts}</select></label>
          <label class="cfg-field">Skill
            <div class="cfg-skill-row">
              <input type="text" class="cfg-skill" value="\${escapeHtml(step.skill || '')}"/>
              <button type="button" class="btn-tiny cfg-edit-skill" onclick="openSkillFromStep(event, this, '.cfg-skill')">Edit</button>
            </div>
          </label>
        </div>
      </div>\`;
  }).join('');

  const profileSelect = document.getElementById('cfgRunProfile');
  const syncProfileDescription = () => {
    const selected = profileSelect.value;
    const desc = document.getElementById('cfgRunProfileDesc');
    desc.textContent = selected === 'custom'
      ? T('customProfileDescSettings')
      : (runProfiles[selected]?.description || '');
  };
  profileSelect.onchange = syncProfileDescription;
  syncProfileDescription();
  document.getElementById('btnApplyRunProfile').onclick = () => applyProfilePresetToUi(profileSelect.value);
}

function toggleCfgStep(e, label) {
  if (shouldIgnoreAccordionToggle(e)) return;
  toggleAccordion(label);
}

const STEP_CATEGORIES = ['planning', 'generation', 'review', 'verification', 'reporting'];

function renderModelRouterConfig() {
  const router = config.modelRouter || {};
  document.getElementById('modelRouterConfig').innerHTML = STEP_CATEGORIES.map(cat => {
    const currentModel = router[cat] || '';
    const useStepLabel = _lang === 'it' ? '— usa modello dello step —' : '— use step model —';
    const mOpts = \`<option value="">\${useStepLabel}</option>\` + renderModelOptions(currentModel);
    return \`
      <label class="cfg-field" style="margin-bottom:6px">
        <span style="text-transform:capitalize">\${cat}</span>
        <select class="router-model" data-category="\${cat}">\${mOpts}</select>
      </label>\`;
  }).join('');
}

function renderGitContextConfig() {
  const gc = config.gitContext || {};
  const enabled = gc.enabled !== false;
  const maxTokens = gc.maxTokens ?? 500;
  const commits = gc.recentCommits ?? 5;
  document.getElementById('gitContextConfig').innerHTML = \`
    <label class="cfg-field" style="flex-direction:row;align-items:center;gap:8px;margin-bottom:8px">
      <input type="checkbox" id="gitCtxEnabled" \${enabled ? 'checked' : ''}/>
      <span>\${T('gitContextEnabled')}</span>
    </label>
    <label class="cfg-field" style="margin-bottom:6px">\${T('gitContextMaxTokens')}
      <input type="number" id="gitCtxMaxTokens" value="\${maxTokens}" min="100" max="2000" step="50" style="width:80px"/>
    </label>
    <label class="cfg-field">\${T('gitContextCommits')}
      <input type="number" id="gitCtxCommits" value="\${commits}" min="1" max="20" step="1" style="width:60px"/>
    </label>
  \`;
}

function renderRuntimeConfig() {
  const runtime = config.runtime || {};
  const envFiles = (runtime.envFiles || []).join('\\n');
  const envEntries = Object.entries(runtime.env || {});
  document.getElementById('runtimeConfig').innerHTML = \`
    <label class="cfg-field" style="margin-bottom:8px">\${T('envFilesLabel')}
      <textarea id="runtimeEnvFiles" rows="2" style="font-family:var(--vsc-mono);font-size:11px" placeholder=".agentic-flow/runtime.env">\${escapeHtml(envFiles)}</textarea>
    </label>
    <div style="font-size:11px;color:var(--muted);margin-bottom:5px">\${T('envVarsLabel')}</div>
    <div id="runtimeEnvList">\${
      (envEntries.length ? envEntries : [['','']]).map(([k,v]) => envRow(k,v)).join('')
    }</div>
    <button type="button" class="btn-tiny" id="btnAddEnv" style="margin-top:6px">+ Add variable</button>
  \`;
  document.getElementById('btnAddEnv').textContent = T('addVariable');
  document.getElementById('btnAddEnv').onclick = () => {
    document.getElementById('runtimeEnvList').insertAdjacentHTML('beforeend', envRow('',''));
  };
}

function envRow(k, v) {
  return \`<div class="env-row">
    <input type="text" class="runtime-env-key"   placeholder="KEY"   value="\${escapeHtml(k)}"/>
    <input type="text" class="runtime-env-value" placeholder="value" value="\${escapeHtml(v)}"/>
    <button type="button" class="btn-icon-text env-del" onclick="this.closest('.env-row').remove()">✕</button>
  </div>\`;
}

function saveConfig() {
  const selectedProfile = document.getElementById('cfgRunProfile')?.value || 'standard';
  config.runProfile = selectedProfile;
  document.querySelectorAll('#stepsConfig .cfg-step').forEach(el => {
    const step = config.steps.find(s => s.id === el.dataset.stepId);
    if (!step) return;
    step.enabled     = el.querySelector('.cfg-enabled').checked;
    step.model       = el.querySelector('.cfg-model').value;
    step.skill       = el.querySelector('.cfg-skill').value;
    step.contextMode = el.querySelector('.cfg-context').value;
  });
  // Model router
  const router = {};
  document.querySelectorAll('.router-model').forEach(sel => {
    const cat = sel.dataset.category;
    const val = sel.value;
    if (cat && val) router[cat] = val;
  });
  config.modelRouter = router;
  // Git context
  const gitCtxEnabled = document.getElementById('gitCtxEnabled');
  const gitCtxMaxTokens = document.getElementById('gitCtxMaxTokens');
  const gitCtxCommits = document.getElementById('gitCtxCommits');
  if (gitCtxEnabled) {
    config.gitContext = config.gitContext || {};
    config.gitContext.enabled   = gitCtxEnabled.checked;
    config.gitContext.maxTokens = parseInt(gitCtxMaxTokens?.value || '500', 10) || 500;
    config.gitContext.recentCommits = parseInt(gitCtxCommits?.value || '5', 10) || 5;
  }
  // Runtime
  config.runtime = config.runtime || {};
  const evf = document.getElementById('runtimeEnvFiles').value.trim();
  config.runtime.envFiles = evf ? evf.split('\\n').map(l => l.trim()).filter(Boolean) : [];
  const env = {};
  document.querySelectorAll('.env-row').forEach(row => {
    const k = row.querySelector('.runtime-env-key').value.trim();
    const v = row.querySelector('.runtime-env-value').value.trim();
    if (k) env[k] = v;
  });
  config.runtime.env = env;
  vscode.postMessage({ type: 'saveConfig', config });
}

function applyProfilePresetToUi(profile, target = 'settings') {
  const preset = runProfiles[profile];
  if (!preset) return;
  const enabled = new Set(preset.enabledStepIds || []);
  const rootSelector = target === 'session' ? '#scBody .cfg-step' : '#stepsConfig .cfg-step';
  const inputSelector = target === 'session' ? '.sc-enabled' : '.cfg-enabled';
  document.querySelectorAll(rootSelector).forEach(el => {
    const checked = enabled.has(el.dataset.stepId);
    const input = el.querySelector(inputSelector);
    const name = el.querySelector('.cfg-step-toggle-name');
    input.checked = checked;
    if (name) name.style.opacity = checked ? '' : '.5';
  });
  if (target === 'session') sessionRunProfile = profile;
  toast(\`Applied \${profile} profile to \${target === 'session' ? 'next run' : 'step toggles'}\`);
}

// ── Micro-actions ─────────────────────────────────────────────
function openMicroAction() {
  // Populate model select with current models
  const sel = document.getElementById('maModelSelect');
  if (sel && models.length) {
    sel.innerHTML = renderModelOptions(sel.value || models[0]?.id || '');
  }
  document.getElementById('maResult').textContent = '';
  document.getElementById('maResultWrap').style.display = 'none';
  document.getElementById('microActionOverlay').classList.add('open');
}

function closeMicroAction() {
  document.getElementById('microActionOverlay').classList.remove('open');
}

function runMicroAction() {
  const prompt = document.getElementById('maPrompt').value.trim();
  if (!prompt) { toast('Enter an instruction first.', true); return; }
  const modelId = document.getElementById('maModelSelect').value;
  if (!modelId) { toast('Select a model first.', true); return; }
  const includeContext = document.getElementById('maIncludeContext').checked;
  // Clear previous result
  document.getElementById('maResult').textContent = '';
  document.getElementById('maResultMeta').textContent = T('maRunning');
  document.getElementById('maResultWrap').style.display = '';
  setMicroActionRunning(true);
  vscode.postMessage({ type: 'runMicroAction', prompt, modelId, includeContext });
}

function appendMicroActionChunk(chunk) {
  const el = document.getElementById('maResult');
  el.textContent += chunk;
  el.scrollTop = el.scrollHeight;
}

function finishMicroAction(entry) {
  setMicroActionRunning(false);
  const exact = entry.tokenUsage?.accounting === 'reported';
  const tokens = entry.tokensUsed ? \`\${exact ? '' : '≈'}\${fmtNum(entry.tokensUsed)} tokens · \` : '';
  const dur = fmtDuration(entry.durationMs);
  document.getElementById('maResultMeta').textContent = T('maDone')(tokens, dur, entry.modelLabel);
  const el = document.getElementById('maResult');
  el.textContent = entry.output;
  el.scrollTop = el.scrollHeight;
}

function setMicroActionRunning(running) {
  document.getElementById('btnRunMicroAction').disabled = running;
  document.getElementById('btnCancelMicroAction').disabled = !running;
  document.getElementById('maModelSelect').disabled = running;
  document.getElementById('maIncludeContext').disabled = running;
  document.getElementById('maPrompt').disabled = running;
}

// ── Utils ─────────────────────────────────────────────────────
function newSession() {
  if (runState && !runState.finished && !runState.cancelled) {
    toast('Stop the current run first.', true); return;
  }
  vscode.postMessage({ type: 'newSession' });
}

function resetLocalSettings() {
  if (runState && !runState.finished && !runState.cancelled) {
    toast('Stop the current run first.', true); return;
  }
  if (!window.confirm('Reset local Agentic Flow settings for this workspace? This recreates .agentic-flow from defaults.')) return;
  vscode.postMessage({ type: 'resetLocalSettings' });
}

function chat() { return document.getElementById('chat'); }
function scrollBottom() { const c = chat(); c.scrollTop = c.scrollHeight; }
function hide(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
function show(id) { const el = document.getElementById(id); if (el) el.style.display = ''; }
function fmtNum(n) { return n >= 1000 ? (n/1000).toFixed(1) + 'k' : String(n); }
function fmtDuration(ms) {
  if (!ms) return '0s';
  const seconds = Math.round(ms / 100) / 10;
  return seconds < 60 ? \`\${seconds}s\` : \`\${Math.floor(seconds / 60)}m \${Math.round(seconds % 60)}s\`;
}
function shortModel(id) {
  if (!id) return '';
  const m = models.find(x => x.id === id);
  if (m) {
    return m.label.replace(/^claude\\s*/i,'').replace(/\\s*\\(.*\\)$/,'').trim();
  }
  return id.split('/').pop().split(':').pop();
}
function renderModelOptions(selectedValue) {
  const grouped = models.reduce((acc, model) => {
    const key = model.sourceLabel || model.providerLabel || model.source || 'Other';
    (acc[key] ||= []).push(model);
    return acc;
  }, {});
  return Object.entries(grouped).map(([group, items]) => {
    const options = items.map(model => {
      const selected = modelMatchesSelection(model, selectedValue) ? 'selected' : '';
      return \`<option value="\${escapeHtml(model.id)}" \${selected}>\${escapeHtml(model.label)}</option>\`;
    }).join('');
    return \`<optgroup label="\${escapeHtml(group)}">\${options}</optgroup>\`;
  }).join('');
}
function modelMatchesSelection(model, selectedValue) {
  return model.id === selectedValue || model.modelName === selectedValue;
}
function escapeHtml(v) {
  if (typeof v !== 'string') v = String(v ?? '');
  return v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function toast(msg, isError) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' is-error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function getRunTotals() {
  const sourceSteps = runState?.steps?.length ? runState.steps : (session?.latestRun?.steps || []);
  return sourceSteps.reduce((acc, step) => {
    acc.tokens += Number(step.tokensUsed || 0);
    acc.durationMs += Number(step.durationMs || 0);
    acc.promptTokens += Number(step.promptTokens || 0);
    acc.outputTokens += Number(step.outputTokens || 0);
    acc.costUsd += Number(step.tokenUsage?.costUsd || 0);
    acc.reasoningTokens += Number(step.tokenUsage?.reasoningTokens || 0);
    acc.cachedInputTokens += Number(step.tokenUsage?.cachedInputTokens || 0);
    return acc;
  }, { tokens: 0, durationMs: 0, promptTokens: 0, outputTokens: 0, costUsd: 0, reasoningTokens: 0, cachedInputTokens: 0 });
}
function formatTokenUsage(step) {
  if (!step.tokensUsed) return '';
  const exact = step.tokenUsage?.accounting === 'reported';
  const parts = [
    \`\${exact ? 'Precise' : 'Estimated'} usage: \${exact ? '' : '≈'}\${fmtNum(step.tokensUsed)} total\`,
  ];
  if (step.promptTokens) parts.push(\`\${fmtNum(step.promptTokens)} in\`);
  if (step.outputTokens) parts.push(\`\${fmtNum(step.outputTokens)} out\`);
  if (step.tokenUsage?.cachedInputTokens) parts.push(\`\${fmtNum(step.tokenUsage.cachedInputTokens)} cached\`);
  if (step.tokenUsage?.reasoningTokens) parts.push(\`\${fmtNum(step.tokenUsage.reasoningTokens)} reasoning\`);
  if (step.tokenUsage?.costUsd) parts.push(\`$\${step.tokenUsage.costUsd.toFixed(6)}\`);
  return parts.join(' · ');
}
function formatTotalsMeta(totals) {
  if (!totals.tokens) return '';
  const parts = [
    [totals.promptTokens ? \`\${fmtNum(totals.promptTokens)} in\` : '', totals.outputTokens ? \`\${fmtNum(totals.outputTokens)} out\` : '', \`\${fmtNum(totals.tokens)} total\`].filter(Boolean).join(' / '),
    \`\${fmtDuration(totals.durationMs)}\`,
  ];
  if (totals.costUsd) parts.push(\`$\${totals.costUsd.toFixed(6)}\`);
  return \` \${parts.join(' · ')}.\`;
}
function formatSessionMeta(totals) {
  if (!totals.tokens) return '';
  const approx = totals.promptTokens || totals.outputTokens ? '' : '≈';
  const parts = [\`\${approx}\${fmtNum(totals.tokens)}t\`, \`\${fmtDuration(totals.durationMs)}\`];
  if (totals.promptTokens || totals.outputTokens) parts.unshift(\`\${fmtNum(totals.promptTokens)} in / \${fmtNum(totals.outputTokens)} out\`);
  if (totals.costUsd) parts.push(\`$\${totals.costUsd.toFixed(6)}\`);
  return parts.join(' · ');
}

function syncSessionOverrideButton(forceOpen) {
  const btn = document.getElementById('btnTogglePipelineConfig');
  const hasOverrides = Object.keys(sessionOverrides).length > 0;
  btn.classList.toggle('active', !!forceOpen || hasOverrides);
}

function shouldIgnoreAccordionToggle(event) {
  const target = event.target;
  return !!target?.closest?.('input, select, textarea, button, a');
}

function toggleAccordionKey(event, label, handler) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  handler({ target: label }, label);
}

function toggleAccordion(label) {
  const fields = label.parentElement.querySelector('.cfg-step-fields');
  const arrow  = label.querySelector('.cfg-step-expand');
  const isOpen = fields.classList.contains('open');
  fields.classList.toggle('open', !isOpen);
  arrow.classList.toggle('open', !isOpen);
  label.setAttribute('aria-expanded', String(!isOpen));
}

function openSkillFromStep(event, button, selector) {
  event.preventDefault();
  event.stopPropagation();
  const row = button.closest('.cfg-field');
  const input = row.querySelector(selector);
  const skillPath = input?.value?.trim();
  if (!skillPath) {
    toast('Enter a skill path first.', true);
    input?.focus();
    return;
  }
  vscode.postMessage({ type: 'openSkillFile', skillPath });
}
</script>
</body>
</html>`;
}
