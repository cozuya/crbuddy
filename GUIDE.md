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
entry against that target. When an entry has no custom `instructions`, crbuddy
uses that vendor's native code-review operation rather than replacing it with a
generic "review this diff" prompt. Each reviewer runs independently and never
sees the other reviewers' output.

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

crbuddy has adapters for exactly three CLI interfaces:

| Config `vendor` | Executable | Native diff review | Generic instructed lanes and consolidation |
|---|---|---|---|
| `claude` | Claude Code (`claude`) | Yes - `/code-review` | Yes |
| `codex` | Codex CLI (`codex`) | Yes - `codex exec review` | Yes |
| `gemini` | Gemini CLI (`gemini`) | No - panel `instructions` are required | Yes |

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
| `crbuddy view` | Show the effective repository-or-global config. Read-only. |
| `crbuddy go [instructions]` | Run the panel. |
| `crbuddy doctor` | Report which vendor CLIs are usable, which flags they accept, and why not. Read-only; contacts no models. Also aliased as `check`. |

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
diff review, the diff size limit does not apply to it, and Gemini - which
refuses ordinary diff review because it exposes no headless native lane - can
take part. The report records all of this and says `Checkout snapshot captured
at launch: <sha>` in place of a changed-file count. Reviewers run against the
live working tree; the hash records launch provenance rather than an isolated
execution tree.

## Configuration

Global at `~/.crbuddy/config.json`, or per-repository at
`.crbuddy/config.json`. **A project-local config replaces the global one
entirely** - there is no merging, because merging arrays of panel entries is
ambiguous and makes "which panel actually ran?" hard to answer.

Notification preferences are separate: `~/.crbuddy/settings.json` is global-only
and applies even when a repository supplies its own review config.

A copyable configuration is shipped in
[`examples/config.example.json`](examples/config.example.json).

```jsonc
{
  "configVersion": 1,

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

  "merge": {
    "enabled": true,
    "vendor": "claude",
    "model": "opus",
    "effort": "high"
  },

  "panel": [
    { "vendor": "claude", "model": "opus", "effort": "max" },
    { "vendor": "codex", "model": "gpt-6-sol", "effort": "xhigh" },
    {
      "id": "security",
      "vendor": "gemini",
      "model": "gemini-3.1-pro-preview",
      "instructions": "Review only for security issues: injection, authz, secrets handling."
    }
  ]
}
```

Other keys, all optional: `refuseIfOutputExists` (default `false`),
`timeoutMs` and `mergeTimeoutMs` (both default to one hour),
`maxConcurrent` (`0` = unlimited),
`maxDiffBytes`, and `savedReviewInstructions` (one reusable custom review prompt).

Unknown keys are a hard error. A typo that silently does nothing is worse
than a failed startup.

### Optional ntfy notifications

