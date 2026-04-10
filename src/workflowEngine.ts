// ─────────────────────────────────────────────────────────────
// workflowEngine.ts  –  Pipeline state machine
// ─────────────────────────────────────────────────────────────
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type {
  AgenticFlowConfig,
  CliInfo,
  ModelInfo,
  RunHistoryEntry,
  RunMode,
  SessionState,
  StepConfig,
  StepState,
  WorkflowRunState,
} from './types';
import { buildStepPrompt, extractStructuredOutput, writeStepSummary } from './contextManager';
import { runHardCheckStep } from './hardCheckRunner';
import { runStep } from './stepRunner';
import { getUsableModels, resolveCliForModel, resolveModelForStep } from './cliDetector';
import { getAgenticFlowDir, getStateFilePath, loadSessionState, resolveRuntimeEnv, saveSessionState } from './configManager';
import { captureGitContext } from './gitUtils';
import { writeRepoMd } from './repoSummaryWriter';
import type { GitContextSnapshot } from './types';

export type EngineEvent =
  | { type: 'stateChange'; state: WorkflowRunState }
  | { type: 'stepLog'; stepId: string; chunk: string }
  | { type: 'sessionUpdated'; session: SessionState | null }
  | { type: 'finished'; state: WorkflowRunState };

interface FileSnapshotEntry {
  size: number;
  mtimeMs: number;
}

export class WorkflowEngine {
  private _state: WorkflowRunState | null = null;
  private _session: SessionState | null = null;
  private _cancelSource: vscode.CancellationTokenSource | null = null;
  private readonly _listeners: Array<(e: EngineEvent) => void> = [];

  constructor(
    private models: ModelInfo[],
    private clis: CliInfo[],
    private readonly workspaceRoot: string,
  ) {
    this._session = loadSessionState();
  }

  setEnvironment(models: ModelInfo[], clis: CliInfo[]): void {
    this.models = models;
    this.clis = clis;
  }

  onEvent(cb: (e: EngineEvent) => void): vscode.Disposable {
    this._listeners.push(cb);
    return new vscode.Disposable(() => {
      const i = this._listeners.indexOf(cb);
      if (i >= 0) this._listeners.splice(i, 1);
    });
  }

  private emit(e: EngineEvent) {
    this._listeners.forEach(listener => listener(e));
  }

  get isRunning(): boolean {
    return this._state !== null && !this._state.finished && !this._state.cancelled;
  }

  get currentState(): WorkflowRunState | null {
    return this._state;
  }

  get currentSession(): SessionState | null {
    return this._session;
  }

  reloadSession(): SessionState | null {
    this._session = loadSessionState();
    return this._session;
  }

