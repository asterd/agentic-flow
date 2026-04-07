// ─────────────────────────────────────────────────────────────
// webviewProvider.ts  –  VS Code WebviewPanel provider
// ─────────────────────────────────────────────────────────────
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgenticFlowConfig, CliInfo, ExtToWebMsg, ModelInfo, WebToExtMsg } from './types';
import { ensureWorkspaceFile, loadConfig, loadSessionState, resetLocalSettings, saveConfig } from './configManager';
import { WorkflowEngine } from './workflowEngine';

// ── Sidebar WebviewView Provider (activity bar) ───────────────
export class AgenticFlowSidebarProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | undefined;
  private _engineDisposable: vscode.Disposable | undefined;
  private _engine: WorkflowEngine | undefined;
  private _models: ModelInfo[] = [];
  private _clis: CliInfo[] = [];

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
    view.webview.html = getWebviewHtml(cssUri.toString());

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

  refresh(engine: WorkflowEngine, models: ModelInfo[], clis: CliInfo[]): void {
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
    this._post({ type: 'init', models: this._models, config, session });
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
    this._panel.webview.html = getWebviewHtml(cssUri.toString());

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
    this._post({ type: 'init', models: this._models, config: this._config, session });
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

function getWebviewHtml(cssUri: string): string {
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
      <span class="header-title">Agentic Flow</span>
    </div>
    <div class="header-actions">
      <button class="icon-btn" id="btnNewSession" title="New session (clears history)">
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
      <span class="settings-header-title">Run Configuration</span>
      <button class="icon-btn" id="btnCloseSessionConfig" title="Close">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8 2.146 2.854Z"/></svg>
      </button>
    </div>
    <div class="settings-body" id="scBody"></div>
    <div class="settings-footer" style="display:flex;gap:6px">
      <button class="btn-primary-full" id="btnApplySessionConfig">Apply &amp; Close</button>
      <button class="btn-ghost" id="btnResetSessionConfig" style="white-space:nowrap;flex-shrink:0">Reset</button>
    </div>
  </div>

  <!-- Session info strip -->
  <div class="session-strip" id="sessionStrip">
    <span class="session-title" id="sessionTitle"></span>
    <span class="session-iter" id="sessionIter"></span>
    <span class="session-meta" id="sessionMeta"></span>
  </div>

  <!-- No-models warning -->
  <div class="no-models-bar" id="noModelsBar">
    No models detected. Install a local CLI or configure API providers in VS Code Settings, then click ↺.
  </div>

  <!-- Chat feed -->
  <div class="chat" id="chat">
    <div class="welcome" id="welcome">
      <div class="welcome-icon">⚡</div>
      <div class="welcome-title">Agentic Flow</div>
      <div class="welcome-desc">Orchestrate AI agents through your full development pipeline. Describe a task below to start.</div>
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
          <span class="input-key-hint">⌘↵ run</span>
          <button class="btn-stop" id="btnCancel" disabled>■ Stop</button>
          <button class="btn-sec" id="btnContinue" disabled>Continue</button>
          <button class="btn-run" id="btnStart">Run</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Settings overlay -->
  <div class="settings-overlay" id="settingsOverlay">
    <div class="settings-header">
      <span class="settings-header-title">Workspace Configuration</span>
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
        <div class="settings-section-title">Pipeline steps</div>
        <div id="stepsConfig"></div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Runtime</div>
        <div class="runtime-section" id="runtimeConfig"></div>
      </div>
    </div>
    <div class="settings-footer" style="display:flex;gap:6px">
      <button class="btn-primary-full" id="btnSaveConfig">Save configuration</button>
      <button class="btn-ghost" id="btnResetLocalSettings" style="white-space:nowrap;flex-shrink:0">Reset local settings</button>
    </div>
  </div>

</div>
<script>
const vscode = acquireVsCodeApi();
let models = [], config = null, session = null, runState = null;
let sessionOverrides = {}; // { [stepId]: { enabled, model, skill } }
const stepLogs = {};

// ── Messages in ───────────────────────────────────────────────
window.addEventListener('message', ({ data }) => {
  switch (data.type) {
    case 'init':
      models = data.models; config = data.config; session = data.session;
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

taskInput.addEventListener('input', () => {
  autosize();
  updateControls();
});
taskInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run('new'); }
});

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
    ? \`Run cancelled.\${meta}\`
    : errors
      ? \`Completed with \${errors} error\${errors > 1 ? 's' : ''}. \${done} step\${done !== 1 ? 's' : ''} succeeded.\${meta}\`
      : \`✓ All \${done} step\${done !== 1 ? 's' : ''} completed successfully.\${meta}\`;
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
  const hint = document.getElementById('inputHint');
  hint.textContent = noModels ? 'No models — install a CLI or add provider API keys in VS Code settings, then refresh' : '';
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
  // Build effective state: config defaults merged with current sessionOverrides
  body.innerHTML = \`
    <div style="padding:7px 12px 4px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid var(--border)">
      Applies to the next run only — does not change global config
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
}

function toggleScStep(e, label) {
  if (shouldIgnoreAccordionToggle(e)) return;
  toggleAccordion(label);
}

function applySessionConfig() {
  if (!config) return;
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
  renderRuntimeConfig();
}

function renderStepsConfig() {
  document.getElementById('stepsConfig').innerHTML = config.steps.map(step => {
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
}

function toggleCfgStep(e, label) {
  if (shouldIgnoreAccordionToggle(e)) return;
  toggleAccordion(label);
}

function renderRuntimeConfig() {
  const runtime = config.runtime || {};
  const envFiles = (runtime.envFiles || []).join('\\n');
  const envEntries = Object.entries(runtime.env || {});
  document.getElementById('runtimeConfig').innerHTML = \`
    <label class="cfg-field" style="margin-bottom:8px">Env files (one per line)
      <textarea id="runtimeEnvFiles" rows="2" style="font-family:var(--vsc-mono);font-size:11px" placeholder=".agentic-flow/runtime.env">\${escapeHtml(envFiles)}</textarea>
    </label>
    <div style="font-size:11px;color:var(--muted);margin-bottom:5px">Environment variables</div>
    <div id="runtimeEnvList">\${
      (envEntries.length ? envEntries : [['','']]).map(([k,v]) => envRow(k,v)).join('')
    }</div>
    <button type="button" class="btn-tiny" id="btnAddEnv" style="margin-top:6px">+ Add variable</button>
  \`;
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
  document.querySelectorAll('#stepsConfig .cfg-step').forEach(el => {
    const step = config.steps.find(s => s.id === el.dataset.stepId);
    if (!step) return;
    step.enabled     = el.querySelector('.cfg-enabled').checked;
    step.model       = el.querySelector('.cfg-model').value;
    step.skill       = el.querySelector('.cfg-skill').value;
    step.contextMode = el.querySelector('.cfg-context').value;
  });
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
