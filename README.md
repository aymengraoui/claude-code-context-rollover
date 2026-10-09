# context-rollover

A Claude Code mod that rolls long-running work — including multi-agent work — over into **genuinely fresh sessions** before the context grows too large, and carries the **project's state** (not the conversation) across.

```
Session A ──soft──▶ preparing ──prepare──▶ ready ──turn ends──▶ persist ─▶ /clear ─▶ Session B ─▶ … ─▶ Session C
                                              └──hard, mid-turn──▶ drain ──┘
```

It publishes its whole lifecycle as shared state, which the [Cockpit](../claude-code-cockpit) sidebar draws as a **CONTEXT ROLLOVER** block.

## Install

The mod is a plugin folder loaded the same way as the Cockpit: list both folders in `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`. The separator is `;` on Windows and `:` elsewhere.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:/Users/UltraPc/Desktop/Code/claude-code-cockpit;C:/Users/UltraPc/Desktop/Code/claude-code-context-rollover"
  }
}
```

Start a new Claude Code session; the mod loads at startup. For a one-off session use `claude --plugin-dir <this folder>`.

## Use

It runs by itself. `/rollover` gives you control:

| Command | What it does |
| --- | --- |
| `/rollover` or `/rollover status` | The state in words: phase, context, thresholds, handoff, last outcome, error |
| `/rollover now` | Roll over now, whatever the context |
| `/rollover resume [id]` | Restore a saved continuation into this (fresh) session — the newest unrestored one when no id is given |
| `/rollover cancel` | Stand a pending rollover down and lift the gate (not once the restart has begun) |
| `/rollover config` | The effective configuration |

## Configuration

Defaults below. Every value is a `userConfig` field: set it in `/config`, or in `settings.json` under `pluginConfigs["context-rollover"].options`. A project can override any of them in **`.claude/context-rollover.json`**, which takes precedence over both. Bad values are skipped with a warning shown in `/rollover status` and the Cockpit; thresholds that are not strictly rising fall back to the defaults together.

```json
{
  "enabled": true,
  "softLimit": 180000,
  "prepareLimit": 190000,
  "hardLimit": 200000,
  "automaticRestart": true,
  "restartMode": "clear",
  "continuationDir": "",
  "maxContinuationTokens": 10000,
  "rolloverTimeoutMs": 600000,
  "maxRetries": 3,
  "retryDelayMs": 5000,
  "logLevel": "info",
  "agentPolicy": "drain",
  "agentDrainTimeoutMs": 300000,
  "notifyAgents": true,
  "blockNewAgents": true,
  "autoCommit": false,
  "protectedBranches": "main,master",
  "gitSafetyRef": true,
  "resumeOnStartup": "ask",
  "useModelSummary": true,
  "notifyModel": true,
  "staleAfterHours": 24
}
```

| Setting | Meaning |
| --- | --- |
| `softLimit` | The model is told the session will roll over soon, and should keep its task list current. |
| `prepareLimit` | A draft continuation is written to disk; new `Agent` spawns are refused (`blockNewAgents`); the rollover runs **at the next turn end**. |
| `hardLimit` | Mid-turn: the main loop's tool calls are refused (task-list tools excepted) so the model ends its turn; if it does not end within `min(2 min, rolloverTimeoutMs/4)` the turn is aborted. Then the rollover runs. |
| `automaticRestart` | Off: the continuation is persisted, `/clear` is put in your prompt box, and your `/clear` restores it. |
| `restartMode` | `clear` (default): `/clear` in the same terminal — the engine ends the conversation and continues under a **new session id with an empty transcript**. `new-terminal`: opens a terminal running `claude "/rollover resume <id>"`, then exits this one; falls back to `clear` when no terminal opens. |
| `continuationDir` | Empty: `~/.claude/context-rollover/<project>` (outside the repository, so nothing appears in `git status`). Relative: under the project. |
| `agentPolicy` | `drain`: tell running agents to wrap up (`notifyAgents`), wait up to `agentDrainTimeoutMs`, record the rest. `record`: record them and go. |
| `autoCommit` | Off by default. On, it commits (`git add -A`) only on a named branch that is not protected, with no conflicts and no merge/rebase/cherry-pick in progress. |
| `gitSafetyRef` | Keeps `refs/context-rollover/<id>` → a `git stash create` commit of the tracked changes. That touches neither the working tree, the index nor the stash list. |
| `resumeOnStartup` | A new process finding an unrestored continuation (the terminal closed mid-rollover): `ask` puts `/rollover resume <id>` in the prompt box, `auto` restores it, `off` only shows it. |

**Safety margin.** The defaults leave a 10k gap between each threshold. If the model's context window is smaller than the configured hard limit allows, all three thresholds move down together so the hard limit sits at 90% of the window (`/rollover status` says so). If a fresh session *already* starts past the soft limit — for example because the system prompt, tools and CLAUDE.md are larger than the limits — the mod stops after one rollover with an error rather than looping.

## How it works

### Context usage

The figure is the engine's own, never an estimate:

- **`turn.step`** — every main-loop model response reports its usage; context = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. This is exactly the status line's `total_input_tokens`, and it arrives **mid-turn**, which matters: a single autonomous turn of a five-agent build can add hundreds of thousands of tokens.
- **`session.measure`** — pushed by the engine after each main turn (and on window changes).
- **`$.session.usage()`** — read once at startup.

What it measures: the input tokens the **last** main-loop request was answered over — the current context window's fill as of that response, not session totals and not subagents' contexts. The next request will be larger by the response and any tool results, which is why the limits sit below where you would actually want to stop. No polling: readings are pushed by those events. A reading that repeats the zone it is in does nothing; each threshold acts once per session.

### Continuation state

At the rollover the mod gathers **structured** state first:

1. **Git**: `status --porcelain=v2`, `diff --shortstat`, `log -5`, merge/rebase markers, a safety ref (and a commit only if you turned autoCommit on).
2. **Tasks**: the `TaskList` tool's own record (owners, blockers), else the TaskCreate/TaskUpdate calls seen this session, else the last `TodoWrite`.
3. **Agents**: `$.agent.list()` joined with the `Agent` calls in the transcript (their prompts = responsibilities) and each agent's last answer from its own transcript.
4. **The transcript's own payloads**: the person's first and recent requests (verbatim, cut), files written, recent tool errors.
5. **The previous generation's** objective and decisions, carried forward.

Then it asks **one targeted question** through `$.model.fork`: intent, decisions with reasons, blockers, unfinished work, next actions, unverified beliefs, suggested skills — only what the repository cannot say, as JSON. The fork re-sends the transcript as the main thread last sent it, so the prompt cache serves almost all of it. If that fails, the structured state is persisted anyway, with a note.

The result is rendered as markdown under `maxContinuationTokens`. If it is over budget, the lowest-priority sections lose lines first; the objective, next actions and resume protocol are never cut. Known credential shapes are redacted. The conventions follow the `handoff` skill: reference settled artifacts by path, never copy them; list unverified claims separately; suggest skills.

**Persistence**: each snapshot is a **new file** (`snapshots/<time>-<id>-<draft|final>.json`, plus a readable `.md`) whose checksum covers its content; it is read back and verified after writing. Nothing is ever overwritten or deleted, so the only copy of state is never destroyed. A torn or corrupted file fails its checksum, and the next newest valid one is used.

### Fresh session

Between turns, the mod runs `/clear` through `$.command.run`. The engine ends the conversation (`SessionEnd` reason `clear`) and continues in the same process under a **new session id with an empty transcript**. It does not inherit the conversation. The mod waits for the new id, **claims** the rollover (a `claims/<id>.json`, so it is restored once), appends the continuation as a row the model reads and you do not see as typed (`$.session.append`, user role, `isMeta`), and submits a short prompt that starts the turn. If the row is refused, the continuation rides in the prompt itself.

The fresh session follows the continuation's **resume protocol**:

1. Verify `git status` / `git log` against the record.
2. Recreate the tasks.
3. Re-dispatch agents.
4. Continue with the first next action.

Its first completed turn marks the transition **COMPLETED**, and monitoring starts over for the next one.

### Agents and teammates

What survives a rollover is the **record**, not the agent. A subagent's or an in-process teammate's loop belongs to the conversation that started it; Claude Code has no supported way to re-attach a running loop to a new conversation, and this mod does not pretend otherwise. So:

- From the prepare limit, **new agents are refused** (the model is told to record the task instead).
- At the rollover, running agents are **told to wrap up** (`$.session.send`) and **waited for** up to `agentDrainTimeoutMs`. Their file edits are already in the working tree, which is the source of truth.
- Every agent is recorded with its **identity** (name, id, type, team address), **responsibility** (its dispatch prompt), **status**, **last output**, and an **action**:
  - `re-dispatch` — running, pending, failed or killed, or an idle teammate.
  - `review-output` — finished; its output may not be in the repository yet.
  - `none`.
- The fresh session re-dispatches from that record. Task **ownership** travels with the task list.

### Recovery and idempotency

- **One rollover at a time.** A second trigger (another reading, `/rollover now`, a measurement) joins the one in flight.
- **Every step checks whether it already happened** before acting: a final snapshot on disk is reused; a session id that already changed skips `/clear`; a held claim is never restored twice. So a retry, a module reload or a duplicate trigger resumes the same rollover rather than starting a competing one.
- **Retries** with exponential backoff (`maxRetries`, `retryDelayMs`). An attempt is bounded by `rolloverTimeoutMs`.
- **On failure the gate is lifted**, so the session is never left stuck. If the continuation was saved, the phase is `awaiting-restart`, `/clear` is put in your prompt box, and your `/clear` restores it; otherwise `failed`, and `/rollover now` retries.
- A per-session **journal** (`sessions/<id>.json`) records the phase. If the process dies (Ctrl+C, terminal closed, crash), the next session in that project reports the rollover as **interrupted**, finds the newest valid unclaimed continuation (younger than `staleAfterHours`), and offers or restores it per `resumeOnStartup`.
- **Missing or corrupted files** are skipped; a newer corrupted snapshot falls back to an older valid one.
- **A failure inside the mod's gate lets the tool call through.** The mod must never block your work by breaking.

## Shared state contract

The mod is the **single writer** of `$.state` `context-rollover.status`; the type is in [`types/index.d.ts`](types/index.d.ts) (schema version 1). `$.state` is the engine's supported cross-mod channel: host-held, versioned, written with compare-and-set (`update` retries on a version miss, so concurrent writes cannot corrupt it), and **reactive**. A render hook that reads it is redrawn on every write, with no polling and no flicker.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1`. Readers draw nothing they cannot validate. |
| `sessionId`, `generation` | The current session; how many rollovers this chain has done. |
| `phase` | `disabled · monitoring · preparing · ready · draining · persisting · restarting · resuming · completed · awaiting-restart · failed` |
| `context` | `tokens` (null before the first response), `window`, `measuredAt`, `source` (`turn.step`, `session.measure` or `session.usage`) |
| `thresholds` | `{ soft, prepare, hard }` in force (after any window clamp) |
| `continuation` | `status` (`none · in-progress · draft · persisted · pending · restored · failed`), `path`, `rolloverId`, `bytes`, `approxTokens`, `updatedAt` |
| `agents` | `{ active, idle, pending, completed, failed, total }`, or **null when unavailable** — never invented |
| `tasks` | `{ pending, inProgress, completed, total, source }` or null |
| `last` | The previous rollover: `outcome` (`success · failed · interrupted`), `at`, `rolloverId`, `fromSessionId`, `toSessionId`, `finalTokens`, `detail` |
| `operation` | What is happening now, or next |
| `error` | `{ message, at, isRetriable }` or null |
| `restart` | `{ mode, isAutomatic }` |
| `heartbeatAt`, `updatedAt` | Heartbeat every 15 s. A reader calls the state **STALE** past 45 s. |