  async start(task: string, config: AgenticFlowConfig, mode: RunMode, stepOverrides?: import('./types').StepOverride[]): Promise<void> {
    if (this.isRunning) throw new Error('A workflow run is already in progress');
    if (!getUsableModels(this.models).length) {
      throw new Error('No runnable models are configured. Add a provider API key or install a supported CLI, then refresh models.');
    }

    // Apply per-run step overrides (session-local, not persisted)
    const effectiveSteps = config.steps.map(step => {
      const ov = stepOverrides?.find(o => o.id === step.id);
      if (!ov) return step;
      return {
        ...step,
        ...(ov.enabled !== undefined && { enabled: ov.enabled }),
        ...(ov.model !== undefined && { model: ov.model }),
        ...(ov.skill && { skill: ov.skill }),
      };
    });

    const enabledSteps = effectiveSteps.filter(step => step.enabled);
    if (enabledSteps.length === 0) throw new Error('No steps enabled in config');
    const unresolved = enabledSteps.filter(step => !resolveModelForStep(step, { ...config, steps: effectiveSteps }, this.models));
    if (unresolved.length) {
      throw new Error(`Enabled steps without a valid model: ${unresolved.map(step => step.name || step.id).join(', ')}.`);
    }

    this._cancelSource = new vscode.CancellationTokenSource();
    this._session = this.prepareSession(task, mode);
    saveSessionState(this._session);
    this.emit({ type: 'sessionUpdated', session: this._session });

    // Capture git context once for the whole run — safe, never throws
    const gitCfg = config.gitContext;
    const gitContext: GitContextSnapshot | undefined = (gitCfg?.enabled !== false)
      ? await captureGitContext(this.workspaceRoot, {
        maxTokens: gitCfg?.maxTokens,
        recentCommits: gitCfg?.recentCommits,
      })
      : undefined;

    const stepStates: StepState[] = enabledSteps.map(step => ({
      id: step.id,
      name: step.name,
      status: 'pending',
    }));

    this._state = {
      runId: randomUUID(),
      sessionId: this._session.sessionId,
      iteration: this._session.iteration,
      startedAt: Date.now(),
      task,
      mode,
      steps: stepStates,
      currentStepIndex: 0,
      finished: false,
      cancelled: false,
      title: this._session.title,
      gitContext,
    };

    this.emit({ type: 'stateChange', state: this._state });

    for (let i = 0; i < enabledSteps.length; i++) {
      if (this._cancelSource.token.isCancellationRequested) {
        this._state.cancelled = true;
        break;
      }

      const step = enabledSteps[i];
      const stepState = this._state.steps[i];
      const completedStates = this._state.steps.slice(0, i).filter(s => s.status === 'done' || s.status === 'error');

      if (!shouldRunStep(step, completedStates)) {
        stepState.status = 'skipped';
        this.emit({ type: 'stateChange', state: this._state });
        continue;
      }

      this._state.currentStepIndex = i;
      stepState.status = 'running';
      stepState.startedAt = Date.now();
      this.emit({ type: 'stateChange', state: this._state });

      try {
        await this.executeStep(step, stepState, completedStates, config, this._state.gitContext);
        stepState.status = 'done';
      } catch (err: any) {
        if (err.message === 'Cancelled') {
          stepState.status = 'skipped';
          this._state.cancelled = true;
          break;
        }
        stepState.status = 'error';
        stepState.error = String(err.message ?? err);
        for (let j = i + 1; j < this._state.steps.length; j++) {
          this._state.steps[j].status = 'skipped';
        }
        vscode.window.showErrorMessage(`[Agentic Flow] Step "${step.name}" failed: ${stepState.error}`);
        break;
      }

      stepState.finishedAt = Date.now();
      this.emit({ type: 'stateChange', state: this._state });
    }

    this._state.finished = true;
    this.emit({ type: 'stateChange', state: this._state });

    this.persistRunSummary();
    this.emit({ type: 'sessionUpdated', session: this._session });
    this.emit({ type: 'finished', state: this._state });
    this._cancelSource = null;
  }

  cancel(): void {
    this._cancelSource?.cancel();
    if (this._state) {
      this._state.cancelled = true;
      this.emit({ type: 'stateChange', state: this._state });
    }
  }

  /**
   * Re-run a single step from the last completed run.
   * Prior step states are reconstructed from the session history so that
   * the step's context prompt is built with the same inputs as the original run.
   * The re-run result replaces the step state in-place and is persisted to session.
   */
  async rerunStep(stepId: string, config: AgenticFlowConfig): Promise<void> {
    if (this.isRunning) throw new Error('A workflow run is already in progress');
    if (!this._state) throw new Error('No previous run state to re-run from');

    const stepIndex = this._state.steps.findIndex(s => s.id === stepId);
    if (stepIndex < 0) throw new Error(`Step "${stepId}" not found in the current run`);

    const stepConfig = config.steps.find(s => s.id === stepId);
    if (!stepConfig) throw new Error(`Step "${stepId}" not found in config`);

    this._cancelSource = new vscode.CancellationTokenSource();

    // Mark step as running
    const stepState = this._state.steps[stepIndex];
    stepState.status = 'running';
    stepState.startedAt = Date.now();
    stepState.error = undefined;
    stepState.output = undefined;
    stepState.parsed = undefined;
    stepState.filesChanged = undefined;
    this._state.finished = false;
    this._state.cancelled = false;
    this._state.currentStepIndex = stepIndex;
    this.emit({ type: 'stateChange', state: this._state });

    // Completed states are the steps that ran BEFORE this one in the same run
    const completedStates = this._state.steps
      .slice(0, stepIndex)
      .filter(s => s.status === 'done' || s.status === 'error');

    try {
      await this.executeStep(stepConfig, stepState, completedStates, config, this._state.gitContext);
      stepState.status = 'done';
    } catch (err: any) {
      stepState.status = 'error';
      stepState.error = String(err.message ?? err);
      vscode.window.showErrorMessage(`[Agentic Flow] Re-run of "${stepConfig.name}" failed: ${stepState.error}`);
    }

    stepState.finishedAt = Date.now();
    this._state.finished = true;
    this.emit({ type: 'stateChange', state: this._state });

    this.persistRunSummary();
    this.emit({ type: 'sessionUpdated', session: this._session });
    this.emit({ type: 'finished', state: this._state });
    this._cancelSource = null;
  }

