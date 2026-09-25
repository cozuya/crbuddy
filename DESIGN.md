# crbuddy - design specification

crbuddy is a small local CLI that turns a repetitive multi-vendor code-review workflow into one command: run one or more coding-agent reviewers independently, preserve their outputs, optionally group apparent duplicate findings, and write a handoff file for the coding agent or human that will act on them.

This is the authoritative design. `README.md` is the short user-facing entry point and `GUIDE.md` is the detailed user documentation. If implementation and this file disagree, resolve the disagreement explicitly rather than silently changing one to match the other.

---

## 1. Scope

crbuddy is:

- a local, blocking CLI installed globally with `npm i -g crbuddy`
- an orchestrator for vendor coding CLIs the user already has installed and authenticated
- a way to run several review lanes in parallel while keeping them blind to one another
- an evidence collector and handoff generator

Deliberate non-goals:

- no daemon, background service, status server, or resumable job system
- no hosted service and no model credentials stored by crbuddy
- no fix application; another agent or human acts on the report
- no cross-invocation memory or reconciliation against prior runs
- no requirement that every vendor expose identical review controls

TypeScript/Node is intentional. Do not add another implementation language merely to produce a single binary.

---

## 2. Commands

### `crbuddy go [instructions]`

Run the configured panel. Blocking by design.

With no positional `instructions`, each panel entry uses its vendor's **native code-review operation** when crbuddy has a supported headless native path for that vendor.

Supplying positional `instructions` is an explicit override for the whole run. It replaces every panel entry's configured instructions, so those lanes run as generic read-only agents under the supplied criteria instead of using the vendor-native review flow.

Flags:

- `--force` - run despite `maxDiffBytes`
- `--whole-checkout` - opt into reviewing the entire checkout when an
  unattended run has an empty target diff
- `--strict` - return exit 2 when the run is only partially successful

### `crbuddy init` / `crbuddy config`

Interactive configuration. Existing configuration is loaded and edited rather than overwritten blindly.

---

## 3. Configuration

Locations:

- global: `~/.crbuddy/config.json`
- project-local: `<repo>/.crbuddy/config.json`

A project-local config replaces the global config entirely. There is no implicit merging.

Global user preferences live separately in `~/.crbuddy/settings.json` and do not
participate in review-config replacement. Its optional `notifications` object
contains `{ "provider": "ntfy", "endpoint": "https://ntfy.sh/<topic>" }`.
Missing settings disable notifications; unreadable or invalid settings warn
without blocking review. Selecting No in setup removes the saved endpoint.
Saving atomically replaces the settings file with a private (0600) file on
POSIX, including when the previous file had broader permissions. A failed
settings save leaves old preferences intact and explicitly reports partial
setup with exit code 1; the review config and approved `.gitignore` plan are saved.

Named fields only. Model and effort identifiers are vendor-native strings.

```jsonc
{
  "configVersion": 1,
  "output": {
    "merged": "CODE-REVIEW-HANDOFF.md"
  },
  "target": "uncommitted",
  "refuseIfOutputExists": false,
  "timeoutMs": 3600000,
  "maxConcurrent": 0,
  "maxDiffBytes": 2000000,
  "panel": [
    {
      "id": "claude-opus",
      "vendor": "claude",
      "model": "opus",
      "effort": "high"
    },
    {
      "id": "security-gemini",
      "vendor": "gemini",
      "model": "gemini-3.1-pro-preview",
      "instructions": "Review only for security defects."
    }
  ]
}
```

Unknown keys are fatal, except keys left by the removed consolidation pass (§8). Panel IDs are stable provenance labels. `vendorArgs` is an escape hatch for non-safety CLI flags crbuddy does not model. It must never be able to weaken read-only, sandbox, approval, or permission policy; those controls are owned by crbuddy even when config is project-local.

### Wizard behavior

The wizard detects installed vendor CLIs, builds the panel, chooses where the report goes, and chooses the target. Accepting every default adds one reviewer per installed CLI, skipping any CLI whose detected version `crbuddy go` would refuse.

Notification questions come last, after review and `.gitignore` questions, and
always edit the global preference regardless of review-config scope. They
default to disabled on first setup and retain existing values on Enter.
Setup performs no notification HTTP request. The topic field redacts both
entered answers and saved defaults in piped output, including validation retries.
TTY editing still displays the saved URL and accepts it with Enter.

