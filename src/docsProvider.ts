// ─────────────────────────────────────────────────────────────
// docsProvider.ts  –  Bilingual documentation WebviewPanel
// ─────────────────────────────────────────────────────────────
import * as vscode from 'vscode';

export class AgenticFlowDocsPanel {
  static currentPanel: AgenticFlowDocsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (AgenticFlowDocsPanel.currentPanel) {
      AgenticFlowDocsPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'agenticFlowDocs',
      'Agentic Flow — Documentation',
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    AgenticFlowDocsPanel.currentPanel = new AgenticFlowDocsPanel(panel);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._panel.webview.html = getDocsHtml();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  dispose() {
    AgenticFlowDocsPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}

function getDocsHtml(): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agentic Flow — Documentation</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #cccccc);
    --muted: var(--vscode-descriptionForeground, #888);
    --border: var(--vscode-panel-border, #333);
    --accent: var(--vscode-textLink-foreground, #4fc1ff);
    --surface: var(--vscode-sideBar-background, #252526);
    --code-bg: var(--vscode-textCodeBlock-background, #1a1a2e);
    --warn-bg: rgba(255,200,0,0.08);
    --warn-border: rgba(255,200,0,0.3);
    --tip-bg: rgba(79,193,255,0.07);
    --tip-border: rgba(79,193,255,0.3);
    --success-bg: rgba(75,181,67,0.08);
    --success-border: rgba(75,181,67,0.3);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: 14px;
    line-height: 1.7;
    color: var(--fg);
    background: var(--bg);
    padding: 0;
  }
  .layout { display: flex; min-height: 100vh; }
  nav {
    width: 220px;
    min-width: 220px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    padding: 24px 0;
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
    flex-shrink: 0;
  }
  nav .nav-title {
    padding: 0 20px 16px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .1em;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
  }
  nav a {
    display: block;
    padding: 6px 20px;
    color: var(--muted);
    text-decoration: none;
    font-size: 13px;
    border-left: 2px solid transparent;
    transition: all 0.1s;
  }
  nav a:hover { color: var(--fg); background: rgba(255,255,255,0.04); }
  nav a.active { color: var(--accent); border-left-color: var(--accent); }
  .lang-bar {
    display: flex;
    gap: 6px;
    padding: 12px 20px 0;
    margin-bottom: 8px;
  }
  .lang-btn {
    padding: 3px 10px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .lang-btn.active {
    background: var(--accent);
    color: #000;
    border-color: var(--accent);
    font-weight: 600;
  }
  main { flex: 1; padding: 40px 48px; max-width: 820px; }
  h1 { font-size: 26px; font-weight: 700; margin-bottom: 8px; color: var(--fg); }
  h2 { font-size: 18px; font-weight: 700; margin: 40px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  h3 { font-size: 14px; font-weight: 700; margin: 24px 0 8px; color: var(--accent); }
  p { margin-bottom: 12px; }
  ul, ol { padding-left: 20px; margin-bottom: 12px; }
  li { margin-bottom: 4px; }
  code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    background: var(--code-bg);
    padding: 2px 6px;
    border-radius: 4px;
    color: var(--accent);
  }
  pre {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    background: var(--code-bg);
    padding: 14px 16px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 12px 0;
    line-height: 1.5;
    color: var(--fg);
  }
  table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 13px; }
  th { text-align: left; padding: 8px 12px; background: var(--surface); border-bottom: 2px solid var(--border); font-weight: 600; }
  td { padding: 7px 12px; border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: none; }
  .callout {
    padding: 12px 16px;
    border-radius: 6px;
    margin: 14px 0;
    font-size: 13px;
    border-left: 3px solid;
  }
  .callout.tip    { background: var(--tip-bg);     border-color: var(--accent); }
  .callout.warn   { background: var(--warn-bg);    border-color: rgba(255,200,0,0.6); }
  .callout.ok     { background: var(--success-bg); border-color: rgba(75,181,67,0.6); }
  .callout strong { display: block; margin-bottom: 4px; }
  .subtitle { color: var(--muted); font-size: 14px; margin-bottom: 32px; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    background: var(--surface);
    border: 1px solid var(--border);
    margin-right: 4px;
  }
  section { margin-bottom: 8px; }
  [data-lang] { display: none; }
  [data-lang].visible { display: block; }
</style>
</head>
<body>
<div class="layout">

<nav>
  <div class="nav-title">Agentic Flow</div>
  <div class="lang-bar">
    <button class="lang-btn active" onclick="setLang('en')" id="btn-en">EN</button>
    <button class="lang-btn" onclick="setLang('it')" id="btn-it">IT</button>
  </div>
  <a href="#overview">Overview</a>
  <a href="#first-run">First Run</a>
  <a href="#presets">Presets</a>
  <a href="#evolutive">Evolutive & Hotfix</a>
  <a href="#rerun">Re-run Step</a>
  <a href="#micro">Quick Actions</a>
  <a href="#repo-md">REPO.md</a>
  <a href="#models">Model Router</a>
  <a href="#git">Git Context</a>
  <a href="#flow-diagram">Flow Diagram</a>
</nav>

<main>

<!-- ══════════════════════════════════════════════════════════ -->
<!-- ENGLISH -->
<!-- ══════════════════════════════════════════════════════════ -->
<div data-lang="en" class="visible">

<h1>⚡ Agentic Flow</h1>
<p class="subtitle">AI-orchestrated development pipeline — from specification to working code.</p>

<section id="overview">
<h2>Overview</h2>
<p>Agentic Flow orchestrates multiple AI agents through a structured pipeline. Instead of chatting directly with a model, you write a requirement and the extension runs a sequence of specialised steps — each with its own prompt, model, and skill — producing structured output at every stage.</p>
<p>Key principles:</p>
<ul>
  <li><strong>Structured pipeline</strong> — each step receives a compact context of prior steps, not the full chat history</li>
  <li><strong>Model-per-step</strong> — assign different models to different steps (planning vs. generation vs. review)</li>
  <li><strong>Persistent session</strong> — the full history is saved in <code>.agentic-flow/</code> and survives restarts</li>
  <li><strong>REPO.md</strong> — auto-generated project context injected into every subsequent run</li>
</ul>
</section>

<section id="first-run">
<h2>First Run</h2>
<p>To generate a project from scratch:</p>
<ol>
  <li>Open the Agentic Flow panel from the activity bar</li>
  <li>Choose a preset from the pipeline configuration (⚙ button): <strong>Standard</strong> is recommended for first runs</li>
  <li>Describe what you want to build in the textarea</li>
  <li>Click <strong>Run</strong></li>
</ol>
<p>The pipeline will execute each enabled step in sequence. Each step card shows the model used, duration, token usage, a summary, and any findings.</p>
<div class="callout tip"><strong>Tip</strong>The <strong>Standard</strong> preset includes architecture review and a formal pre-check before coding — this prevents most implementation mistakes early.</div>
</section>

<section id="presets">
<h2>Presets</h2>
<table>
  <tr><th>Preset</th><th>Steps</th><th>Best for</th></tr>
  <tr><td><strong>Lite</strong></td><td>spec → implement → review → fix → report</td><td>Fast iterations, small changes</td></tr>
  <tr><td><strong>Standard</strong></td><td>spec → architecture → pre-check → implement → review → fix → report</td><td>New features, balanced</td></tr>
  <tr><td><strong>Full</strong></td><td>All steps including tests, security, docs, runtime check</td><td>Production-ready output</td></tr>
  <tr><td><strong>Evolutive</strong></td><td>diff-analysis → implement → review → fix → report</td><td>Changes on existing code</td></tr>
  <tr><td><strong>Hotfix</strong></td><td>diff-analysis → implement → fix → report</td><td>Urgent bug fixes</td></tr>
  <tr><td><strong>Custom</strong></td><td>Your own selection of steps</td><td>Any specific need</td></tr>
</table>
<p>Presets can be applied session-locally (affects only the next run) from the ⚙ pipeline config button, or saved persistently in the Workspace Configuration panel.</p>
</section>

<section id="evolutive">
<h2>Evolutive &amp; Hotfix Flows</h2>
<p>When you already have generated code and want to make changes, use the <strong>Continue</strong> button with an <strong>Evolutive</strong> or <strong>Hotfix</strong> preset.</p>
<h3>How Evolutive works</h3>
<p>The <strong>Diff Analysis</strong> step reads the current git state (staged changes, unstaged changes, recent commits) and produces a structured summary of scope, intent, and constraints. This feeds directly into the Implement step, which then applies your new requirement <em>respecting the existing code state</em>.</p>
<div class="callout ok"><strong>No git repo?</strong>The Diff Analysis step still runs but will note a clean/empty state. You can still use Evolutive — it will focus on the session history instead of git diffs.</div>
<h3>When to use which</h3>
<ul>
  <li><strong>Evolutive</strong> — new feature, refactoring, adding tests to existing code</li>
  <li><strong>Hotfix</strong> — urgent fix, minimal change, no architecture review needed</li>
  <li><strong>Lite (Continue)</strong> — small iterative additions where diff-analysis is overkill</li>
</ul>
</section>

<section id="rerun">
<h2>Re-run a Single Step</h2>
<p>After a completed run, each step card shows a <strong>↩</strong> button. Clicking it re-runs that step in isolation, using the same context as the original run (prior step summaries, git context, REPO.md).</p>
<p>Use this when:</p>
<ul>
  <li>The Implement step made a mistake and you want to regenerate it</li>
  <li>The Review step missed something and you want a second opinion</li>
  <li>The Fix step didn't fully resolve a finding</li>
</ul>
<div class="callout warn"><strong>Note</strong>Re-run does not re-run subsequent steps. If you re-run Implement, the Review step still shows the old result. Use a full Continue run to re-run the whole pipeline.</div>
</section>

<section id="micro">
<h2>Quick Actions (Micro-actions)</h2>
<p>The <strong>⚡ Quick Action</strong> button opens a lightweight overlay for single-instruction tasks — no pipeline, no structured output, direct model response.</p>
<h3>When to use it</h3>
<ul>
  <li>Ask a question about the codebase</li>
  <li>Generate a small code snippet</li>
  <li>Ask the model to explain a specific function</li>
  <li>Quick sanity check before starting a full run</li>
</ul>
<h3>Context toggle</h3>
<p>When <em>Include session context</em> is checked, the prompt is prefixed with:</p>
<ul>
  <li>The full <code>REPO.md</code> content (truncated to ~8000 chars)</li>
  <li>The current session title, iteration, and last objective</li>
</ul>
<p>Disable it for completely fresh, context-free queries.</p>
<h3>Model selection</h3>
<p>You can pick any available model — different from the one configured for the pipeline. Use a fast model (Haiku, GPT-mini) for quick questions and a powerful model (Opus, GPT-5) for complex tasks.</p>
<div class="callout tip"><strong>Quick actions are logged</strong>Each micro-action is saved to the session history (last 50) in <code>.agentic-flow/session.json</code>.</div>
</section>

<section id="repo-md">
<h2>REPO.md — Project Context File</h2>
<p>After every completed pipeline run, Agentic Flow automatically writes <code>.agentic-flow/REPO.md</code>. This file contains:</p>
<ul>
  <li>All objectives across all iterations</li>
  <li>Architectural decisions made by the agent</li>
  <li>Constraints identified and enforced</li>
  <li>All artifacts (files) created</li>
  <li>Open findings from the latest run</li>
  <li>Run history table</li>
  <li>All files touched across all runs</li>
  <li>Instructions for restarting the flow</li>
</ul>
<p>This file is <strong>automatically injected</strong> into every step prompt (truncated to 600 tokens) so agents always have project context without re-reading the whole codebase.</p>
<div class="callout ok"><strong>Fresh clone?</strong>If you clone a repo that has <code>.agentic-flow/REPO.md</code>, the extension will pick it up immediately on the next run. New agents will have full project history from day one.</div>
<p>You can also generate it on demand with the command <code>Agentic Flow: Generate REPO.md</code> from the Command Palette.</p>
</section>

<section id="models">
<h2>Model Router</h2>
<p>In the Workspace Configuration panel, you can assign models to <em>step categories</em> instead of per-step:</p>
<table>
  <tr><th>Category</th><th>Steps that use it</th><th>Suggested model</th></tr>
  <tr><td>planning</td><td>diff-analysis, spec, architecture, implementation-plan</td><td>Claude Opus, GPT-5</td></tr>
  <tr><td>generation</td><td>implement, fix</td><td>Claude Sonnet, GPT-5</td></tr>
  <tr><td>review</td><td>formal-precheck, review, security</td><td>GPT-5.4, Claude Sonnet</td></tr>
  <tr><td>verification</td><td>test, hard-check</td><td>Claude Sonnet</td></tr>
  <tr><td>reporting</td><td>docs, final-report</td><td>GPT-5.4-mini, Haiku</td></tr>
</table>
<p>Priority: step's explicit model → category router → global default model.</p>
</section>

<section id="git">
<h2>Git Context</h2>
<p>When a git repository is detected, Agentic Flow captures a snapshot at run start:</p>
<ul>
  <li>Current branch</li>
  <li>Working tree status (<code>git status --porcelain</code>)</li>
  <li>Staged diff (<code>git diff --cached</code>)</li>
  <li>Unstaged diff (<code>git diff</code>)</li>
  <li>Recent commits (<code>git log --oneline -5</code>)</li>
</ul>
<p>This snapshot is injected once into every step prompt as a <code># GIT CONTEXT</code> section. Configure token budget and commit count in the Workspace Configuration panel.</p>
<div class="callout tip"><strong>No git repo?</strong>The extension detects this automatically and skips git context injection entirely. No errors, no warnings — it simply doesn't appear in the prompt.</div>
</section>

<section id="flow-diagram">
<h2>Flow Diagram</h2>
<pre>
┌─────────────────── FIRST RUN ────────────────────┐
│  Write requirement → Run (Standard preset)        │
│                                                   │
│  Spec → Architecture → Pre-check →               │
│  Implement → Review → Fix → Final Report          │
│                                                   │
│  ✓ REPO.md written to .agentic-flow/             │
└───────────────────────────────────────────────────┘
         │
         ▼ next change
┌─────────────────── CONTINUE ─────────────────────┐
│  Write new requirement → Continue (Evolutive)     │
│                                                   │
│  Diff-Analysis → Implement → Review →            │
│  Fix → Final Report                               │
│                                                   │
│  ✓ REPO.md updated                               │
└───────────────────────────────────────────────────┘
         │
         ▼ small task
┌─────────────────── QUICK ACTION ─────────────────┐
│  ⚡ button → pick model → type instruction        │
│  → optional context → direct response             │
│                                                   │
│  No pipeline. No REPO.md update.                 │
└───────────────────────────────────────────────────┘
         │
         ▼ one step wrong
┌─────────────────── RE-RUN STEP ──────────────────┐
│  Click ↩ on any completed step card               │
│  → re-runs that step with original context        │
│                                                   │
│  Does not re-run subsequent steps.               │
└───────────────────────────────────────────────────┘
</pre>
</section>

</div><!-- /en -->

<!-- ══════════════════════════════════════════════════════════ -->
<!-- ITALIANO -->
<!-- ══════════════════════════════════════════════════════════ -->
<div data-lang="it">

<h1>⚡ Agentic Flow</h1>
<p class="subtitle">Pipeline di sviluppo orchestrata da AI — dalla specifica al codice funzionante.</p>

<section id="overview">
<h2>Panoramica</h2>
<p>Agentic Flow orchestra più agenti AI attraverso una pipeline strutturata. Invece di chattare direttamente con un modello, scrivi un requisito e l'estensione esegue una sequenza di step specializzati — ognuno con il proprio prompt, modello e skill — producendo output strutturato ad ogni fase.</p>
<p>Principi chiave:</p>
<ul>
  <li><strong>Pipeline strutturata</strong> — ogni step riceve un contesto compatto degli step precedenti, non l'intera chat</li>
  <li><strong>Modello per step</strong> — assegna modelli diversi a step diversi (pianificazione vs. generazione vs. review)</li>
  <li><strong>Sessione persistente</strong> — la cronologia completa è salvata in <code>.agentic-flow/</code> e sopravvive ai riavvii</li>
  <li><strong>REPO.md</strong> — contesto di progetto generato automaticamente e iniettato in ogni run successivo</li>
</ul>
</section>

<section id="first-run">
<h2>Primo Run</h2>
<p>Per generare un progetto da zero:</p>
<ol>
  <li>Apri il pannello Agentic Flow dalla barra delle attività</li>
  <li>Scegli un preset dalla configurazione pipeline (pulsante ⚙): <strong>Standard</strong> è consigliato per i primi run</li>
  <li>Descrivi cosa vuoi costruire nella textarea</li>
  <li>Clicca <strong>Run</strong></li>
</ol>
<p>La pipeline eseguirà ogni step abilitato in sequenza. Ogni card di step mostra il modello usato, la durata, i token, un riepilogo e gli eventuali findings.</p>
<div class="callout tip"><strong>Suggerimento</strong>Il preset <strong>Standard</strong> include una revisione architetturale e un pre-check formale prima della codifica — questo previene la maggior parte degli errori di implementazione.</div>
</section>

<section id="presets">
<h2>Preset</h2>
<table>
  <tr><th>Preset</th><th>Step</th><th>Adatto per</th></tr>
  <tr><td><strong>Lite</strong></td><td>spec → implement → review → fix → report</td><td>Iterazioni veloci, piccole modifiche</td></tr>
  <tr><td><strong>Standard</strong></td><td>spec → architecture → pre-check → implement → review → fix → report</td><td>Nuove funzionalità, bilanciato</td></tr>
  <tr><td><strong>Full</strong></td><td>Tutti gli step inclusi test, sicurezza, docs, runtime check</td><td>Output pronto per la produzione</td></tr>
  <tr><td><strong>Evolutive</strong></td><td>diff-analysis → implement → review → fix → report</td><td>Modifiche su codice esistente</td></tr>
  <tr><td><strong>Hotfix</strong></td><td>diff-analysis → implement → fix → report</td><td>Fix urgenti di bug</td></tr>
  <tr><td><strong>Custom</strong></td><td>Selezione personalizzata di step</td><td>Qualsiasi esigenza specifica</td></tr>
</table>
<p>I preset possono essere applicati localmente (solo al prossimo run) dal pulsante ⚙ configurazione pipeline, oppure salvati in modo persistente nel pannello Workspace Configuration.</p>
</section>

<section id="evolutive">
<h2>Flussi Evolutive &amp; Hotfix</h2>
<p>Quando hai già del codice generato e vuoi fare modifiche, usa il pulsante <strong>Continue</strong> con un preset <strong>Evolutive</strong> o <strong>Hotfix</strong>.</p>
<h3>Come funziona Evolutive</h3>
<p>Lo step <strong>Diff Analysis</strong> legge lo stato git corrente (modifiche staged, unstaged, commit recenti) e produce un riepilogo strutturato di scope, intenzione e vincoli. Questo viene passato direttamente allo step Implement, che applica il nuovo requisito <em>rispettando lo stato corrente del codice</em>.</p>
<div class="callout ok"><strong>Nessun repo git?</strong>Lo step Diff Analysis viene eseguito lo stesso ma noterà uno stato pulito/vuoto. Puoi comunque usare Evolutive — si concentrerà sulla cronologia della sessione invece che sui diff git.</div>
<h3>Quando usare quale</h3>
<ul>
  <li><strong>Evolutive</strong> — nuova funzionalità, refactoring, aggiunta di test al codice esistente</li>
  <li><strong>Hotfix</strong> — fix urgente, modifica minimale, nessuna revisione architetturale necessaria</li>
  <li><strong>Lite (Continue)</strong> — piccole aggiunte iterative dove diff-analysis è eccessivo</li>
</ul>
</section>

<section id="rerun">
<h2>Re-run di un Singolo Step</h2>
<p>Dopo un run completato, ogni card di step mostra un pulsante <strong>↩</strong>. Cliccandolo si riesegue quello step in isolamento, usando lo stesso contesto del run originale (riepiloghi degli step precedenti, contesto git, REPO.md).</p>
<p>Usalo quando:</p>
<ul>
  <li>Lo step Implement ha fatto un errore e vuoi rigenerarlo</li>
  <li>Lo step Review ha mancato qualcosa e vuoi un secondo parere</li>
  <li>Lo step Fix non ha risolto completamente un finding</li>
</ul>
<div class="callout warn"><strong>Nota</strong>Il re-run non riesegue gli step successivi. Se riesegui Implement, lo step Review mostra ancora il vecchio risultato. Usa un run Continue completo per rieseguire l'intera pipeline.</div>
</section>

<section id="micro">
<h2>Quick Actions (Micro-azioni)</h2>
<p>Il pulsante <strong>⚡ Quick Action</strong> apre un overlay leggero per istruzioni singole — nessuna pipeline, nessun output strutturato, risposta diretta del modello.</p>
<h3>Quando usarla</h3>
<ul>
  <li>Fare una domanda sul codebase</li>
  <li>Generare un piccolo snippet di codice</li>
  <li>Chiedere al modello di spiegare una funzione specifica</li>
  <li>Verifica rapida prima di avviare un run completo</li>
</ul>
<h3>Toggle del contesto</h3>
<p>Quando <em>Include session context</em> è attivo, il prompt viene prefissato con:</p>
<ul>
  <li>Il contenuto completo di <code>REPO.md</code> (troncato a ~8000 caratteri)</li>
  <li>Il titolo della sessione corrente, l'iterazione e l'ultimo obiettivo</li>
</ul>
<p>Disabilitalo per query completamente libere dal contesto.</p>
<h3>Selezione del modello</h3>
<p>Puoi scegliere qualsiasi modello disponibile — diverso da quello configurato per la pipeline. Usa un modello veloce (Haiku, GPT-mini) per domande rapide e uno potente (Opus, GPT-5) per compiti complessi.</p>
<div class="callout tip"><strong>Le quick action vengono registrate</strong>Ogni micro-azione viene salvata nella cronologia della sessione (ultime 50) in <code>.agentic-flow/session.json</code>.</div>
</section>

<section id="repo-md">
<h2>REPO.md — File di Contesto del Progetto</h2>
<p>Dopo ogni run completato, Agentic Flow scrive automaticamente <code>.agentic-flow/REPO.md</code>. Questo file contiene:</p>
<ul>
  <li>Tutti gli obiettivi in tutte le iterazioni</li>
  <li>Le decisioni architetturali prese dall'agente</li>
  <li>I vincoli identificati e applicati</li>
  <li>Tutti gli artifact (file) creati</li>
  <li>I findings aperti dall'ultimo run</li>
  <li>La tabella della cronologia dei run</li>
  <li>Tutti i file toccati in tutti i run</li>
  <li>Istruzioni per riavviare il flusso</li>
</ul>
<p>Questo file viene <strong>iniettato automaticamente</strong> in ogni prompt di step (troncato a 600 token) così gli agenti hanno sempre il contesto del progetto senza dover rileggere l'intero codebase.</p>
<div class="callout ok"><strong>Clone fresco?</strong>Se cloni un repo che ha <code>.agentic-flow/REPO.md</code>, l'estensione lo rileva immediatamente al prossimo run. I nuovi agenti avranno la cronologia completa del progetto dal primo giorno.</div>
<p>Puoi anche generarlo on demand con il comando <code>Agentic Flow: Generate REPO.md</code> dalla Command Palette.</p>
</section>

<section id="models">
<h2>Model Router</h2>
<p>Nel pannello Workspace Configuration puoi assegnare modelli a <em>categorie di step</em> invece che per singolo step:</p>
<table>
  <tr><th>Categoria</th><th>Step che la usano</th><th>Modello consigliato</th></tr>
  <tr><td>planning</td><td>diff-analysis, spec, architecture, implementation-plan</td><td>Claude Opus, GPT-5</td></tr>
  <tr><td>generation</td><td>implement, fix</td><td>Claude Sonnet, GPT-5</td></tr>
  <tr><td>review</td><td>formal-precheck, review, security</td><td>GPT-5.4, Claude Sonnet</td></tr>
  <tr><td>verification</td><td>test, hard-check</td><td>Claude Sonnet</td></tr>
  <tr><td>reporting</td><td>docs, final-report</td><td>GPT-5.4-mini, Haiku</td></tr>
</table>
<p>Priorità: modello esplicito dello step → router per categoria → modello di default globale.</p>
</section>

<section id="git">
<h2>Contesto Git</h2>
<p>Quando viene rilevato un repository git, Agentic Flow cattura uno snapshot all'avvio del run:</p>
<ul>
  <li>Branch corrente</li>
  <li>Stato dell'albero di lavoro (<code>git status --porcelain</code>)</li>
  <li>Diff staged (<code>git diff --cached</code>)</li>
  <li>Diff unstaged (<code>git diff</code>)</li>
  <li>Commit recenti (<code>git log --oneline -5</code>)</li>
</ul>
<p>Questo snapshot viene iniettato una volta in ogni prompt di step come sezione <code># GIT CONTEXT</code>. Configura il budget di token e il numero di commit nel pannello Workspace Configuration.</p>
<div class="callout tip"><strong>Nessun repo git?</strong>L'estensione lo rileva automaticamente e salta completamente l'iniezione del contesto git. Nessun errore, nessun avviso — non appare semplicemente nel prompt.</div>
</section>

<section id="flow-diagram">
<h2>Diagramma del Flusso</h2>
<pre>
┌──────────────────── PRIMO RUN ────────────────────┐
│  Scrivi requisito → Run (preset Standard)          │
│                                                    │
│  Spec → Architecture → Pre-check →                │
│  Implement → Review → Fix → Final Report           │
│                                                    │
│  ✓ REPO.md scritto in .agentic-flow/              │
└────────────────────────────────────────────────────┘
         │
         ▼ modifica successiva
┌──────────────────── CONTINUE ─────────────────────┐
│  Scrivi nuovo requisito → Continue (Evolutive)     │
│                                                    │
│  Diff-Analysis → Implement → Review →             │
│  Fix → Final Report                                │
│                                                    │
│  ✓ REPO.md aggiornato                             │
└────────────────────────────────────────────────────┘
         │
         ▼ compito piccolo
┌──────────────────── QUICK ACTION ─────────────────┐
│  Pulsante ⚡ → scegli modello → scrivi istruzione  │
│  → contesto opzionale → risposta diretta           │
│                                                    │
│  Nessuna pipeline. REPO.md non aggiornato.        │
└────────────────────────────────────────────────────┘
         │
         ▼ uno step sbagliato
┌──────────────────── RE-RUN STEP ──────────────────┐
│  Clicca ↩ su qualsiasi card di step completato    │
│  → riesegue quello step con contesto originale     │
│                                                    │
│  Non riesegue gli step successivi.                │
└────────────────────────────────────────────────────┘
</pre>
</section>

</div><!-- /it -->

</main>
</div>

<script>
let currentLang = localStorage.getItem('af-docs-lang') || 'en';

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem('af-docs-lang', lang);
  document.querySelectorAll('[data-lang]').forEach(el => {
    el.classList.toggle('visible', el.dataset.lang === lang);
  });
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.id === 'btn-' + lang);
  });
  document.documentElement.lang = lang;
}

// Highlight active nav link on scroll
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      document.querySelectorAll('nav a').forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === '#' + entry.target.id);
      });
    }
  }
}, { threshold: 0.3 });
document.querySelectorAll('section[id]').forEach(s => observer.observe(s));

setLang(currentLang);
</script>
</body>
</html>`;
}