  private prepareSession(task: string, mode: RunMode): SessionState {
    const now = Date.now();
    if (mode === 'continue' && this._session) {
      return {
        ...this._session,
        updatedAt: now,
        iteration: this._session.iteration + 1,
        currentObjective: task,
        requirements: [
          ...this._session.requirements,
          { iteration: this._session.iteration + 1, text: task, createdAt: now },
        ],
      };
    }

    return {
      sessionId: randomUUID(),
      title: titleFromTask(task),
      createdAt: now,
      updatedAt: now,
      iteration: 1,
      currentObjective: task,
      requirements: [{ iteration: 1, text: task, createdAt: now }],
      runs: [],
    };
  }

  private async executeStep(
    step: StepConfig,
    stepState: StepState,
    completedStates: StepState[],
    config: AgenticFlowConfig,
    gitContext?: GitContextSnapshot,
  ): Promise<void> {
    const model = resolveModelForStep(step, config, this.models);
    if (!model) {
      const tried = step.model || (step.category && config.modelRouter?.[step.category]) || config.defaultModel || '(none)';
      throw new Error(`Cannot resolve model "${tried}" for step "${step.id}". Check your config or provider settings.`);
    }
    const cli = resolveCliForModel(model, this.clis);
    if (model.source === 'cli' && !cli) {
      throw new Error(`Cannot find CLI for model "${model.label}". Check your local installation.`);
    }

    stepState.modelId = model.id;
    stepState.modelLabel = model.label;
    stepState.cliId = cli?.id;
    stepState.source = model.source;
    stepState.sourceLabel = model.sourceLabel;
    stepState.skillPath = step.skill;

    const before = snapshotWorkspace(this.workspaceRoot);
    const { text: prompt, estimatedTokens } = await buildStepPrompt({
      step,
      task: this._state!.task,
      session: this._session!,
      completedSteps: completedStates,
      config,
      workspaceRoot: this.workspaceRoot,
      gitContext,
    });

    const result = step.executor === 'hard-check'
      ? await runHardCheckStep({
        step,
        cli,
        model,
        prompt,
        workspaceRoot: this.workspaceRoot,
        onChunk: chunk => this.emit({ type: 'stepLog', stepId: step.id, chunk }),
        cancellationToken: this._cancelSource?.token,
        env: resolveRuntimeEnv(config),
      })
      : await runStep({
        cli,
        model,
        prompt,
        workspaceRoot: this.workspaceRoot,
        onChunk: chunk => this.emit({ type: 'stepLog', stepId: step.id, chunk }),
        cancellationToken: this._cancelSource?.token,
        env: resolveRuntimeEnv(config),
      });

    if (result.exitCode !== 0) {
      const detail = result.stderr || result.output.slice(-300).trim() || `exit code ${result.exitCode}`;
      throw new Error(`CLI error (exit ${result.exitCode}): ${detail}`);
    }

    const after = snapshotWorkspace(this.workspaceRoot);
    const filesChanged = diffSnapshots(before, after);
    const parsed = extractStructuredOutput(result.output, step.id);

    stepState.output = result.output;
    stepState.parsed = parsed;
    stepState.filesChanged = filesChanged;
    stepState.tokenUsage = result.tokenUsage;
    stepState.promptTokens = result.tokenUsage?.inputTokens ?? result.promptTokens ?? estimatedTokens;
    stepState.outputTokens = result.tokenUsage?.outputTokens ?? result.outputTokens;
    stepState.tokensUsed = result.tokenUsage?.totalTokens ?? (stepState.promptTokens + stepState.outputTokens);
    stepState.durationMs = result.durationMs;
    if ('attempts' in result && typeof result.attempts === 'number') stepState.attempts = result.attempts;
    if ('verificationStatus' in result && typeof result.verificationStatus === 'string') {
      stepState.verificationStatus = result.verificationStatus as StepState['verificationStatus'];
    }

    const stateFile = getStateFilePath();
    if (stateFile) {
      writeStepSummary(stateFile, step.id, step.name, parsed, filesChanged);
    }
  }