Adapter metadata declares whether a vendor has a supported **headless native review** operation. A vendor without one may still be used as a generic reviewer, but the wizard must require explicit review instructions for that lane. It must not offer “vendor's own review behavior” and then write a configuration that `go` will deterministically refuse.

Detection establishes CLI presence/version/capability, not authentication. Each adapter declares a minimum supported CLI version. `go` refuses an older or unparseable version rather than guessing at version-sensitive native-review behavior; `check` reports the same condition before a paid run starts.

---

## 4. Target resolution and provenance

crbuddy resolves the intended review target once at startup and records a canonical git snapshot for provenance.

### `uncommitted`

Defined as tracked index/worktree changes plus non-ignored untracked files relative to HEAD, or relative to the empty tree when HEAD does not exist.

Requirements:

- ignored files excluded
- untracked files included
- unresolved merge conflicts refuse the run
- crbuddy output files and `.crbuddy/` excluded
- linked worktrees supported by asking git for paths rather than assuming `.git/` is a directory
- an empty target refuses quickly when unattended; with terminal input and a
  visible terminal warning stream it warns and reviews the whole checkout
  instead (`--whole-checkout` opts an unattended run in). The fallback is a
  general-purpose agent run, not a native review, and `maxDiffBytes` does not
  bound it
- whole-checkout reviewers run against the original live working tree. The
  snapshot captured immediately before launch is provenance, not an isolated
  execution tree; users must not edit the repository while the panel runs
- odd filenames handled with NUL-delimited git output
- snapshot construction does not modify the user's index or worktree

A throwaway git index is used to build a tree and `commit-tree` produces a real snapshot commit. Record the snapshot object ID, base object ID, diff digest, changed-file manifest, file count, and byte count.

### Branch target

`{ "base": "main" }` means review current HEAD relative to the merge base with the requested base ref.

Record the requested base, merge-base object ID, HEAD object ID, and canonical range. A shallow clone that cannot produce the merge base fails clearly; crbuddy does not silently fetch history.

### Native review target fidelity

The canonical snapshot is authoritative **provenance**, but vendor-native review commands are not one uniform API.

Use the strongest native scoping primitive the vendor exposes:

- if native review accepts an explicit range, give it crbuddy's captured range
- if native review exposes selectors such as `--uncommitted` or `--base`, use those selectors
- do not replace native review with a generic “review this diff” prompt merely to normalize target syntax

Therefore crbuddy must not claim that every lane is cryptographically pinned to the same snapshot. A native operation that selects live repository state, or a generic whole-checkout lane running in the working tree, may observe edits made after the run starts. Users should not edit the repository while a panel is running.

Generic-instruction lanes are told the canonical captured range.

The snapshot still provides stable report identity, diff-size checks, manifest generation, merge context, and downstream staleness detection.

---

## 5. Adapter contract

Adapters expose semantic operations:

1. `review` - invoke the vendor's own supported native review feature
2. `generic` - run a read-only agent with explicit user instructions

The distinction is architectural. `review` must not be implemented as a generic prompt like “review this diff.”

Each adapter declares `nativeReview: boolean`. This is consumed by configuration UX as well as execution.

### Claude Code

Claude's native review path is `/code-review`, invoked through non-interactive print mode.

Current rules:

- use canonical `/code-review` for both crbuddy target kinds; on Claude Code 2.1.223+ `/review` is an alias, but crbuddy uses the documented canonical spelling
- always pass an explicit local effort level; when config omits one, resolve to crbuddy's documented Claude default (`high`) rather than inheriting ambient interactive-session state
- pass crbuddy's captured git range as the target
- invoke it using the documented `claude -p "<query>"` shape
- enforce plan/read-only permissions

Anthropic's current documentation explicitly says a non-`ultra` `/code-review` run under `-p` runs in the foreground: Claude Code waits for the review and includes the findings in the response. That synchronous behavior is part of the adapter contract.

`ultra` is different. `/code-review ultra` selects **Ultrareview**, a separate cloud review product. In a `claude -p '/code-review ultra'` run Claude Code launches the remote review and returns a tracking link without waiting for findings; paid runs can consume usage credits. Therefore `ultra` is not a supported effort value for crbuddy's normal Claude lane and must be refused rather than passed through. A user who intentionally wants Ultrareview should use its dedicated blocking `claude ultrareview` subcommand outside the normal adapter until crbuddy explicitly models that separate product.

A known status-only response was observed during development: `Still waiting for the code-review skill's verification/synthesis stage to complete.` Because that violates the documented foreground contract for local `-p` review, crbuddy treats that response as `incomplete_review` rather than accepting a zero exit as completed findings.

