import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getAgenticFlowDir, readSkill } from './configManager';
import { runStep, type StepRunResult } from './stepRunner';
import type { CliInfo, HardCheckConfig, ModelInfo, StepConfig, TokenUsage } from './types';

type VerificationStatus = 'passed' | 'failed' | 'timeout' | 'blocked';
type StrategyKind = 'docker-compose' | 'local-node' | 'laravel';

interface HardCheckRunResult extends StepRunResult {
  attempts: number;
  verificationStatus: VerificationStatus;
}

interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

interface StartResult extends CommandResult {
  child?: ChildProcess;
}

interface RuntimeStrategy {
  kind: StrategyKind;
  label: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand: string;
  healthCommand?: string;
  logCommand?: string;
  teardownCommand?: string;
  healthUrl?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STABLE_WINDOW_MS = 12_000;
const HEALTH_PROBE_TIMEOUT_MS = 2_500;
const HEALTH_PROBE_RETRIES = 6;
const LOG_TAIL_BYTES = 24_000;
const ERROR_PATTERNS = [
  /\berror\b/i,
  /\bexception\b/i,
  /\bfailed\b/i,
  /\bcannot\b/i,
  /\bunhandled\b/i,
  /\btraceback\b/i,
  /\bpanic\b/i,
  /\beaddrinuse\b/i,
  /\baddress already in use\b/i,
];

export async function runHardCheckStep(opts: {
  step: StepConfig;
  model: ModelInfo;
  cli?: CliInfo;
  prompt: string;
  workspaceRoot: string;
  onChunk: (chunk: string) => void;
  cancellationToken?: vscode.CancellationToken;
  env?: Record<string, string>;
}): Promise<HardCheckRunResult> {
  const startedAt = Date.now();
  const hardCheck = normalizeHardCheckConfig(opts.step.hardCheck);
  const canAutoFix = opts.model.source === 'cli';
  const maxAttempts = canAutoFix ? hardCheck.maxAttempts : 1;
  const logRoot = ensureLogDir(opts.workspaceRoot, opts.step.id);
  const artifacts: string[] = [];
  const summaryNotes: string[] = [];
  let tokenUsage: TokenUsage | undefined;
  let lastDiagnostics = 'No diagnostics collected.';
  let verificationStatus: VerificationStatus = canAutoFix ? 'failed' : 'blocked';
  let attempts = 0;

  if (!canAutoFix) {
    opts.onChunk('[hard-check] Selected model source cannot modify the workspace directly. Hard check will verify runtime once and report failures.\n');
    summaryNotes.push('Selected model source is not CLI-backed, so auto-fix retries are disabled.');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    opts.onChunk(`[hard-check] Attempt ${attempt}/${maxAttempts}\n`);
    const attemptDir = path.join(logRoot, `attempt-${attempt}`);
    fs.mkdirSync(attemptDir, { recursive: true });

    let strategy = await detectRuntimeStrategy(opts.workspaceRoot, hardCheck, opts.env ?? {});
    if (!strategy && canAutoFix) {
      opts.onChunk('[hard-check] No runnable strategy detected. Asking the model to prepare startup assets.\n');
      const prep = await askModelToFix({
        ...opts,
        hardCheck,
        extraPrompt: buildPreparationPrompt(opts.prompt, opts.step, opts.workspaceRoot),
      });
      tokenUsage = mergeTokenUsage(tokenUsage, prep.tokenUsage);
      strategy = await detectRuntimeStrategy(opts.workspaceRoot, hardCheck, opts.env ?? {});
    }

    if (!strategy) {
      verificationStatus = 'blocked';
      lastDiagnostics = 'Could not detect a runnable startup strategy. No docker compose file, package start script or Laravel runtime path was found.';
      writeAttemptLog(attemptDir, 'diagnostics.log', lastDiagnostics);
      artifacts.push(relPath(opts.workspaceRoot, path.join(attemptDir, 'diagnostics.log')));
      break;
    }

    opts.onChunk(`[hard-check] Strategy: ${strategy.label}\n`);
    const run = strategy.kind === 'docker-compose'
      ? await runDockerComposeStrategy(strategy, attemptDir, opts.workspaceRoot, hardCheck, opts.onChunk, opts.cancellationToken, opts.env ?? {})
      : await runLocalStrategy(strategy, attemptDir, opts.workspaceRoot, hardCheck, opts.onChunk, opts.cancellationToken, opts.env ?? {});

    artifacts.push(...run.artifacts.map(file => relPath(opts.workspaceRoot, file)));
    lastDiagnostics = run.diagnostics;
    summaryNotes.push(`Attempt ${attempt}: ${run.summary}`);

    if (run.ok) {
      verificationStatus = 'passed';
      const output = buildHardCheckOutput({
        stepId: opts.step.id,
        status: 'ok',
        summary: `Runtime hard-check passed after ${attempt} attempt${attempt === 1 ? '' : 's'} using ${strategy.label}.`,
        findings: canAutoFix ? [] : [{
          severity: 'info',
          title: 'Hard-check ran without auto-fix mode',
          recommendation: 'Use a CLI-backed model for this step if you want automatic correction retries.',
        }],
        artifacts,
        notes: summaryNotes,
      });
      return {
        output,
        exitCode: 0,
        stderr: '',
        durationMs: Date.now() - startedAt,
        promptTokens: tokenUsage?.inputTokens ?? 0,
        outputTokens: tokenUsage?.outputTokens ?? 0,
        tokenUsage,
        attempts,
        verificationStatus,
      };
    }

    verificationStatus = run.timedOut ? 'timeout' : 'failed';
    if (!canAutoFix || attempt >= maxAttempts) continue;

    opts.onChunk('[hard-check] Runtime failed. Asking the model to fix the detected issues.\n');
    const fix = await askModelToFix({
      ...opts,
      hardCheck,
      extraPrompt: buildFixPrompt(opts.prompt, opts.step, strategy, attempt, maxAttempts, run.diagnostics),
    });
    tokenUsage = mergeTokenUsage(tokenUsage, fix.tokenUsage);
  }

  const output = buildHardCheckOutput({
    stepId: opts.step.id,
    status: verificationStatus === 'blocked' ? 'blocked' : 'issues',
    summary: verificationStatus === 'blocked'
      ? 'Runtime hard-check could not determine how to start the project.'
      : `Runtime hard-check did not reach a healthy boot after ${attempts} attempt${attempts === 1 ? '' : 's'}.`,
    findings: [{
      severity: verificationStatus === 'blocked' ? 'high' : 'critical',
      title: verificationStatus === 'blocked' ? 'No runnable strategy detected' : 'Application did not boot cleanly',
      recommendation: 'Inspect the hard-check logs and fix the startup path or provide explicit hardCheck commands in config.',
    }],
    artifacts,
    notes: [...summaryNotes, lastDiagnostics],
  });

  return {
    output,
    exitCode: 1,
    stderr: truncate(lastDiagnostics, 600),
    durationMs: Date.now() - startedAt,
    promptTokens: tokenUsage?.inputTokens ?? 0,
    outputTokens: tokenUsage?.outputTokens ?? 0,
    tokenUsage,
    attempts,
    verificationStatus,
  };
}

async function detectRuntimeStrategy(
  workspaceRoot: string,
  hardCheck: Required<Pick<HardCheckConfig, 'healthUrl' | 'installCommand' | 'buildCommand' | 'startCommand' | 'healthCommand' | 'logCommand' | 'teardownCommand'>> & HardCheckConfig,
  env: Record<string, string>,
): Promise<RuntimeStrategy | undefined> {
  if (hardCheck.startCommand) {
    return {
      kind: hardCheck.strategy === 'laravel' ? 'laravel' : hardCheck.strategy === 'docker-compose' ? 'docker-compose' : 'local-node',
      label: hardCheck.strategy === 'docker-compose' ? 'configured docker-compose' : 'configured startup command',
      installCommand: hardCheck.installCommand || undefined,
      buildCommand: hardCheck.buildCommand || undefined,
      startCommand: hardCheck.startCommand,
      healthCommand: hardCheck.healthCommand || undefined,
      logCommand: hardCheck.logCommand || undefined,
      teardownCommand: hardCheck.teardownCommand || undefined,
      healthUrl: hardCheck.healthUrl || undefined,
    };
  }

  if ((hardCheck.strategy === 'auto' || hardCheck.strategy === 'docker-compose') && await hasCommand('docker', workspaceRoot, env)) {
    const composeFile = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
      .map(name => path.join(workspaceRoot, name))
      .find(file => fs.existsSync(file));
    if (composeFile) {
      return {
        kind: 'docker-compose',
        label: `docker compose (${path.basename(composeFile)})`,
        startCommand: 'docker compose up --build -d',
        healthCommand: 'docker compose ps',
        logCommand: 'docker compose logs --no-color --tail=300',
        teardownCommand: 'docker compose down --remove-orphans',
        healthUrl: hardCheck.healthUrl || undefined,
      };
    }
  }

  if (hardCheck.strategy === 'auto' || hardCheck.strategy === 'local-node') {
    const nodeStrategy = detectNodeStrategy(workspaceRoot, hardCheck);
    if (nodeStrategy) return nodeStrategy;
  }

  if (hardCheck.strategy === 'auto' || hardCheck.strategy === 'laravel') {
    const laravelStrategy = await detectLaravelStrategy(workspaceRoot, hardCheck, env);
    if (laravelStrategy) return laravelStrategy;
  }

  return undefined;
}

function detectNodeStrategy(
  workspaceRoot: string,
  hardCheck: Required<Pick<HardCheckConfig, 'healthUrl'>> & HardCheckConfig,
): RuntimeStrategy | undefined {
  const packageJsonPath = path.join(workspaceRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return undefined;

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};
    const packageManager = detectPackageManager(workspaceRoot);
    const startScript = ['start', 'dev', 'serve', 'preview'].find(name => scripts[name]);
    if (!startScript) return undefined;
    const buildScript = scripts.build ? `${packageManager} run build` : undefined;
    return {
      kind: 'local-node',
      label: `local ${packageManager} (${startScript})`,
      installCommand: `${packageManager} install`,
      buildCommand: hardCheck.buildCommand || buildScript,
      startCommand: `${packageManager} run ${startScript}`,
      healthUrl: hardCheck.healthUrl || inferNodeHealthUrl(scripts[startScript], packageJson),
    };
  } catch {
    return undefined;
  }
}

