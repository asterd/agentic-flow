# Agentic Flow

> VS Code extension that orchestrates AI CLI agents through a configurable, session-based development pipeline.

The extension can run against local CLIs by default, and can optionally expose API-backed models from multiple providers in the same selectors.

## What it does

Agentic Flow is a pipeline orchestrator for capable local AI clients — Claude Code, Codex, Continue, Copilot, or VS Code LM providers. You write a requirement, assign different models to different steps, and the extension runs them in sequence.

Each step:
- receives compact structured context from prior steps (not raw chat history)
- writes its output as structured JSON + markdown summary
- tracks which files changed
- records model used, source used (CLI/API/VS Code LM), duration, token usage, and findings

Sessions are persistent. You can continue the same session with an additional requirement and the pipeline carries forward what it already knows.

## Pipeline

Default pipeline — each step can be toggled, reassigned to a different model, or given a custom skill file:

| # | Step | Default model |
|---|---|---|
| 1 | 📋 Refine Specification | claude-sonnet-4-6 |
| 2 | 🏛 Architecture Breakdown | claude-sonnet-4-6 |
| 3 | 🗺 Development Plan _(full profile)_ | claude-sonnet-4-6 |
| 4 | 🧭 Formal Pre-Check | gpt-5.4 |
| 5 | 🛠 Implement | claude-sonnet-4-6 |
| 6 | 🔍 Technical Review | gpt-5.4 |
| 7 | 🧯 Fix Findings _(runs only if issues found)_ | claude-sonnet-4-6 |
| 8 | 🧪 Tests & Verification _(full profile)_ | claude-sonnet-4-6 |
| 9 | 🔒 Security Review _(full profile)_ | gpt-5.4 |
| 10 | 📚 Documentation _(full profile)_ | gpt-5.4-mini |
| 11 | 💥 Runtime Hard Check _(full profile / optional)_ | claude-sonnet-4-6 |
| 12 | ✅ Final Report | gpt-5.4-mini |

Recommended run profiles:

- `lite` — `spec`, `implement`, `review`, `fix`, `final-report`
- `standard` — `spec`, `architecture`, `formal-precheck`, `implement`, `review`, `fix`, `final-report`
- `full` — enables every step, including planning, test/security/docs, and hard-check

## Token strategy

- Step outputs are structured JSON — compact and machine-parseable
- Downstream steps receive `summary` mode by default: one dense block per prior step, token-budgeted
- Open findings are de-duplicated and sorted by severity before injection
- Context handoff can be limited per step via `contextStepIds`, so late-stage steps do not inherit irrelevant summaries
- Per-step context mode is configurable: `summary` / `full` / `none`

## UX notes

- Persistent configuration is anchored in the standard VS Code Settings UI
- The settings page links directly to the real workspace files under `.agentic-flow/`
- The sidebar focuses on runs and per-session overrides; model selectors are grouped by source
- API-backed runs report precise token usage when the provider exposes it
- API discovery now happens after activation, so a slow provider should no longer block the extension from loading
- Skill files can be opened directly from per-run overrides
- `Reset local settings` rebuilds `.agentic-flow/` from defaults for the current workspace
- The optional hard-check step can try to boot the generated app for real, collect logs under `.agentic-flow/logs/`, and retry with fixes when a CLI-backed model is used

## Workspace state

Everything lives under `.agentic-flow/` in your workspace:

```
.agentic-flow/
├── config.json          # pipeline definition and per-step settings
├── session.json         # session state, requirement history, run history
├── WORKFLOW_STATE.md    # human-readable summary of latest step outputs
├── runtime.env          # API keys and env vars (gitignored)
└── skills/              # editable skill prompts, one per step
```

## Supported runtimes

Auto-detected from `PATH`:

| CLI | Models |
|---|---|
| `claude` | Claude Opus/Sonnet/Haiku + custom via env |
| `codex` | GPT-5.x series (reads `~/.codex/models_cache.json`) |
| `cn` / `continue` | Any configured Continue model |
| `gh copilot` | Copilot GPT-4o, Copilot Claude Sonnet |
| VS Code LM API | Any extension-provided model (GitHub Copilot, etc.) |

Optional API providers from VS Code settings:

| Provider | Discovery | Auth |
|---|---|---|
| OpenAI | `/v1/models` | API key |
| Anthropic | curated Claude catalog | API key |
| xAI | `/v1/models` | API key |
| OpenRouter | `/v1/models` | API key |
| Ollama | `/api/tags` | local / no key by default |

Custom CLIs and local OpenAI-compatible servers can still be added in `config.json` under `runtime.customModels`.

## Runtime Hard Check

The optional `💥 Runtime Hard Check` step is a separate executor, not just another prompt. It tries to determine how the generated project should boot, runs it for real, captures logs, and if startup fails it can ask the selected model to fix the workspace and retry a bounded number of times.

The new `🧭 Formal Pre-Check` step runs before implementation and is meant to catch:

- mismatched producer/consumer contracts
- missing config or env assumptions
- hidden startup dependencies
- logic gaps and sequencing errors
- structural coupling that would make implementation brittle

For UI-heavy tasks, prefer assigning the optional skill [ui-direction.md](/Users/ddurzo/Development/misc/agentic-flow/skills/ui-direction.md) to `architecture` or `formal-precheck` instead of adding a permanent extra step to every run.

Current auto-detection order:

- existing `docker-compose.yml` / `compose.yaml`
- Node projects with `package.json` startup scripts such as `start`, `dev`, `serve`, `preview`
- Laravel projects with `artisan`

By default it writes attempt logs under:

```text
.agentic-flow/logs/hard-check/<timestamp>/attempt-<n>/
```

Advanced behavior can be overridden in `.agentic-flow/config.json`:

```json
{
  "id": "hard-check",
  "enabled": true,
  "model": "claude-sonnet-4-6",
  "executor": "hard-check",
  "hardCheck": {
    "strategy": "auto",
    "maxAttempts": 3,
    "startupTimeoutMs": 120000,
    "stableWindowMs": 12000,
    "healthUrl": "http://127.0.0.1:3000"
  }
}
```

Notes:

- `strategy: "auto"` prefers existing Docker/compose setups when present, otherwise falls back to local startup heuristics
- if the selected model is API-backed or VS Code LM-backed, the hard-check still verifies runtime, but self-healing retries are limited because those sources do not directly edit the workspace the way local CLI agents do
- you can force explicit commands with `installCommand`, `buildCommand`, `startCommand`, `healthCommand`, `logCommand`, and `teardownCommand` when auto-detection is not enough

## Runtime configuration

Global provider settings live in VS Code settings under `agenticFlow.apiProviders`.

Useful settings:

- `agenticFlow.apiProviders` configures OpenAI, Anthropic, xAI, OpenRouter, and Ollama API access
- `agenticFlow.workspaceStorageDir` changes where workspace-local files such as `config.json`, `runtime.env`, `session.json`, and `skills/` are stored
- `agenticFlow.extraCliPaths` adds extra directories for local CLI autodetection

Recommended key storage:

- Preferred: `Agentic Flow: Store Provider API Key` saves the key in VS Code secret storage
- Compatible fallback: `agenticFlow.apiProviders.<provider>.apiKey` in settings
- Workspace-local fallback: `.agentic-flow/runtime.env`

```json
{
  "agenticFlow.apiProviders": {
    "openai": {
      "enabled": true,
      "apiKey": "sk-...",
      "baseUrl": "https://api.openai.com/v1",
      "modelAllowList": ["gpt-5.4", "gpt-5.4-mini"]
    },
    "openrouter": {
      "enabled": true,
      "apiKey": "sk-or-...",
      "baseUrl": "https://openrouter.ai/api/v1"
    },
    "ollama": {
      "enabled": true,
      "baseUrl": "http://localhost:11434/v1"
    }
  }
}
```