Observers must treat a missing value as UNAVAILABLE, an unknown schema or malformed value as UNAVAILABLE, and an old heartbeat as STALE. They must never trigger a rollover themselves. The Cockpit keeps its own copy of the type and validates every read, so either mod builds, loads and runs without the other.

## Files

```
hooks/register.ts          the engine's events → the lifecycle; $ → its port
hooks/lib/rollover.ts      the lifecycle (one deep module behind a narrow Port)
hooks/lib/thresholds.ts    zones, progress, next threshold, window clamp
hooks/lib/config.ts        defaults, merge, validation
hooks/lib/contract.ts      the shared state's runtime side: initial value, validation, staleness
hooks/lib/continuation.ts  the artifact: sections, budget trimming, redaction, resume prompt
hooks/lib/summary.ts       the one targeted model question, and its parse
hooks/lib/store.ts         snapshots, checksums, claims, journals
hooks/lib/git.ts           porcelain parsing, the autoCommit policy
hooks/lib/agents.ts        counts, records, actions
hooks/lib/transcript.ts    structured facts from the session's own tool calls
tests/                     units, lifecycle simulation, engine-dispatch tests
types/index.d.ts           the shared state contract
```

## Tests

```
claude plugin test .     # 73 tests
npx -p typescript@5.6.3 tsc -p .
claude plugin validate .
```