async function detectLaravelStrategy(
  workspaceRoot: string,
  hardCheck: Required<Pick<HardCheckConfig, 'healthUrl'>> & HardCheckConfig,
  env: Record<string, string>,
): Promise<RuntimeStrategy | undefined> {
  if (!fs.existsSync(path.join(workspaceRoot, 'artisan')) || !fs.existsSync(path.join(workspaceRoot, 'composer.json'))) {
    return undefined;
  }
  if (!await hasCommand('php', workspaceRoot, env)) return undefined;

  return {
    kind: 'laravel',
    label: 'Laravel artisan serve',
    installCommand: await hasCommand('composer', workspaceRoot, env) ? 'composer install' : undefined,
    startCommand: 'php artisan serve --host=127.0.0.1 --port=8000',
    healthUrl: hardCheck.healthUrl || 'http://127.0.0.1:8000',
  };
}

async function runDockerComposeStrategy(
  strategy: RuntimeStrategy,
  attemptDir: string,
  workspaceRoot: string,
  hardCheck: Required<Pick<HardCheckConfig, 'startupTimeoutMs' | 'healthUrl'>> & HardCheckConfig,
  onChunk: (chunk: string) => void,
  cancellationToken: vscode.CancellationToken | undefined,
  env: Record<string, string>,
): Promise<{ ok: boolean; timedOut: boolean; summary: string; diagnostics: string; artifacts: string[] }> {
  const artifacts: string[] = [];
  const startup = await runCommand(strategy.startCommand, workspaceRoot, env, hardCheck.startupTimeoutMs, onChunk, cancellationToken, '[hard-check][start]');
  const startupLog = writeCommandLog(attemptDir, 'startup', startup);
  artifacts.push(startupLog);
  if (startup.exitCode !== 0 || startup.timedOut) {
    await runTeardown(strategy, workspaceRoot, env, onChunk, cancellationToken, attemptDir, artifacts);
    return {
      ok: false,
      timedOut: startup.timedOut,
      summary: startup.timedOut ? 'docker compose startup timed out' : `docker compose startup failed with exit code ${startup.exitCode}`,
      diagnostics: summarizeDiagnostics([startup]),
      artifacts,
    };
  }

  await delay(6_000, cancellationToken);
  const health = await runCommand(strategy.healthCommand ?? 'docker compose ps', workspaceRoot, env, 20_000, onChunk, cancellationToken, '[hard-check][health]');
  const healthLog = writeCommandLog(attemptDir, 'health', health);
  artifacts.push(healthLog);
  const logs = await runCommand(strategy.logCommand ?? 'docker compose logs --no-color --tail=300', workspaceRoot, env, 20_000, onChunk, cancellationToken, '[hard-check][logs]');
  const logsFile = writeCommandLog(attemptDir, 'logs', logs);
  artifacts.push(logsFile);

  const healthy = dockerLooksHealthy(health.stdout, logs.stdout, strategy.healthUrl);
  await runTeardown(strategy, workspaceRoot, env, onChunk, cancellationToken, attemptDir, artifacts);

  return {
    ok: healthy,
    timedOut: false,
    summary: healthy ? 'docker compose booted and reported healthy/running services' : 'docker compose did not reach a healthy runtime state',
    diagnostics: summarizeDiagnostics([startup, health, logs]),
    artifacts,
  };
}