  private persistRunSummary(): void {
    if (!this._state || !this._session) return;
    const status: RunHistoryEntry['status'] =
      this._state.cancelled ? 'cancelled'
        : this._state.steps.some(step => step.status === 'error') ? 'error'
          : 'completed';

    const runEntry: RunHistoryEntry = {
      runId: this._state.runId,
      iteration: this._state.iteration,
      startedAt: this._state.startedAt,
      finishedAt: Date.now(),
      task: this._state.task,
      status,
      steps: this._state.steps.map(step => ({
        id: step.id,
        name: step.name,
        status: step.status,
        modelId: step.modelId,
        modelLabel: step.modelLabel,
        cliId: step.cliId,
        source: step.source,
        sourceLabel: step.sourceLabel,
        summary: step.parsed?.summary,
        filesChanged: step.filesChanged,
        findings: step.parsed?.findings,
        durationMs: step.durationMs,
        tokensUsed: step.tokensUsed,
        promptTokens: step.promptTokens,
        outputTokens: step.outputTokens,
        tokenUsage: step.tokenUsage,
        attempts: step.attempts,
        verificationStatus: step.verificationStatus,
      })),
    };

    this._session = {
      ...this._session,
      updatedAt: Date.now(),
      latestRun: runEntry,
      runs: [...this._session.runs, runEntry].slice(-20),
    };
    saveSessionState(this._session);

    // Write REPO.md to .agentic-flow/ — never throws
    const afDir = getAgenticFlowDir();
    if (afDir) writeRepoMd(this._session, afDir);
  }
}

function titleFromTask(task: string): string {
  return task.split('\n')[0].slice(0, 80) || 'Untitled Session';
}

function shouldRunStep(step: StepConfig, completedStates: StepState[]): boolean {
  if (step.runCondition !== 'ifIssues') return true;
  return completedStates.some(state => (state.parsed?.findings.length ?? 0) > 0 || state.parsed?.status === 'issues');
}

function snapshotWorkspace(root: string): Map<string, FileSnapshotEntry> {
  const snapshot = new Map<string, FileSnapshotEntry>();
  walkWorkspace(root, filePath => {
    try {
      const stat = fs.statSync(filePath);
      snapshot.set(path.relative(root, filePath), { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {}
  });
  return snapshot;
}

function diffSnapshots(before: Map<string, FileSnapshotEntry>, after: Map<string, FileSnapshotEntry>): string[] {
  const changed = new Set<string>();
  for (const [file, info] of after.entries()) {
    const prev = before.get(file);
    if (!prev || prev.size !== info.size || prev.mtimeMs !== info.mtimeMs) changed.add(file);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changed.add(file);
  }
  return Array.from(changed).sort();
}

function walkWorkspace(root: string, onFile: (filePath: string) => void): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.agentic-flow' || entry.name === 'out') {
      continue;
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkWorkspace(fullPath, onFile);
    } else {
      onFile(fullPath);
    }
  }
}