**What is and is not tested:**

- **Unit tests** (`tests/units.test.ts`): configuration, thresholds, progress, the contract, git parsing and commit policy, agent records, transcript extraction, summary parsing, continuation size limits and redaction, checksums, corrupted-file fallback, claims and claim races.
- **Lifecycle simulation** (`tests/lifecycle.test.ts`): a simulated process (`tests/world.ts`) whose `/clear` behaves as the engine documents. It covers:
  - every threshold transition, drain and abort;
  - duplicate and concurrent triggers;
  - uncommitted changes and safety refs;
  - five agents draining, with records;
  - failed, hanging and no-op restarts;
  - submit failures, manual restart, `new-terminal` mode;
  - a killed process and recovery;
  - corrupted files, module reload, limits below the fresh-session size;
  - and the full **A → threshold → persisted → A ended → B started → restored → resumed → rollover → C** chain.
  
  These are simulations.
- **Engine-dispatch tests** (`tests/engine.test.ts`): `register.ts` through the engine's own hook dispatch (the `claude plugin test` kit). They cover the published `$.state`, the project config file, the tool-call gate from a real `turn.step` usage chunk, `/rollover status` and `/rollover resume`, and the startup offer.
- **Live run** (manual, during development): a real `claude -p --input-format stream-json` process with this mod and thresholds of 32k/33k/34k ran **A → B → C** for real. Each session hit the hard limit mid-turn (measured from `turn.step`), drained, persisted, ran `/clear` (`SessionStart:clear` fired), and got a new session id with an empty transcript. Each fresh session read the appended continuation, verified git, and resumed. A decision made in A was still known in C.

  Not covered live: an interactive terminal session, and real running subagents during a drain. The agent logic is covered by the simulation only.