Workspace runtime config remains available in `.agentic-flow/config.json`:

```json
{
  "runtime": {
    "envFiles": [".agentic-flow/runtime.env"],
    "env": {},
    "customModels": [
      {
        "id": "qwen2.5-coder-local",
        "modelName": "qwen2.5-coder:latest",
        "label": "Qwen 2.5 Coder (custom CLI route)",
        "cliId": "codex",
        "launchArgs": ["--oss", "--local-provider", "ollama"]
      }
    ]
  }
}
```

Common setups:
- **Local CLI auth only** — no extra config needed, extension detects installed CLIs
- **API key in VS Code settings** — set `agenticFlow.apiProviders`
- **API key per workspace** — put keys in `.agentic-flow/runtime.env`
- **Local OpenAI-compatible server** — set `OPENAI_BASE_URL` and add a custom model
- **Binary outside PATH** — set `agenticFlow.extraCliPaths` in VS Code settings

Model selection behavior:

- If the same family is available from multiple sources, the selector shows separate grouped entries such as `Local CLI · Anthropic` and `API · Anthropic`
- Existing configs that still reference plain model names continue to work; the extension resolves them to the best available source, preferring local CLI first
- API-backed runs store precise token usage when the provider returns it, while CLI-backed runs keep the existing estimated accounting
- OpenAI-compatible discovery applies a conservative filter so obvious non-chat endpoints like embeddings, moderation, TTS, Whisper, and image-generation models are not shown as runnable chat models

## Architecture

```
extension.ts
  ├── cliDetector.ts       detect installed CLIs and available models
  ├── configManager.ts     load/save config, session state, skill files
  ├── workflowEngine.ts    session lifecycle, step orchestration, file tracking
  │     ├── contextManager.ts   prompt assembly, structured output parsing
  │     └── stepRunner.ts       CLI subprocess or VS Code LM execution
  └── webviewProvider.ts   chat-style panel UI (sidebar)
```

---

## Commands

### Install dependencies

```bash
npm install
```

### Compile TypeScript

```bash
npm run compile
```

### Watch mode (recompile on save)

```bash
npm run watch
```

### Run the extension (isolated dev host)

Compila e apre una nuova finestra VS Code con l'estensione caricata, isolata dalle tue estensioni globali:

```bash
npm run compile && npm run dev:host
```

Una volta aperta la finestra, il plugin è visibile nella **Activity Bar a sinistra** — cerca l'icona ⚡ (fulmine). Cliccaci sopra per aprire il pannello Agentic Flow.

In alternativa: `Cmd+Shift+P` → `Agentic Flow: Open Pipeline`, oppure `Cmd+Shift+A`.

### Run with a clean empty workspace

Useful for testing the UI from scratch without an existing project:

```bash
npm run dev:host:workspace
```

### Package as `.vsix`

```bash
npm run package
```

This packages the extension with `vsce` and already includes the `--allow-missing-repository` safeguard used by CI.

### CI package output

```bash
npm run package:ci
```

This writes the packaged extension to `dist/` and is the same path used by GitHub Actions.

## CI / Releases

- Every push builds and packages a `.vsix` in GitHub Actions as a downloadable workflow artifact
- Pushes to `main` also refresh the GitHub prerelease `latest-build` with the newest `.vsix`
- CI rewrites the extension version only inside the runner to a unique prerelease form like `1.0.0-ci.42`, so each generated build is installable as a distinct package
- The workflow uses Node 24-native GitHub Actions (`checkout`, `setup-node`, `upload-artifact`) and the GitHub CLI for release publishing, so it no longer depends on deprecated Node 20 action runtimes
- Packaging includes a real extension icon and bundled MIT license, so `vsce package` succeeds cleanly in CI as well as locally
- The packaged `.vsix` excludes development-only folders like `.github/` and `.claude/`

---

## License

MIT