async function runLocalStrategy(
  strategy: RuntimeStrategy,
  attemptDir: string,
  workspaceRoot: string,
  hardCheck: Required<Pick<HardCheckConfig, 'startupTimeoutMs' | 'stableWindowMs' | 'healthUrl'>> & HardCheckConfig,
  onChunk: (chunk: string) => void,
  cancellationToken: vscode.CancellationToken | undefined,
  env: Record<string, string>,
): Promise<{ ok: boolean; timedOut: boolean; summary: string; diagnostics: string; artifacts: string[] }> {
  const artifacts: string[] = [];
  const commandResults: CommandResult[] = [];

  if (strategy.installCommand && shouldRunInstall(workspaceRoot, strategy.kind)) {
    const install = await runCommand(strategy.installCommand, workspaceRoot, env, hardCheck.startupTimeoutMs, onChunk, cancellationToken, '[hard-check][install]');
    commandResults.push(install);
    artifacts.push(writeCommandLog(attemptDir, 'install', install));
    if (install.exitCode !== 0 || install.timedOut) {
      return {
        ok: false,
        timedOut: install.timedOut,
        summary: install.timedOut ? 'dependency installation timed out' : `dependency installation failed with exit code ${install.exitCode}`,
        diagnostics: summarizeDiagnostics(commandResults),
        artifacts,
      };
    }
  }

  if (strategy.buildCommand) {
    const build = await runCommand(strategy.buildCommand, workspaceRoot, env, hardCheck.startupTimeoutMs, onChunk, cancellationToken, '[hard-check][build]');
    commandResults.push(build);
    artifacts.push(writeCommandLog(attemptDir, 'build', build));
    if (build.exitCode !== 0 || build.timedOut) {
      return {
        ok: false,
        timedOut: build.timedOut,
        summary: build.timedOut ? 'build command timed out' : `build command failed with exit code ${build.exitCode}`,
        diagnostics: summarizeDiagnostics(commandResults),
        artifacts,
      };
    }
  }

  const start = await startLocalProcess(strategy.startCommand, workspaceRoot, env, hardCheck.startupTimeoutMs, hardCheck.stableWindowMs, onChunk, cancellationToken, '[hard-check][run]');
  commandResults.push(start);
  artifacts.push(writeCommandLog(attemptDir, 'runtime', start));

  let healthOk = false;
  if (!start.timedOut && start.exitCode === 0 && start.child) {
    if (strategy.healthCommand) {
      const health = await runCommand(strategy.healthCommand, workspaceRoot, env, 20_000, onChunk, cancellationToken, '[hard-check][health]');
      commandResults.push(health);
      artifacts.push(writeCommandLog(attemptDir, 'health', health));
      healthOk = health.exitCode === 0 && !hasObviousErrors(health.stdout + '\n' + health.stderr);
    } else if (strategy.healthUrl) {
      healthOk = await probeHealthUrl(strategy.healthUrl, onChunk, cancellationToken);
      writeAttemptLog(attemptDir, 'health.log', `Health URL: ${strategy.healthUrl}\nResult: ${healthOk ? 'ok' : 'failed'}\n`);
      artifacts.push(path.join(attemptDir, 'health.log'));
    } else {
      healthOk = !hasObviousErrors(start.stdout + '\n' + start.stderr);
    }

    await stopChild(start.child);
  }

  return {
    ok: !start.timedOut && start.exitCode === 0 && healthOk,
    timedOut: start.timedOut,
    summary: start.timedOut
      ? 'local startup timed out'
      : start.exitCode !== 0
        ? `startup command exited with code ${start.exitCode}`
        : healthOk
          ? 'local application stayed alive and passed health verification'
          : 'startup stayed alive but health verification failed',
    diagnostics: summarizeDiagnostics(commandResults),
    artifacts,
  };
}

