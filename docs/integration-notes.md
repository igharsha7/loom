# Integration surfaces — verified live

These are not guesses: each surface below was verified against the locally installed
tool before the adapter was written. Re-verify when versions move.

## Claude Code (verified: v2.1.278, Agent SDK 0.3.283)

Loom drives the user's installed `claude` through the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`), one `query()` per turn, the way t3code does.
The SDK speaks the CLI's stream-json control protocol over stdio:

```
claude --output-format stream-json --verbose --input-format stream-json \
  --permission-prompt-tool stdio --setting-sources=user,project,local \
  --permission-mode <mode> [--resume=<session-id>] [--model <m>] [--mcp-config <json>]
stdin:  control_request {subtype: "initialize", appendSystemPrompt?}  → control_response
        {type: "user", message: {content: [{type: "text", text}]}}
stdout: system/init (session_id) · system/status (requesting | compacting) ·
        system/compact_boundary {pre_tokens, post_tokens} · assistant (content, usage) ·
        rate_limit_event {utilization 0–1, rateLimitType, resetsAt s} ·
        result (usage, total_cost_usd, modelUsage[*].contextWindow)
```

- `pathToClaudeCodeExecutable` points the SDK at the user's `claude`, so the
  signed-in version runs. `spawnClaudeCodeProcess` lets Loom spawn it in its own
  process group (quiescence for Brain), and capture stderr.
- `systemPrompt: {type: "preset", preset: "claude_code", append}` and
  `settingSources: ["user", "project", "local"]` reproduce an interactive
  `claude`; the SDK loads neither by default. The handoff briefing is `append`.
- Permissions: "ask" is `permissionMode: default` with `canUseTool` answered
  in-process by Loom's approval broker (no MCP shim); "auto" is `acceptEdits`;
  "bypass" is `bypassPermissions` with `allowDangerouslySkipPermissions`.
- Interrupt is the `interrupt` control request; the CLI answers with an
  `error_during_execution` result and exits. Loom reports `interrupted`, not an error.
- A resumed session that no longer exists: the CLI prints `No conversation found`
  and exits before reading the prompt. Loom starts a new session, or with Brain
  continuity reports `NativeSessionMissing` so Brain rebuilds into a new epoch.
- Context in use is the main thread's last response usage (input + cache read +
  cache creation + output); the window comes from the result's `modelUsage`.
- The SDK package pulls a platform binary as an optional dependency (~228 MB);
  Loom never runs it because `pathToClaudeCodeExecutable` is always set.

## Codex (verified: codex-cli 0.153.4)

Loom drives `codex app-server`, one process per turn: newline-delimited JSON-RPC
(`{id, method, params}`, no `jsonrpc` field), the protocol t3code uses.

```
initialize {clientInfo, capabilities: {experimentalApi: true}} → initialized
thread/start {cwd, sandbox, approvalPolicy, model?, config?}
  | thread/resume {threadId, excludeTurns: true, …same}
turn/start {threadId, input: [{type: "text", text, text_elements: []}], clientUserMessageId?}
… item/started · item/completed (agentMessage, reasoning, commandExecution, fileChange,
  mcpToolCall, webSearch, contextCompaction) · thread/tokenUsage/updated
  {total, last, modelContextWindow} · account/rateLimits/updated · error {willRetry}
turn/completed {turn: {id, status: completed | interrupted | failed, error}}
turn/interrupt {threadId, turnId}
```

- Sandbox and approvals per Loom mode: bypass → `danger-full-access` + `never`;
  auto → `workspace-write` + `never`; ask → `read-only` + `untrusted`, and each
  `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` is
  answered by Loom's approval broker. Requests Loom can't put to a person
  (elicitations, extra permissions) are declined rather than left waiting.
- Project MCP servers go in `thread/start` config as `mcp_servers.<key>`.
- Context in use is `last.totalTokens`; `inputTokens` already includes cached
  tokens and `outputTokens` includes reasoning, so neither is added twice.
- A missing thread on resume is an error response; Loom starts a new thread, or
  with Brain continuity reports `NativeSessionMissing`.
- The account's own default model comes from `~/.codex/config.toml`. A model the
  account can't use fails the turn with Codex's 400; `model/list` says which
  models the account offers.

## OpenCode (verified: v1.17.20)

`opencode serve --port <p> --hostname 127.0.0.1` per project dir, then HTTP:

| Purpose | Route |
|---|---|
| Health | `GET /api/health` |
| Create session | `POST /api/session` `{}` → `{ id: "ses…" }` |
| Send prompt | `POST /api/session/{id}/prompt` `{ "prompt": { "text": "…" } }` (async-admitted) |
| Wait for idle | `/api/session/{id}/wait` |
| Interrupt | `POST /api/session/{id}/interrupt` |
| Live events | `GET /event` (SSE) |
| Message detail | `GET /api/session/{id}/message/{messageID}` |

SSE event types Loom maps:
- `message.part.updated` (TextPart / ToolPart / PatchPart) → message, tool_call, file_edit
- `message.updated` with assistant `time.completed` → turn complete
- `permission.asked` / `question.asked` → **needs_input** (drives notifications)

Notes:
- Older docs say `POST /session/:id/message` and `/abort` — **wrong for 1.17.x**; it's
  `/prompt` and `/interrupt`.
- No per-prompt system-prompt field, so Loom prepends the handoff briefing to the first
  prompt after a handoff, clearly delimited.

Dogfood findings (verified live on 1.17.20):
- **`/wait` returns 503** `{"_tag":"ServiceUnavailableError","message":"Session wait is
  not available yet"}` — it's in the OpenAPI spec but stubbed. Loom's adapter therefore
  detects turn completion by **polling the message list** for a new completed assistant
  message (SSE remains the live-streaming fast path), and reconciles any text the SSE
  stream missed from the message detail.
- **Turns can end in `finish: "error"`** with an `error.message` (e.g. a provider
  rejecting headless auth). The adapter surfaces these as Loom error events.
- **`serve` sessions don't inherit your TUI's model.** A session created with `{}` used
  `github-copilot/gpt-5.6-luna` (which fails headless: "Personal Access Tokens are not
  supported") while the TUI default was `opencode/minimax-m2.5`. Set the model
  explicitly in the agent options: `{ "model": "opencode/minimax-m2.5" }`.
- Loom strips inherited `CLAUDE_CODE_*` / session `ANTHROPIC_BASE_URL` env before
  spawning agents — running `loom` from inside a Claude Code terminal otherwise poisons
  nested agent auth.

## Antigravity — the CDP bridge, and what replaced it (verified: `agy` 1.1.6)

**The bridge is withdrawn.** It is kept here because the spike is worth the record, not
because it is on offer.

The original integration drove the Antigravity IDE. Launched with a debug port, the app
exposes a Chromium DevTools endpoint:

- `GET http://127.0.0.1:{port}/json/version` — presence check
- `GET http://127.0.0.1:{port}/json` — target list (read-only visibility)

There was no stable send/interrupt/memory surface behind it, so it could only watch, which
put it in the **Bridge tier** — never the baton, projections delivered as a file the human
driving the GUI reads (`.loom/memory/antigravity.md`).

Google then shipped a headless CLI, and it graduated: `antigravity-cli` is a real adapter
that holds the baton and runs a turn to completion with no GUI in the loop
(`src/adapters/antigravity-cli.ts`). One process per turn:

```
agy -p "<text>" --dangerously-skip-permissions --add-dir <dir> \
    --model <model> --print-timeout <dur>
agy -p "<text>" --conversation <id> …            (follow-up turns)
```

- `-p/--print` runs one prompt non-interactively and prints **only** the final assistant
  message (markdown) to stdout, then exits 0. There is no JSON event stream — so the
  adapter reports the final message plus the files it touched, parsed from the
  `[name](file://…)` links `agy` emits.
- No tokens and no cost come back, so turns report a model and a duration and nothing
  else. A price table would only produce a fabricated number rendered as fact.
- Conversations are keyed by working directory in
  `~/.gemini/antigravity-cli/cache/last_conversations.json`. The adapter reads the id back
  after a fresh turn and resumes it explicitly with `--conversation` from then on, so
  continuity survives another tool rewriting that mapping.
- `agy` leaves a language server holding the stdout pipe after it exits, so anything
  reading it must key off process exit rather than EOF.

The bridge's registration still exists — deleting it would stop any project that still
names `kind: "antigravity"` from opening at all — but it is in `WITHDRAWN_KINDS` and no
surface offers it (`src/adapters/index.ts`). The one remaining bridge is **Kiro**.