### Codex CLI

Use Codex's native headless review subcommand rather than ordinary `codex exec` with a review prompt.

- uncommitted target: `codex exec ... review --uncommitted`
- branch target: `codex exec ... review --base <requested-base>`
- apply a read-only sandbox
- apply model/effort through Codex's own options

Capability probing must read the help surface where **the flags crbuddy itself passes** are defined. For Codex, sandbox/config/ephemeral options are `exec`-level flags, so probe `codex exec --help`; probing only `codex exec review --help` can falsely report a safe parent option as missing.

### Gemini CLI

No supported headless native code-review operation is currently modeled.

- implicit/native review is refused
- Gemini remains usable with explicit `instructions` as a generic read-only lane
- `init` must require those instructions rather than creating an unusable implicit lane

### Capability and safety probing

Vendor flags churn. Read the appropriate CLI help at preflight and construct argv from what that binary advertises.

- optional missing flag → drop it and warn
- required safety flag missing → refuse the lane
- known safety- and configuration-sensitive `vendorArgs` → refuse them using best-effort per-vendor matching; unknown flags are not proven inert
- Codex arbitrary `-c`/`--config` and profile selection through `vendorArgs` → refuse, because those flags select or alter configuration layers even when the constructed argv also contains `--sandbox read-only`
- unreadable help → assume support rather than making every lane fail because help parsing failed; minimum-version enforcement still applies

The help surface is adapter-specific. “Deepest subcommand” is not inherently correct; parent options may disappear from nested help output.

### Process handling

- direct spawn with argv arrays; never shell command strings
- neutralize shared stdin except when intentionally providing prompt input
- continuously drain child output
- time out every lane
- strip terminal control sequences from captured output
- kill process trees on cancellation
- support Windows `.cmd` shims through the platform spawning layer
- on POSIX systems (including macOS), place reviewers in their own process groups so cancellation reaches their child/helper processes

---

## 6. Execution model

### Blocking and concurrency

One `crbuddy go`, one terminal, wait. Discrete events are appended to terminal output, with a TTY-only live status line and terminal bell after successful completion. Recognized terminals with OSC 9;4 support also receive native indeterminate progress through output commit. Detection is conservative because OSC 9;4 collides with the older OSC 9 notification protocol: Windows Terminal and ConEmu are identified by their environment markers, while iTerm2 and Ghostty are version-gated. VS Code receives the progress state, but stock VS Code does not render it unless `${progress}` is present in the configured terminal tab title or description.

Panel entries run concurrently by default. `maxConcurrent: 0` means unlimited; the semaphore is still part of the execution path so a cap is a policy setting rather than an architectural rewrite.

### Timeouts and cancellation

Every review lane has a timeout.

Ctrl-C aborts the run and restores prior output. A second interrupt escalates process-tree termination.

Optional ntfy delivery has one terminal hook after run cleanup, gated on a
reviewer process having launched. It reports complete, partial or failed using
the existing result semantics. Pre-launch failures and cancellation during
reviewer work do not notify.
The final report is committed or printed before delivery; optional clipboard
UI runs only after delivery settles. Closing that menu, including with Ctrl-C,
cannot send another notification. Delivery uses built-in `fetch` in a short-lived
worker that is terminated after delivery or a two-second deadline, including
worker startup and connection setup. This closes pending TLS connections too;
aborting the fetch promise alone can leave them keeping Node alive. There are
no redirects or retries, and only a success flag crosses back from the worker.
A fixed warning reports unconfirmed delivery
without exposing the topic URL; a timeout cannot prove the push was not received.
Delivery never changes the review's output or exit code.

### Self-contamination

Previous output files must not become review input or break reviewer blindness.

Before reviewers start, existing output files are moved out of the review universe. On success they are replaced; on total failure they are restored. The `.crbuddy/` work area is excluded from the target.

Volatile state normally lives under `~/.crbuddy/state/`. After resolving
symlinks, crbuddy refuses a repository that contains that state root; otherwise
the location would expose previous output and concurrent lanes to reviewers.

A per-repository lock prevents two simultaneous crbuddy runs from racing output lifecycle operations.

### Output lifecycle

`output.merged` is the report file.

- at least one review succeeds → write every review, verbatim, to that file
- total reviewer failure → restore prior output and write no fresh report