async function askModelToFix(opts: {
  step: StepConfig;
  model: ModelInfo;
  cli?: CliInfo;
  prompt: string;
  extraPrompt: string;
  workspaceRoot: string;
  onChunk: (chunk: string) => void;
  cancellationToken?: vscode.CancellationToken;
  env?: Record<string, string>;
  hardCheck: HardCheckConfig;
}): Promise<StepRunResult> {
  const prompt = `${opts.prompt}\n\n${opts.extraPrompt}\n\n# OUTPUT\nMake the necessary file changes directly in the workspace. End with the required agenticflow JSON block.`;
  return runStep({
    cli: opts.cli,
    model: opts.model,
    prompt,
    workspaceRoot: opts.workspaceRoot,
    onChunk: chunk => opts.onChunk(`[hard-check][model] ${chunk}`),
    cancellationToken: opts.cancellationToken,
    env: { ...(opts.env ?? {}), ...(opts.hardCheck.env ?? {}) },
  });
}

function buildPreparationPrompt(basePrompt: string, step: StepConfig, workspaceRoot: string): string {
  const skill = step.skill ? readSkill(step.skill) : '';
  return [
    '# HARD-CHECK PREPARATION',
    skill ? `Skill reminder:\n${skill}` : '',
    `Workspace root: ${workspaceRoot}`,
    'No reliable startup strategy was detected from the current files.',
    'Create or adjust only the minimum runtime artifacts needed to make the project runnable.',
    'Prefer existing conventions in the repository. Reuse existing docker, compose, package scripts or framework conventions when present.',
    'If Docker is already partially present, complete/fix that path. Otherwise choose the simplest reliable runtime path.',
    'Do not just describe what to do. Apply the changes directly.',
    'Base context follows for reference:',
    truncate(basePrompt, 6_000),
  ].filter(Boolean).join('\n\n');
}

