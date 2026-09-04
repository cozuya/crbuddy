# crbuddy - detailed documentation

Fan one code review out across several coding-agent CLIs in parallel, each
blind to the others, then consolidate the results into one markdown file
meant to be handed to an agent that makes the fixes.

crbuddy holds no model credentials. It drives the vendor CLIs you already
have installed and logged in, as subprocesses, so reviews run on whatever
entitlement those CLIs are configured with.

```
npm i -g crbuddy
crbuddy init        # interactive setup
crbuddy go          # run the panel; blocking
```

## What it does

`crbuddy go` resolves what's under review once and dispatches every configured
entry against that target. Each reviewer can use the reviewer's default
behavior, crbuddy's built-in prioritized-findings preset, or custom
instructions. For Claude Code and Codex, the default is the vendor's native
code-review operation. Gemini exposes no supported headless native review
operation, so its default is a maintained crbuddy generic review prompt. Each
reviewer runs independently and never sees the other reviewers' output.

crbuddy also captures a git snapshot and target metadata for provenance. Native
review commands differ in how precisely they accept a target: some can take an
explicit range, while others expose selectors such as "uncommitted" or "against
this base branch." Do not edit the tree while a panel is running.

When the reviewers finish, an optional consolidation pass groups findings that
appear to describe the same defect. The consolidator is deliberately not a
judge: it cannot reject, rewrite, summarize away, or delete a review finding.

**`CODE-REVIEW-HANDOFF.md` is always the deliverable.** With consolidation
on it holds findings grouped and ordered by how many reviewers raised them,
and `CODE-REVIEW-HANDOFF.raw.md` is written alongside as the unmerged audit
trail. With consolidation off - or if it fails - the primary file holds the
reviews unmerged, with a header saying so. The filename you point an agent at
never changes.

It's blocking on purpose - run it in a spare terminal. There's no daemon, no
`status` command, and no resumability, because a second terminal solves that
for free.

## Supported vendor CLIs

crbuddy v0.3 has adapters for exactly three CLI interfaces:

| Config `vendor` | Executable | Native diff review | Generic instructed lanes and consolidation |
|---|---|---|---|
| `claude` | Claude Code (`claude`) | Yes - `/code-review` | Yes |
| `codex` | Codex CLI (`codex`) | Yes - `codex exec review` | Yes |
| `gemini` | Gemini CLI (`gemini`) | No - crbuddy supplies a generic default | Yes |

An unknown `vendor` value is refused. `vendorArgs` can pass additional flags to
one of these CLIs, but it cannot add another CLI or a direct API provider.
Support means crbuddy knows how to probe that executable, enforce its available
read-only controls, invoke it headlessly, and recognize a completed response.
Authentication, entitlement, and repository/vendor configuration remain the
user's responsibility.