Stage temp files on the destination filesystem, then rename into place.
Output destinations must name files; existing directories and filesystem roots
are rejected before any stash or commit operation.
Before moving an existing report aside, persist a recovery manifest. A
partial stash failure rolls completed moves back immediately; if that rollback
also fails, the manifest remains for the next run to recover.
Restoration is no-clobber: if another process recreates an output path while
reviewers run, keep the previous report in its holding directory rather than
replace the newer file. Temp-litter cleanup is likewise restricted to the
canonical destinations approved during preflight and refuses path redirection.

### Exit codes

- `0` - usable report produced; partial success also exits 0 by default
- `1` - no usable review produced / fatal startup failure
- `2` - partial success when `--strict` is requested

---

## 7. Effort

Effort is vendor-native and passed through verbatim **except when a vendor reuses an effort-looking token to select a different product or execution mode**. There is no portable crbuddy effort vocabulary and no translation/clamping layer.

Each adapter supplies advisory values and a default for the wizard. Config validation accepts any non-empty string so a vendor adding a new value does not normally require a crbuddy release before users can select it manually. The adapter may still refuse a reserved value whose semantics violate crbuddy's execution contract; Claude `ultra` is the current example because it selects asynchronous cloud Ultrareview rather than local synchronous review.

Native Claude review is additionally deterministic when effort is omitted from a hand-edited config: the adapter explicitly applies its documented default (`high`) rather than allowing Claude Code to reuse prior interactive state.

The applied value, when there is one, is shown in each lane's terminal progress label and in its report heading.

---

## 8. Consolidation (removed in 0.4.0)

Earlier versions could run an extra model pass that grouped findings from
different reviewers that appeared to describe the same defect, writing the
grouped report plus a second raw file. It never had authority to delete or
rewrite a finding, but it still cost a model run, a timeout, a failure mode,
and a second output file to do something the agent receiving the report
already does as it reads. crbuddy's job is to run the reviews and hand every
one of them over.

Configs from those versions still load. Their `merge`, `mergeTimeoutMs`, and
`output.raw` keys are the one exception to unknown keys being fatal: they are
ignored, `crbuddy go` says so, and `crbuddy config` saves the file without them.

A raw report an earlier version left inside the repository - at the configured
`output.raw` or the default `CODE-REVIEW-HANDOFF.raw.md` - is still crbuddy
output while it exists. It is excluded from the diff and moved aside while
reviewers run, and crash recovery accepts it, because a stash from before
0.4.0 may hold one next to the report. Unlike the report it is always put
back, since nothing replaces it. Paths outside the repository are left alone:
an ignored key does not get the consent such a path requires. The exception is
crash recovery for a global config, which is the user's own: a stash from
before 0.4.0 that holds such a path next to the report is restored whole. For the same
reason `crbuddy config` keeps a custom `output.raw` while the report it names
may still exist; only the default name is found without it.

---

## 9. Output format

The report is rendered from structured in-memory data. Markdown is never parsed back into internal state.

It begins with a visible report block giving the review count, failures,
warnings, target range, and file count; per-review headings and markers retain
vendor, model, applied effort, and stable lane IDs, and a compact hidden marker
retains the run ID.
Each successful review follows verbatim, in configured order.

HTML comments delimit human-navigation sections, but they are not parser boundaries because verbatim model output can contain the same strings.

---

## 10. Known version-sensitive surfaces

These are expected maintenance points rather than reasons to weaken the architecture:

- vendor minimum CLI versions
- vendor model and effort lists
- vendor CLI flags and their help hierarchy
- native review invocation syntax
- Claude local-vs-Ultrareview command semantics
- Codex parent/subcommand option placement
- Windows shim/process-tree behavior
- POSIX process-group behavior on macOS/Linux

`crbuddy doctor`/diagnostics should make version mismatches observable before a long paid run whenever possible.

---

## 11. Deliberately open

Repository-local crbuddy configuration and vendor configuration are trusted
inputs. Safe execution of configuration from an untrusted repository is not a
design claim.

- whether repeated identical model lanes should contribute equally to agreement ordering
- whether `init` should support a non-interactive mode
- whether model lists should stay advisory/hardcoded or be queried when vendors expose stable discovery
- whether a future design should remove project-local configuration from the trusted-input boundary for authenticated agents
- whether `vendorArgs` should invert from a per-vendor blocked set to an allowlist of known-inert flags; this would provide a stronger boundary but require crbuddy releases for newly added vendor flags
- whether report artifacts should eventually live outside the reviewed tree
- empirical measurement of the incremental value of a multi-vendor panel over the best single reviewer