function buildFixPrompt(
  basePrompt: string,
  step: StepConfig,
  strategy: RuntimeStrategy,
  attempt: number,
  maxAttempts: number,
  diagnostics: string,
): string {
  const skill = step.skill ? readSkill(step.skill) : '';
  return [
    '# HARD-CHECK FAILURE',
    skill ? `Skill reminder:\n${skill}` : '',
    `Attempt: ${attempt}/${maxAttempts}`,
    `Detected runtime strategy: ${strategy.label}`,
    'The application failed to boot cleanly. Read the diagnostics below and fix the real startup blockers.',
    'Focus on configuration, dependencies, scripts, docker/compose files, environment, migrations/bootstrap, ports and obvious runtime exceptions.',
    'Apply the fixes directly in the workspace, then stop.',
    '# DIAGNOSTICS',
    truncate(diagnostics, 10_000),
    '# ORIGINAL CONTEXT',
    truncate(basePrompt, 6_000),
  ].filter(Boolean).join('\n\n');
}

function buildHardCheckOutput(opts: {
  stepId: string;
  status: 'ok' | 'issues' | 'blocked';
  summary: string;
  findings: Array<{ severity: 'critical' | 'high' | 'medium' | 'low' | 'info'; title: string; recommendation?: string }>;
  artifacts: string[];
  notes: string[];
}): string {
  const notesText = opts.notes.filter(Boolean).map(note => `- ${note}`).join('\n');
  return [
    '# Runtime Hard Check',
    opts.summary,
    notesText ? `\n## Notes\n${notesText}` : '',
    '',
    '```agenticflow',
    JSON.stringify({
      stepId: opts.stepId,
      status: opts.status,
      summary: opts.summary,
      decisions: [],
      constraints: [],
      artifacts: Array.from(new Set(opts.artifacts.filter(Boolean))),
      nextActions: opts.status === 'ok' ? [] : ['Review the hard-check artifacts and fix the startup path or override the hardCheck commands.'],
      findings: opts.findings,
    }, null, 2),
    '```',
  ].join('\n');
}