At the end of `crb init` / `crb config`, choose whether to receive a push when
`crb go` finishes. The first-time default is No. Choose Yes, select ntfy, and
enter `https://ntfy.sh/<topic>`. Subscribe to the same topic in the ntfy app.
Use a long, unguessable topic name: the topic acts like a shared secret.
[ntfy topic names](https://docs.ntfy.sh/publish/#picking-a-topic) use 1–64 letters,
numbers, underscores or dashes. Only hosted ntfy URLs are supported, without
credentials, extra paths, non-default ports, query strings or fragments.

Reopening setup defaults to Yes and offers the existing URL as its text
default; Enter retains it. Choosing No removes the stored endpoint. These
preferences are saved globally even while editing a repository's review config.
Piped setup hides entered URLs and saved defaults from its output; Enter still
retains a saved URL. Interactive setup displays the URL for editing.
Setup sends no test push. In piped setup, notification answers follow all the
existing review and `.gitignore` answers: No ends the questions; Yes adds the
service choice and URL. The final save confirmation remains TTY-only.
Piped scripts must supply those answers too: append `n` to disable notifications,
or `y`, a service answer and a URL answer to enable or retain them. As with other
wizard questions, running out of answers cancels setup before anything is saved.

If the review config saves but global preferences cannot be saved, setup reports
both facts and exits with code 1. Previous notification preferences remain
unchanged; the review config and any approved `.gitignore` update are still saved.

After at least one reviewer starts, a finished run sends one POST with the
repository name and a complete, partial or failed status. It includes no code,
findings, local paths or topic URL. Setup, diagnostics, argument/config/preflight
errors, empty-diff refusals and Ctrl+C cancellation during the review do not
send a push. In terminal mode, delivery happens after the report is printed and
before the final clipboard menu waits for input. Ctrl+C at that menu closes it
without sending another push; the completed review has already been notified.

Delivery is best-effort, with a two-second total budget and no retries or redirects.
If delivery cannot be confirmed, crbuddy prints a concise warning without the
endpoint and preserves the review's exit code. A timed-out request may still have
delivered a push. Missing settings disable notifications; malformed settings warn
and allow the review to proceed. Repair `~/.crbuddy/settings.json` manually to
preserve its values, or run `crb config` to replace them with your new choices.
Choosing No clears the saved setting even if the previous file could not be read.

### Panel entries

`instructions` is optional for vendors with a supported headless native review
operation. Without it, the adapter runs that vendor's own review behavior.
With it, the adapter runs a generic read-only agent given those instructions.

Not every vendor exposes a usable headless native review surface. For those
vendors, `crbuddy init` requires explicit `instructions` rather than creating a
lane that would later be refused. Gemini is currently in this category.


In interactive `crb init` / `crb config`, a custom review prompt can be saved as
`savedReviewInstructions`. Later reviewers can use the vendor default, reuse the
saved prompt, or enter a new one. Reuse copies the text into that reviewer's own
`instructions`; review execution never dereferences the saved field. Existing saved
text can also be forgotten from interactive config. `crb view` and the final setup
summary show only a sanitized first-line preview (truncated when long) plus an
approximate wrapped-line count; subsequent lines are never printed verbatim.

Piped setup deliberately keeps its pre-existing answer order. It does not add the
save/reuse/forget questions: native reviewers still ask only default-vs-custom and
reviewers without a native lane still read the required custom-instructions answer.
Manage `savedReviewInstructions` interactively (or edit the JSON) when reuse is wanted.

For Claude Code, native review uses `/code-review` through print mode and gives
the command crbuddy's captured git range. For Codex, native review uses
`codex exec review` with the vendor's `--uncommitted` or `--base` selector.
Those target interfaces are not identical, which is why the snapshot is stable
provenance rather than a claim that every native lane consumes the exact same
SHA range.

`vendorArgs` is an escape hatch for CLI flags crbuddy does not model. crbuddy
rejects known per-vendor flags that can select permissions or policy, load
settings or capabilities, extend accessible roots, or choose Codex config
layers. This is best-effort matching against changing vendor CLIs, not a
security boundary or proof that an unknown flag is inert.

### Models and effort

The Codex model picker offers GPT-6 Astra, Sol and Luna. GPT-6 Sol is the
default, and “Other…” still accepts arbitrary model IDs. The GPT-6 models must
be supported by your installed Codex CLI and account; listing them does not
raise crbuddy's minimum Codex CLI version. GPT-5.6 models are no longer listed,
but a config that names one still runs: model IDs are passed through unchecked.

The Gemini picker offers Gemini 3.1 Pro (preview, the default) and Gemini 3.5
Flash. Gemini 2.5 models are no longer listed.
Changing the consolidation vendor uses the new vendor's model and effort defaults.
Re-enabling consolidation without a saved model also uses the vendor's default.

For piped setup, Codex model numbers are `1` GPT-6 Astra, `2` GPT-6 Sol,
`3` GPT-6 Luna, `4` Other; update scripts that used the v0.3.x positions
(`2` GPT-5.6 Sol, `5` Other). Codex effort
numbers are `1` low through `5` max, `6` Other: `none` was dropped because no
current Codex model accepts it. An empty model answer still accepts the
configured model or, on first setup, GPT-6 Sol.
A saved custom model appears after Other as the default choice, so retaining it
uses just one answer. Selecting Other explicitly still asks for a model ID.

Effort values are **vendor-native and passed through verbatim**. There is no
crbuddy effort vocabulary and no translation.

`crbuddy init` offers each vendor's own values - Claude Code's `low` through
`max`, Codex's `low` through `max`, nothing at all for a CLI without an
effort setting - plus an "Other…" escape for anything the shipped list
doesn't cover. Whatever you pick is written to config and handed to the CLI
unchanged.

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

**Flags and versions are detected, not assumed.** Vendor CLI behavior churns
between releases. Preflight checks each adapter's minimum supported CLI version
and refuses to guess when the installed binary is older or its version cannot
be parsed. It also reads the adapter's appropriate help surface and only passes
optional flags it advertises. A missing **safety** flag - read-only enforcement
- refuses that lane instead. Parent and nested subcommand help are not
interchangeable; Codex, for example, keeps crbuddy's sandbox/config flags on
`codex exec --help`.

**Preflight checks presence/version, not authentication.** crbuddy does not
probe whether you're logged in: there's no uniform, free way to do that across
vendors, and a wrong check rots per vendor. An expired login shows up as a lane
failure.

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
base SHAs, diff digest, per-run CLI versions and applied effort, failures with
reasons, and consolidation state. Unconsolidated reports omit that verbose
block and begin with the review itself. Their visible report block still gives
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