Support attaches to the CLI interface, not to every model backend that can be
routed through it. For example, [DeepSeek documents pointing Claude Code at its
Anthropic-format endpoint](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/),
while [Anthropic explicitly does not support using Claude Code with non-Claude
models through a gateway](https://code.claude.com/docs/en/llm-gateway).
crbuddy inherits the environment and may therefore launch such a setup as
`vendor: "claude"`, but it does not detect or verify the upstream provider, its
model mapping, or its compatibility with `/code-review`. The report records the
Claude Code adapter and requested CLI model string, not proof that Anthropic
served the model. Such a routed backend is therefore unverified, not a
separately supported `deepseek` vendor.

## Commands

| | |
|---|---|
| `crbuddy init` | Interactive setup. Writes a config. |
| `crbuddy config` | The same command; edits an existing config. |
| `crbuddy go [instructions]` | Run the panel. |
| `crbuddy doctor` | Report which vendor CLIs are usable, which models they report when discovery is available, which flags they accept, and why not. Read-only; it does not invoke a model. Also aliased as `check`. |

`crb` is installed as a second name for the same binary, so `crb go` and
`crbuddy go` are interchangeable.

The optional positional argument to `go` overrides the review instructions on
**every** panel entry, for a one-off run without editing config:

```
crbuddy go "focus only on error handling and resource cleanup"
```

Flags: `--force` runs despite an oversized diff, `--whole-checkout` opts an
unattended run into the whole-checkout fallback below, and `--strict` exits 2
on partial success.

### When there is no diff

If the target resolves to nothing - `go` run straight after committing, or a
base branch that is already the current commit - crbuddy warns and reviews the
whole checkout instead of exiting.

That only happens when both input and the warning stream are attached to a
terminal. The warning is the safeguard, and an unattended caller has nobody to
read it: a hook, CI job, or run with stderr redirected would otherwise spend one
full agent run per panel entry with no diff size limit bounding any of them.
Without a visible prompt stream, `go` prints the reason and exits 1, as it
always did. Pass `--whole-checkout` to ask for the fallback anyway. `--force`
only waives `maxDiffBytes`; it does not opt into this broader run.

That is a materially different run, so it is worth recognizing in the output.
No vendor CLI has a native review mode for "the entire repository", so every
panel entry drops to a general-purpose agent pointed at the working tree
rather than the vendor's own review workflow. It is broader and slower than a
diff review, and the diff size limit does not apply to it. The report records
all of this and says `Checkout snapshot captured at launch: <sha>` in place of
a changed-file count. Reviewers run against the live working tree; the hash
records launch provenance rather than an isolated execution tree.

## Configuration

Global at `~/.crbuddy/config.json`, or per-repository at
`.crbuddy/config.json`. **A project-local config replaces the global one
entirely** - there is no merging, because merging arrays of panel entries is
ambiguous and makes "which panel actually ran?" hard to answer.

A copyable configuration is shipped in
[`examples/config.example.json`](examples/config.example.json).

```jsonc
{
  "configVersion": 2,

  // "file" writes a report; "terminal" prints it and writes nothing.
  // The paths are relative to the repository root, so one config serves
  // many repos. `../` puts the report outside the repo entirely, where it
  // cannot land in a diff or be committed by accident. An absolute path is
  // allowed and pins every repository to the same file. Both paths are
  // kept and validated even in "terminal" mode, so switching back to
  // "file" restores the last choice. Each path must name a file, never an
  // existing directory or a filesystem root.
  "output": {
    "destination": "file",
    "merged": "CODE-REVIEW-HANDOFF.md",
    "raw": "CODE-REVIEW-HANDOFF.raw.md"
  },

  // "uncommitted", or { "base": "main" } for a branch-style review
  "target": "uncommitted",

  // Maximum silence from a reviewer. stdout/stderr activity resets it.
  "timeoutMs": 5400000,
  "mergeTimeoutMs": 3600000,

  "merge": {
    "enabled": true,
    "vendor": "claude",
    "model": "opus",
    "effort": "high"
  },

  "panel": [
    // Reviewer default: Claude's native /code-review.
    { "vendor": "claude", "model": "opus", "effort": "max" },

    // A versioned crbuddy-maintained preset, expanded only when the run starts.
    {
      "vendor": "codex",
      "model": "gpt-5.6-sol",
      "effort": "xhigh",
      "instructionsPreset": "prioritized-findings-v1"
    },

    // Gemini has no native review command; its default is crbuddy's maintained
    // generic review prompt.
    { "vendor": "gemini", "model": "gemini-2.5-pro" },

    // Free-form custom instructions remain available.
    {
      "id": "security",
      "vendor": "claude",
      "model": "sonnet",
      "effort": "high",
      "instructions": "Review only for security issues: injection, authz, secrets handling."
    }
  ]
}
```

Other keys, all optional: `refuseIfOutputExists` (default `false`),
`timeoutMs` (90 minutes of inactivity by default), `mergeTimeoutMs` (one hour
of inactivity by default), `maxConcurrent` (`0` = unlimited), and
`maxDiffBytes`.

Unknown keys are a hard error. A typo that silently does nothing is worse
than a failed startup.

### Panel entries

After choosing vendor, model, and effort, `crbuddy init` offers the same three
instruction modes for every reviewer:

1. **Prioritized findings** - a built-in project-neutral P0-P3 review preset.
2. **Custom instructions** - free-form instructions entered during setup.
3. **Reviewer default** - the preselected choice. Claude and Codex use their
   native review operation; Gemini uses crbuddy's maintained generic default.

The prioritized preset is persisted as the versioned identifier
`prioritized-findings-v1`, not copied into the config as a long prompt. That
keeps saved behavior stable if a later release adds a revised preset. The
preset and a free-form `instructions` value are mutually exclusive.

For Claude Code, native review uses `/code-review` through print mode and gives
the command crbuddy's captured git range. For Codex, native review uses
`codex exec review` with the vendor's `--uncommitted` or `--base` selector.
Those target interfaces are not identical, which is why the snapshot is stable
provenance rather than a claim that every native lane consumes the exact same
SHA range.

Run metadata records whether each reviewer used its default behavior, a
built-in preset, custom instructions, or the one-off command-line override. If
a maintained crbuddy prompt was used, its versioned preset id is recorded too.

`vendorArgs` is an escape hatch for CLI flags crbuddy does not model. crbuddy
rejects known per-vendor flags that can select permissions or policy, load
settings or capabilities, extend accessible roots, or choose Codex config
layers. This is best-effort matching against changing vendor CLIs, not a
security boundary or proof that an unknown flag is inert.

### Models and discovery

Model ids are vendor-native strings. During `init`, crbuddy asks an installed
CLI for its current model catalog when that CLI exposes a usable programmatic
surface. Codex is discovered through its effective model catalog, including
model-specific reasoning effort values when advertised; Gemini is discovered
through the same ACP model list used by its interactive model UI. Claude Code
does not currently expose a supported noninteractive model-list surface, so
crbuddy uses its maintained fallback list there.

Discovery is best-effort. A timeout, authentication/protocol failure, empty
catalog, or vendor interface change falls back to crbuddy's built-in list
instead of breaking setup. `Other…` always remains available for an arbitrary
model id accepted by the CLI. An existing configured model that is absent from
the current discovered list is also retained as a selectable choice when
editing config.

### Effort

Effort values are **vendor-native and passed through verbatim**. There is no
crbuddy effort vocabulary and no translation.

`crbuddy init` uses model-specific effort values reported by model discovery
when available; otherwise it offers the adapter's maintained vendor values.
`Other…` remains an escape hatch for any value the installed CLI accepts.
Whatever you pick is written to config and handed to the CLI unchanged. The
terminal lane label includes the configured value, for example `Claude Code
(opus xhigh) - started`.

An earlier design had a portable vocabulary (`low | medium | high | max`)
translated and clamped per vendor. It was removed. `model` was already a
vendor-native string in config, so an abstract `effort` alongside it was
inconsistent; and clamping could silently downgrade a run, which then needed
version stamps and clamp reporting to detect. Passing the value through
deletes the failure mode instead of instrumenting it. An unusable value now
fails fast, attributed to the lane that used it.

For native Claude `/code-review`, an omitted `effort` resolves to crbuddy's
explicit default (`high`) instead of inheriting whatever level was last chosen
in an interactive Claude Code session. Other lanes with omitted effort pass no
effort setting unless their adapter documents a default.

`ultra` is intentionally not a normal Claude effort in crbuddy. It selects the
separate cloud Ultrareview product, which is asynchronous under `claude -p` and
may consume paid usage credits. crbuddy refuses it on the normal Claude lane.

### Timeouts

`timeoutMs` is an **inactivity timeout**, not a fixed runtime budget. The timer
is reset whenever the vendor process writes to stdout or stderr. This matters
for long native reviews: a reviewer that is still reading files and emitting
progress is not treated the same as a wedged process that has gone silent.

New configs default to 90 minutes (`5400000` ms). Existing configs keep their
numeric value, so an older `3600000` setting becomes "60 minutes with no
output" rather than "kill this run after exactly one hour." The process runner
also enforces a separate hard wall-clock ceiling at four times the configured
inactivity timeout. With the new default that ceiling is six hours; it exists
only to stop a continuously chatty runaway process from living forever.

`mergeTimeoutMs` uses the same activity-aware watchdog and defaults to one hour.
Short diagnostic/probe commands explicitly keep their own fixed short hard
ceilings.

## Caveats

Read these. Several are consequences of deliberate design choices rather than
things waiting to be fixed.

**Agreement is a priority heuristic, not a confidence score.** Findings are
ordered by how many distinct reviewers raised them, which is mechanical and
requires no judgment about correctness. It is not evidence that a finding is
right. Models can err in correlated ways. Treat convergence as a reading order,
not a verdict.

**The target is captured; native review commands differ in target syntax.**
crbuddy resolves the intended target and captures a git snapshot for
provenance, but reviewers run against the live working tree and vendor-native
review surfaces are not identical APIs. Some can consume a specific range and
some expose selectors such as uncommitted changes or a base branch. Don't edit
while a panel is running; otherwise reviewers may observe different trees and
the launch snapshot will no longer identify the state they saw.

**Repository and vendor configuration are trusted inputs.** Running inside
your repo means each CLI loads that repo's own `CLAUDE.md`, `AGENTS.md`,
project-local commands, settings, hooks, plugins, extensions, and MCP
configuration according to the vendor's behavior. `.crbuddy/config.json` and
those vendor files are loaded by design; inspect them before running crbuddy
on a repository you do not trust. Read-only agent modes do not make arbitrary
vendor configuration safe to load.

**The consolidator cannot delete anything.** It receives enumerated findings
and returns only relationships between their IDs; crbuddy renders the groups
from the original text. Every input ID must appear exactly once, or the merge
is rejected and you get the raw file with a warning. The failure mode is
under-grouping, never a finding that quietly vanished.

The consolidator is not shown the repository, only the findings and the
changed-file manifest. Under a keep-them-separate-when-unsure rule, code access
buys little and mainly creates opportunities to adjudicate correctness, which
is not its job.

**Segmentation is mechanical, not a model call.** Splitting each review into
findings is done by a heuristic that guarantees losslessness: concatenating
the segments reproduces the review byte for byte. A bad split produces a
finding that's too large or too small - never one that's missing.

**Flags, versions, and model catalogs are detected rather than silently
assumed where the vendor exposes them.** Preflight checks each adapter's minimum
supported CLI version and refuses to guess when the installed binary is older
or its version cannot be parsed. It also reads the adapter's appropriate help
surface and only passes optional flags it advertises. A missing **safety** flag
- read-only enforcement - refuses that lane instead. Parent and nested
subcommand help are not interchangeable; Codex, for example, keeps crbuddy's
sandbox/config flags on `codex exec --help`. Model discovery is softer: failure
to enumerate models falls back to the maintained list because a stale picker
should not make an otherwise usable CLI unavailable.

**Preflight checks presence/version, not authentication.** crbuddy does not
make a separate model call just to prove you're logged in. Model-catalog
discovery may itself require the vendor's existing authentication; if that
fails during setup or `doctor`, crbuddy reports the discovery problem and uses
the fallback list. An expired login during `go` shows up as a lane failure.

**Concurrency is unmanaged by default.** Six entries means six subprocesses.
That will hit per-subscription rate limits well before it hits your machine.
Set `maxConcurrent` if it bites.

**Terminal progress is capability-dependent.** Every interactive terminal gets
the in-terminal status line and a bell after a successful run. crbuddy also
reports native indeterminate progress to Windows Terminal, ConEmu, iTerm2
3.6.6+, Ghostty 1.2+, and VS Code. VS Code receives the state but only displays
it when its tab title or description includes `${progress}`; unsupported
terminals receive no OSC progress sequence. Audible versus visual bell
behavior remains the terminal user's setting.

**Reviewers are invoked with a probed read-only mode, or refused.** Each
adapter passes its vendor's advertised read-only/sandboxing mechanism when
needed, and if crbuddy cannot establish that invocation the lane is refused.
Known safety- and configuration-sensitive `vendorArgs` are rejected with
best-effort per-vendor matching. Because vendor flag surfaces change, this
filter does not make untrusted repository or vendor configuration safe.

**Ctrl-C aborts and writes nothing.** A partial panel is worse than no panel,
because a consuming agent can't tell it's partial. The previous review is
restored. Press it twice to stop waiting for children to exit politely.

**Windows.** npm-global CLIs install as `.cmd` shims, and Node refuses to
spawn those without a shell in some cases. Spawning goes through `cross-spawn`
on Windows to resolve shims correctly, and process-tree termination uses
`taskkill /T`. If a vendor still shows as missing, `crbuddy doctor` prints the
actual reason.

**macOS/Linux.** Child reviewers run in their own process group so cancellation
can signal the whole vendor process tree rather than orphaning helpers or MCP
processes.

## Where output goes

`output.destination` decides between a file and the terminal.

**`file`** is the default and the original behavior. `output.merged` is always
the deliverable; `output.raw` is written alongside it only when consolidation
ran.

**`terminal`** writes nothing to disk. The report goes to stdout, so
`crbuddy go > review.md` works and every progress line or preflight
confirmation stays on stderr where it cannot interleave. With consolidation
on, only the consolidated report is printed - the unmerged reviews are an
audit trail worth having on disk, not worth doubling the scrollback for. When
both ends are a terminal the run then stops on a prompt offering to copy the
report to the clipboard; piped or redirected, it prints and exits. Nothing
clears the screen or uses the alternate buffer, so the report survives in the
scrollback either way.

A report left on disk by an earlier `file`-mode run is still moved aside for
the duration of a `terminal` run - reviewers must not read the last review -
and put back afterwards, since this run replaced nothing.

Clipboard support uses `clip` on Windows, `pbcopy` on macOS, and the first of
`wl-copy`, `xclip`, or `xsel` found on Linux. Failure is reported and never
fatal; the report has already been printed by then.

## Where crbuddy keeps its own state

Only two things live in the repository: `.crbuddy/config.json` (if the config
is project-local) and `.crbuddy/lock/` for the duration of a run.

Everything volatile - the per-lane scratch files and the previous report while
it is moved aside - lives under `~/.crbuddy/state/<hash of the repo path>/`.
That is not tidiness. Reviewers read the working tree freely, so a previous
report or another lane's live stdout sitting inside the repo is readable by a
running reviewer, which breaks blindness in a way the diff pathspec cannot
prevent - and a whole-checkout run, which has no pathspec at all, loses it
entirely. Under the home directory rather than the OS temp directory because a
crashed run's only copy of the previous report waits there until the next run
recovers it. Panel spool files are removed before consolidation starts. The
consolidator uses a separate, unique OS-temp working directory, which is
removed when it finishes; only a report that still needs crash recovery may
remain.

If the Git root is the home directory or one of its ancestors, that state
location would fall inside the repository and reviewers could read it. crbuddy
refuses such a run before creating run state. A state directory deliberately
redirected outside the repository with a symlink remains valid.

Shared output paths get their own locks, one per resolved file, under
`~/.crbuddy/locks`. Two sibling repositories both writing
`../CODE-REVIEW-HANDOFF.md` are writing one file, and a per-repository lock
cannot see across that. Keeping these locks in user-owned state avoids a
predictable path in a shared OS temp directory.

## How output is structured

Consolidated reports carry YAML frontmatter with the captured snapshot and
base SHAs, diff digest, per-run CLI versions, applied effort, instruction source
(default/preset/custom/override), maintained preset id when applicable,
failures with reasons, and consolidation state. Unconsolidated reports omit
that verbose block and begin with the review itself, but each review heading
also states the instruction mode used. Their visible report block still gives
the review count, failures, warnings, target range, and file count. A compact
hidden marker keeps the run ID so a raw file can be matched to its consolidated
companion without restoring the large metadata block.

For a whole-checkout fallback, the frontmatter identifies the subject as
`whole-checkout` and records `launchSnapshot`, a snapshot captured immediately
before the panel starts. Reviewers still run against the original live working
tree, so this is launch provenance rather than filesystem isolation. The
original empty target is retained as `requestedKind`/`requestedSnapshot`; diff
byte and file counts are omitted because no diff was the review subject.

HTML comment markers delimit reviews, clusters, and findings. **They are
navigation aids, not a parsing boundary** - a model's verbatim output can
contain the closing marker. Both files are rendered from structured data;
nothing in crbuddy parses markdown back out of them.

## Exit codes

| | |
|---|---|
| `0` | Usable report produced; partial success also exits 0 by default |
| `1` | No usable review produced |
| `2` | Partial success - only with `--strict` |

Use `--strict` in a hook where a failed lane or failed consolidation should
break the command chain.

## Status

The pure-logic surface - config, target resolution, merge
validation, rendering, adapter safety, and adapter dispatch - has unit tests.
Vendor CLIs change quickly, so the native adapter layer is the most
version-sensitive part of the program. Run `crbuddy doctor` on every machine
that will actually execute the panel.

See `DESIGN.md` for why things are the way they are, including the non-goals.

## License

MIT