function normalizeHardCheckConfig(config?: HardCheckConfig) {
  return {
    strategy: config?.strategy ?? 'auto',
    maxAttempts: Math.max(1, Math.min(config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 6)),
    startupTimeoutMs: Math.max(15_000, config?.startupTimeoutMs ?? DEFAULT_TIMEOUT_MS),
    stableWindowMs: Math.max(5_000, config?.stableWindowMs ?? DEFAULT_STABLE_WINDOW_MS),
    healthUrl: config?.healthUrl ?? '',
    installCommand: config?.installCommand ?? '',
    buildCommand: config?.buildCommand ?? '',
    startCommand: config?.startCommand ?? '',
    healthCommand: config?.healthCommand ?? '',
    logCommand: config?.logCommand ?? '',
    teardownCommand: config?.teardownCommand ?? '',
    env: config?.env ?? {},
  };
}

function detectPackageManager(workspaceRoot: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (fs.existsSync(path.join(workspaceRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(workspaceRoot, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(workspaceRoot, 'bun.lockb')) || fs.existsSync(path.join(workspaceRoot, 'bun.lock'))) return 'bun';
  return 'npm';
}

function inferNodeHealthUrl(script: string | undefined, packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): string | undefined {
  const full = `${script ?? ''} ${Object.keys(packageJson.dependencies ?? {}).join(' ')} ${Object.keys(packageJson.devDependencies ?? {}).join(' ')}`;
  const portMatch = full.match(/(?:--port|-p)\s+(\d{2,5})/);
  if (portMatch) return `http://127.0.0.1:${portMatch[1]}`;
  if (/vite/i.test(full)) return 'http://127.0.0.1:5173';
  if (/angular|ng serve/i.test(full)) return 'http://127.0.0.1:4200';
  if (/next|nuxt|react-scripts|vite preview|serve/i.test(full)) return 'http://127.0.0.1:3000';
  return undefined;
}

function shouldRunInstall(workspaceRoot: string, kind: StrategyKind): boolean {
  if (kind === 'local-node') return !fs.existsSync(path.join(workspaceRoot, 'node_modules'));
  if (kind === 'laravel') return !fs.existsSync(path.join(workspaceRoot, 'vendor'));
  return false;
}

async function hasCommand(command: string, cwd: string, env: Record<string, string>): Promise<boolean> {
  const probe = await runCommand(`command -v ${command}`, cwd, env, 5_000, () => {}, undefined, '[hard-check][probe]');
  return probe.exitCode === 0;
}

async function runCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  onChunk: (chunk: string) => void,
  cancellationToken: vscode.CancellationToken | undefined,
  prefix: string,
): Promise<CommandResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...env },
      shell: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        command,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    };

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      onChunk(`${prefix} ${text}`);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      onChunk(`${prefix} ${text}`);
    });

    child.on('error', reject);
    child.on('close', code => finish(code ?? (timedOut ? 124 : 1)));
    cancellationToken?.onCancellationRequested(() => {
      child.kill('SIGTERM');
      reject(new Error('Cancelled'));
    });
  });
}

