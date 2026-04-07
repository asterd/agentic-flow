# Repository Structure

This repository contains a VS Code extension that orchestrates a multi-step AI workflow for end-to-end software delivery. The extension is intentionally small: most of the complexity lives in prompt shaping, step orchestration, and the webview UI.

## Top-level layout

```text
.
├── README.md
├── REPO.md
├── media/
├── skills/
├── src/
├── templates/
├── out/
├── package.json
└── tsconfig.json
```

## Key directories

### `src/`

The extension source code.

- `extension.ts`
  Bootstrap of the extension.
  Registers commands, initializes environment detection, wires the sidebar provider, and keeps the workflow engine instance alive.

- `cliDetector.ts`
  Detects installed AI runtimes and available models.
  Merges built-in CLIs, cached model metadata, custom runtime configuration, and VS Code LM models into a single runtime catalog.

- `configManager.ts`
  Owns workspace-local persistence under `.agentic-flow/`.
  Initializes the workspace defaults, loads and saves config/session state, resolves skill paths, and handles reset of local settings.

- `workflowEngine.ts`
  Orchestrates the pipeline execution.
  Applies per-run overrides, executes steps in order, emits UI events, snapshots file changes, and persists run history.

- `contextManager.ts`
  Builds prompts for each step with aggressive token discipline.
  Injects skill text, current objective, selected prior-step summaries, open findings, and any requested project file snippets.

- `stepRunner.ts`
  Executes one step through the selected runtime.
  Supports CLI-based execution and VS Code LM execution, and computes token estimates from prompt/output size.

- `types.ts`
  Shared domain types for config, steps, session state, run state, UI messaging, findings, and runtime metadata.

- `webviewProvider.ts`
  Defines the sidebar webview, its HTML/JS UI, event bridge, settings panels, and live rendering of workflow state.

### `skills/`

Default prompt templates for each pipeline step.

- These files are copied into each workspace under `.agentic-flow/skills/` on initialization.
- They are meant to stay concise because they are injected into prompts.
- The current default flow uses specialized skill files for:
  - specification
  - architecture
  - implementation planning
  - coding
  - review
  - remediation
  - testing
  - security
  - documentation
  - final reporting

### `templates/`

Workspace bootstrap assets.

- `templates/config.json`
  Reference config used as the default shape for the workspace-local `.agentic-flow/config.json`.

### `media/`

Static assets for the webview UI.

- `panel.css`
  Entire styling for the sidebar and settings overlays.
- icons
  Activity bar and extension-facing assets.

### `out/`

Compiled JavaScript emitted by TypeScript.

- This is the runtime entry used by VS Code.
- It should be treated as build output, not hand-edited source.

## Runtime data inside a user workspace

When the extension initializes a workspace, it creates:

```text
.agentic-flow/
├── config.json
├── session.json
├── WORKFLOW_STATE.md
├── runtime.env
└── skills/
```

Purpose of each file:

- `config.json`
  Pipeline definition and runtime configuration for this workspace.
- `session.json`
  Persistent session history and aggregated run summaries.
- `WORKFLOW_STATE.md`
  Human-readable step summaries used both for inspection and context reconstruction.
- `runtime.env`
  Workspace-local environment variables for model providers or local endpoints.
- `skills/`
  Editable copies of the default skill prompts.

## Main execution flow

### 1. Activation

`extension.ts` refreshes the environment and registers the sidebar provider plus commands.

### 2. Workspace initialization

On `ready`, the webview asks the extension to ensure `.agentic-flow/` exists. `configManager.ts` creates config, runtime env, and local skill copies if missing.

### 3. Run start

The webview sends `startRun` with:

- task text
- run mode (`new` or `continue`)
- optional per-run step overrides

### 4. Step execution

For each enabled step:

1. `workflowEngine.ts` resolves model and CLI
2. `contextManager.ts` builds the prompt
3. `stepRunner.ts` runs the model
4. output is parsed into structured JSON
5. file changes are detected
6. session state and workflow summary are persisted
7. events are streamed back to the webview

### 5. UI update

The webview receives:

- `runState`
- `stepLog`
- `sessionUpdated`
- `configSaved`
- `error`

and updates the sidebar in place.

## Token-efficiency design

The repository already reflects a token-minimization strategy:

- step outputs are normalized into a compact JSON schema
- later steps default to `summary` context instead of raw output
- open findings are de-duplicated and severity-filtered
- `contextStepIds` can restrict which earlier steps are injected into a later prompt
- skills are kept small and focused rather than monolithic

## UI architecture

The UI is not React-based. It is a plain webview page generated from TypeScript as a single HTML string with:

- semantic-ish layout in `getWebviewHtml`
- direct DOM updates
- message-based bridge to the extension host
- CSS-only styling in `media/panel.css`

This keeps the extension lightweight, but it also means UI behavior is centralized in one large file. Most UI fixes will touch `src/webviewProvider.ts` and `media/panel.css` together.

## Configuration model

There are two levels of configuration:

- Global workspace config
  Persisted in `.agentic-flow/config.json`
- Session-local overrides
  Applied only to the next run from the sidebar panel and not written back to disk

Each step can currently vary on:

- enabled/disabled
- model
- skill path
- context mode
- optional `contextStepIds`
- optional run condition such as `ifIssues`

## Development workflow

Common commands:

```bash
npm install
npm run compile
npm run watch
npm run dev:host
```

If you change:

- `src/*`: recompile
- `media/*`: reload the extension host window
- `skills/*` or `templates/*`: reinitialize/reset a workspace if you want local copies updated

## Known structural tradeoffs

- `webviewProvider.ts` contains both extension-side bridge code and large inline client-side UI logic.
- Token accounting is estimated from text length, not provider billing metadata.
- The extension assumes a single-root workspace.
- File change tracking is snapshot-based and ignores `.agentic-flow/`, `node_modules/`, `.git/`, and `out/`.

## Where to modify specific behavior

- Add or change pipeline steps:
  `src/configManager.ts`, `templates/config.json`, `skills/`

- Change prompt/context composition:
  `src/contextManager.ts`

- Change runtime/model detection:
  `src/cliDetector.ts`

- Change workflow execution semantics:
  `src/workflowEngine.ts`, `src/stepRunner.ts`

- Change sidebar behavior or settings UX:
  `src/webviewProvider.ts`, `media/panel.css`

- Change extension commands or activation:
  `src/extension.ts`