## Known limitations

- **Live agents cannot be carried over.** They are recorded and re-dispatched; their in-flight reasoning is lost. Agents still running when `/clear` happens are left to the engine (they may be stopped). Their file edits remain in the working tree.
- **Teammates in their own terminal panes** run outside this process. They show in `$.agent.list()` by their roster word and are recorded, but the mod neither stops nor restarts them.
- **Untracked files are not in the safety ref.** `git stash create` covers tracked changes only. Untracked files are listed in the continuation and stay on disk; the mod never cleans.
- **The claim is a best-effort lease.** The engine's file API has no exclusive create or rename, so two *processes* racing to restore the same continuation are resolved by write-then-verify. The simulation shows the loser backs off; a sub-millisecond race could in theory let both proceed.
- **`approxTokens` bounds the artifact by characters (÷ 3.5)**, which is deliberately generous. It is a size cap on the file, not a context reading.
- **The targeted summary costs one forked request** over the cached transcript (cache reads plus about 1–2k output tokens) per rollover. Turn it off with `useModelSummary: false`.
- **`claude -p` exits when its turn ends**, so a one-shot `-p` run cannot complete a rollover (it is reported as interrupted next time). Interactive sessions and long-lived headless (stream-json, SDK) sessions can.
- **A timed-out attempt cannot be cancelled mid-call.** The retry is safe because every step checks whether it already happened.
- **Plugin slash commands** (`/rollover …`) run from the interactive prompt, not from `-p` input.