async function startLocalProcess(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  stableWindowMs: number,
  onChunk: (chunk: string) => void,
  cancellationToken: vscode.CancellationToken | undefined,
  prefix: string,
): Promise<StartResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...env },
      shell: true,
    });

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let resolved = false;
    let timedOut = false;

    const complete = (result: StartResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      clearTimeout(stable);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    const stable = setTimeout(() => {
      complete({
        command,
        exitCode: exitCode ?? 0,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        child,
      });
    }, stableWindowMs);

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      onChunk(`${prefix} ${text}`);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      onChunk(`${prefix} ${text}`);
    });

    child.on('error', reject);
    child.on('close', code => {
      exitCode = code ?? 1;
      complete({
        command,
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
    cancellationToken?.onCancellationRequested(() => {
      child.kill('SIGTERM');
      reject(new Error('Cancelled'));
    });
  });
}

async function runTeardown(
  strategy: RuntimeStrategy,
  workspaceRoot: string,
  env: Record<string, string>,
  onChunk: (chunk: string) => void,
  cancellationToken: vscode.CancellationToken | undefined,
  attemptDir: string,
  artifacts: string[],
): Promise<void> {
  if (!strategy.teardownCommand) return;
  const teardown = await runCommand(strategy.teardownCommand, workspaceRoot, env, 30_000, onChunk, cancellationToken, '[hard-check][teardown]');
  artifacts.push(writeCommandLog(attemptDir, 'teardown', teardown));
}

async function probeHealthUrl(
  url: string,
  onChunk: (chunk: string) => void,
  cancellationToken: vscode.CancellationToken | undefined,
): Promise<boolean> {
  for (let attempt = 1; attempt <= HEALTH_PROBE_RETRIES; attempt++) {
    if (cancellationToken?.isCancellationRequested) throw new Error('Cancelled');
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      onChunk(`[hard-check][health] GET ${url} -> ${response.status}\n`);
      if (response.status < 500) return true;
    } catch (error) {
      onChunk(`[hard-check][health] GET ${url} failed on attempt ${attempt}: ${String(error)}\n`);
    }
    await delay(2_000, cancellationToken);
  }
  return false;
}

function dockerLooksHealthy(psOutput: string, logsOutput: string, healthUrl?: string): boolean {
  const text = `${psOutput}\n${logsOutput}`;
  if (hasObviousErrors(text)) return false;
  if (/unhealthy|exited|dead|restart/i.test(psOutput)) return false;
  if (/healthy|running|up/i.test(psOutput)) return true;
  return Boolean(healthUrl) && !hasObviousErrors(logsOutput);
}

function hasObviousErrors(text: string): boolean {
  return ERROR_PATTERNS.some(pattern => pattern.test(text));
}

function summarizeDiagnostics(results: CommandResult[]): string {
  return results.map(result => {
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    return [
      `$ ${result.command}`,
      `exit=${result.exitCode}${result.timedOut ? ' timeout' : ''} durationMs=${result.durationMs}`,
      truncate(combined || '(no output)', LOG_TAIL_BYTES),
    ].join('\n');
  }).join('\n\n---\n\n');
}

function writeCommandLog(attemptDir: string, name: string, result: CommandResult): string {
  const file = path.join(attemptDir, `${name}.log`);
  writeAttemptLog(file, [
    `$ ${result.command}`,
    `exit=${result.exitCode}`,
    `durationMs=${result.durationMs}`,
    `timedOut=${result.timedOut}`,
    '',
    '# stdout',
    result.stdout,
    '',
    '# stderr',
    result.stderr,
  ].join('\n'));
  return file;
}

function writeAttemptLog(fileOrDir: string, maybeName?: string | undefined, maybeContent?: string): string {
  const file = maybeContent === undefined ? fileOrDir : path.join(fileOrDir, maybeName ?? 'log.txt');
  const content = maybeContent === undefined ? (maybeName ?? '') : maybeContent;
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function ensureLogDir(workspaceRoot: string, stepId: string): string {
  const root = getAgenticFlowDir() ?? path.join(workspaceRoot, '.agentic-flow');
  const dir = path.join(root, 'logs', stepId, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function relPath(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
}

function mergeTokenUsage(base: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (!next) return base;
  if (!base) return { ...next };
  return {
    inputTokens: (base.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (base.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (base.totalTokens ?? 0) + (next.totalTokens ?? 0),
    reasoningTokens: (base.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
    cachedInputTokens: (base.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
    cacheCreationInputTokens: (base.cacheCreationInputTokens ?? 0) + (next.cacheCreationInputTokens ?? 0),
    costUsd: roundUsd((base.costUsd ?? 0) + (next.costUsd ?? 0)),
    accounting: base.accounting === 'reported' && next.accounting === 'reported' ? 'reported' : 'estimated',
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 200))}\n\n...[truncated]...\n\n${text.slice(-180)}`;
}

function delay(ms: number, cancellationToken: vscode.CancellationToken | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    cancellationToken?.onCancellationRequested(() => {
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.killed || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  if (child.exitCode === null) child.kill('SIGKILL');
}
