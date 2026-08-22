# crbuddy — design specification

A small local CLI that turns a repetitive multi-vendor code-review workflow into one command:
run one or more coding-agent reviewers independently, preserve their outputs, optionally group
duplicate findings, and write a handoff file for the coding agent that will act on them.

This document is the authoritative design. `README.md` is the short user-facing entry point;
`GUIDE.md` is the detailed user documentation. Where implementation and this file disagree,
treat the disagreement as a bug to resolve explicitly rather than silently changing the design.

---

## 1. Scope and non-goals

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
- no sampling/repeat knob; if a user wants two lanes, they configure two lanes explicitly
- no requirement that every vendor expose identical review controls

The implementation language is TypeScript/Node. Do not add a Rust or Go build merely to
produce a single binary; the target users already need Node for the coding CLIs.

---

## 2. Commands

### `crbuddy go [instructions]`

Run the configured panel. Blocking by design.

With no positional `instructions`, each panel entry uses its vendor's **native code-review
operation** when crbuddy has a supported headless native path for that vendor.

Supplying the positional `instructions` is an explicit override for the whole run. It
replaces every panel entry's configured `instructions`, which means those lanes run as generic
read-only agents under the supplied criteria instead of using the vendor-native review flow.
This is intentional: a user asking for a custom review task is choosing the generic operation.

Flags:

- `--force` — run despite `maxDiffBytes`
- `--strict` — return exit 2 when the run is only partially successful

### `crbuddy init`

Interactive configuration wizard.

### `crbuddy config`

Alias of `init`, intended for editing an existing configuration. Existing config is loaded
and edited rather than overwritten blindly.

### `crbuddy check`

Read-only diagnostics for installed vendor CLIs: presence, version, advertised flags, model
and effort lists known to this crbuddy release. It contacts no models and does not attempt an
authentication request.

`crbuddy doctor` is an alias.

---

## 3. Configuration

### Location and precedence

- global: `~/.crbuddy/config.json`
- project-local: `<repo>/.crbuddy/config.json`

A project-local config replaces the global config entirely. There is no implicit merging.
Panel-array inheritance is ambiguous and makes it difficult to answer "what actually ran?"

`extends` is reserved for a future explicit inheritance mechanism. Presence is invalid in
config version 1.

### Schema

Named fields only. Model and effort identifiers are vendor-native strings.

```jsonc
{
  "configVersion": 1,

  "output": {
    "merged": "CODE-REVIEW-HANDOFF.md",
    "raw": "CODE-REVIEW-HANDOFF.raw.md"
  },

  // "uncommitted" | { "base": "main" }
  "target": "uncommitted",

  "refuseIfOutputExists": false,
  "timeoutMs": 900000,
  "mergeTimeoutMs": 600000,
  "maxConcurrent": 0,
  "maxDiffBytes": 2000000,

  "merge": {
    "enabled": true,
    "vendor": "claude",
    "model": "opus",
    "effort": "high"
  },

  "panel": [
    {
      "id": "claude-opus",
      "vendor": "claude",
      "model": "opus",
      "effort": "high"
    },
    {
      "id": "security-codex",
      "vendor": "codex",
      "model": "gpt-5.6-sol",
      "effort": "xhigh",
      "instructions": "Review only for security defects."
    }
  ]
}
```

Unknown keys are fatal. A typo that silently disables a setting is worse than a failed run.

Panel IDs are stable provenance labels. If omitted during config creation they are generated;
reordering the panel must not renumber findings in a misleading way.

`vendorArgs` is an optional per-entry escape hatch for CLI flags crbuddy does not model.
It is not the normal configuration path.

### Wizard flow

1. choose global or project-local scope
2. detect installed vendor CLIs and parse versions
3. build the panel entry by entry: vendor, model, effort, optional instructions
4. configure consolidation
5. choose review target
6. write config

Detection establishes CLI presence/capability, not authentication.

---

## 4. Target resolution

crbuddy resolves the intended review target once at startup and records a canonical snapshot
for provenance. This gives the report a concrete identity even though vendor-native review
surfaces do not all accept the same kind of target selector.

### `uncommitted`

Defined as all tracked index/worktree changes plus all non-ignored untracked files relative
to HEAD, or relative to the empty tree when HEAD does not exist.

Implementation requirements:

- ignored files excluded
- untracked files included
- unresolved merge conflicts refuse the run
- output files and `.crbuddy/` excluded from the target
- linked worktrees supported by asking git for paths rather than assuming `.git/` is a directory
- empty target refuses quickly
- odd filenames handled with NUL-delimited git output
- the user's index and worktree are not modified while constructing the snapshot

A throwaway git index is used to build a tree and `commit-tree` produces a real snapshot
commit. The report records that object ID, the base object ID, a diff digest, changed-file
manifest, file count, and byte count.

### Branch target

`{ "base": "main" }` means review the current HEAD relative to the merge base with the
requested base ref.

Resolve and record:

- requested base string
- resolved merge-base object ID
- HEAD object ID
- canonical range

A shallow clone that cannot produce the merge base fails with a clear message. crbuddy does
not silently fetch history.

### Native review and target fidelity

The snapshot is authoritative **provenance**, but native vendor review commands are not a
uniform API.

Use the strongest native scoping primitive each vendor exposes:

- if the native review accepts an explicit range, give it crbuddy's captured range
- if it exposes selectors such as `--uncommitted` or `--base`, use those selectors
- do not replace a native review with a generic prompt merely to force a common target format

Consequently, crbuddy must not claim that every native lane is cryptographically pinned to
the identical snapshot. A vendor whose native review selects live uncommitted state can see
changes made after the run began. Users should not edit the repository while a panel runs.

Generic-instruction lanes are told the canonical captured range in their prompt.

The snapshot still matters for reproducibility, report provenance, diff-size checks,
manifest generation, merge context, and staleness detection by a downstream agent.

---

## 5. Adapter contract

Adapters expose **semantic operations** rather than caller-built command strings:

1. `review` — invoke the vendor's own supported native review feature
2. `generic` — run a read-only agent with explicit user instructions

The distinction is architectural. `review` must not be implemented as a generic prompt like
"review this diff" merely because that is easier to normalize across vendors.

### Current native behavior

#### Claude Code

Native review is driven through Claude Code's slash-command review surface in non-interactive
print mode.

- uncommitted target: `/code-review ...`
- branch target: `/review ...`
- where supported, pass crbuddy's captured range to the native review command
- enforce read-only/plan permissions

`/review` and `/code-review` behavior can change across Claude Code releases; adapter code
owns that vendor-specific knowledge.

#### Codex CLI

Use Codex's native headless review subcommand rather than ordinary `codex exec` with a review
prompt.

- uncommitted target: native review with `--uncommitted`
- branch target: native review with `--base <requested-base>`
- apply read-only sandboxing

This intentionally follows Codex's native target selectors even though they are less precise
than an arbitrary captured SHA range.

#### Gemini CLI

At the time of this design, crbuddy has no supported headless Gemini-native code-review
operation equivalent to the Claude/Codex paths.

Therefore a Gemini panel entry with no `instructions` is refused. crbuddy must not silently
pretend that a generic "review this diff" prompt is a native Gemini review.

A Gemini entry with explicit `instructions` is valid and runs in generic read-only mode.

### Generic operation

A generic lane receives the user's instructions plus the canonical target range and is run
read-only. This path is also used for the consolidation model, whose task is not code review.

### Capability detection

Vendor flags churn. At preflight, read the relevant CLI/subcommand `--help` and build argv
from what the installed binary advertises.

- optional missing flag: drop it and record a warning
- missing safety/read-only mechanism: refuse the lane
- user-supplied equivalent via `vendorArgs`: treat the requirement as explicitly handled
- unreadable help: assume support and allow the real invocation to fail clearly rather than
  disabling an otherwise working CLI on a parser failure

### Adapter responsibilities

Each adapter owns:

- native review invocation and target selector
- generic read-only invocation
- vendor-native model/effort options offered by `init`
- permission/read-only controls
- optional ephemeral/no-session-persistence controls
- version parsing and minimum supported version
- which output stream contains the final model response
- completion/failure classification

A non-zero exit code is the primary failure signal. Auth/rate-limit pattern matching is only
used to classify failed runs; model output is not scanned for failure keywords.

### Process handling

- spawn executable + argv directly; never construct shell command strings
- do not share/inherit stdin between parallel agents
- stream/drain child output so pipes cannot deadlock on backpressure
- strip ANSI control sequences from captured output
- tolerate invalid output as a lane failure rather than killing the panel
- support npm `.cmd` shims on Windows via `cross-spawn`
- terminate process trees, not only immediate children

---

## 6. Execution model

### Blocking UI

One `crbuddy go`, one terminal, wait.

State changes are appended as lines. On a TTY a live pulse/status line shows elapsed time and
active lanes. The completion bell is TTY-only so redirected/CI output contains no BEL bytes.

The terminal is progress UI. The durable review content is written to the configured output
file(s).

### Concurrency

Panel entries are independent and blind. By default they start without an artificial
concurrency limit. `maxConcurrent` places a semaphore in front of spawn; `0` means unlimited.

Rate limiting remains the user's policy problem.

### Timeouts

Every review lane has a timeout, and consolidation has a separate timeout. A hung vendor
must degrade to an ordinary lane failure rather than make the entire command unfinishable.

### Cancellation

First Ctrl-C begins process-tree termination and restores prior output. Second Ctrl-C
escalates to forced termination. An interrupted run writes no new report.

### Repository lock

Only one crbuddy run may own a repository at a time. Acquire the lock before cleanup or
output-stashing work so a losing invocation cannot delete another run's temporary files.

### Self-contamination

Previous output files are themselves visible repo files and must not contaminate the next
review or break reviewer blindness.

Before reviewers start:

1. recover any output stranded by an earlier interrupted run
2. move existing output files into a per-run holding directory under ignored `.crbuddy/`
3. exclude output paths and `.crbuddy/` from target construction

On success, discard the held copy. On total failure/interruption, restore it.

`refuseIfOutputExists` is a separate courtesy prompt, not the contamination mechanism.

### Output lifecycle

`output.merged` is always the user-facing deliverable path.

- consolidation succeeds: write `output.merged` plus `output.raw`
- consolidation disabled: write unmerged reviews to `output.merged`
- consolidation fails: write unmerged reviews to `output.merged`; do not leave an old merged
  result at the primary path
- every review fails: restore prior output and write nothing new

Writes use temp files on the destination filesystem and rename into place. Temp litter from
a crash is cleaned on the next run.

### Exit codes

- `0` — usable report produced; partial success is allowed by default
- `1` — no usable review produced / fatal preflight or configuration failure
- `2` — partial success when `--strict` is supplied
- `130` — interrupted run

Partial means one or more configured review lanes failed, or consolidation was requested and
failed, while at least one review still succeeded.

### Preflight

Fail before spending model time on:

- invalid configuration
- unresolved target/ref errors
- missing configured vendor CLI
- unavailable required safety controls
- oversized diff unless `--force`

Do not perform a real model authentication probe. Authentication failures surface as normal
lane failures.

---

## 7. Effort and model selection

Model and effort are vendor-native strings. crbuddy has no portable effort vocabulary and
no translation/clamping layer.

Each adapter publishes advisory model and effort lists for `init`. Those lists are stamped
with the CLI version they were written against. A newer installed CLI may support values the
wizard does not know; the wizard offers an "Other" escape and config validation accepts any
non-empty string.

The configured effort is passed through using the vendor's native mechanism. If the
installed CLI lacks the relevant optional effort control, crbuddy warns and records that no
effort value was applied rather than claiming the request took effect.

The report records requested model plus applied effort and detected CLI version.

---

## 8. Consolidation

### Authority boundary

The consolidation model has no authority to reject, rewrite, summarize away, or delete a
source finding.

It returns only relationships between finding IDs. crbuddy renders clusters from the
original reviewer text.

This is an architectural constraint rather than a prompt-only request. The safe failure mode
is under-grouping, not silent evidence loss.

### Pass 1: mechanical segmentation

Each successful reviewer output is segmented heuristically into findings. Segmentation is
lossless: reassembling segment text in order reproduces the original review.

A bad heuristic split may make a finding too broad or too narrow, but it may not discard
source bytes.

### Pass 2: model clustering

The consolidator receives, for each finding:

- finding ID
- reviewer/run ID
- best-effort title
- extracted file/line locations
- finding text, truncated only in the clustering prompt when necessary

It does **not** receive repository access and does not perform a second code review.

The truncation affects only duplicate-identification context; the original full finding text
is what is rendered into the output.

The model is asked to group findings only when the same corrective action would address the
same underlying defect. Similar file, line, component, symptom, or neighboring code is not
sufficient. When uncertain, keep findings separate.

### Validation

Reject the consolidation result unless:

- every input ID appears exactly once
- no unknown ID appears
- no finding appears in multiple clusters
- no effective empty cluster survives

If validation fails, fall back to unmerged reviews at the primary output path.

### Ordering

Order clusters by the number of **distinct successful reviewer lanes** represented in the
cluster. Ties prefer larger clusters, then a stable ID ordering.

Agreement is a reading-order heuristic, not a confidence score. Reviewer/model errors can be
correlated, and repeated/similar lanes can inflate agreement.

---

## 9. Output format

Both raw and consolidated markdown are rendered from structured in-memory data. crbuddy
never creates the consolidated report by parsing its own raw markdown.

YAML frontmatter records provenance, including:

- crbuddy version and report kind
- run ID and generation timestamp
- config source
- target kind, snapshot, base, optional requested base/merge base, digest, file and byte counts
- configured/succeeded/failed run counts
- failed lane IDs/vendors/reasons
- adapter ID, CLI/version, requested model, applied effort, wall-clock time
- merge state and merge failure reason when applicable

A visible report block summarizes completion and target information for rendered Markdown.

Raw reviews are delimited with HTML comments for navigation, and consolidated output adds
cluster/finding comments. These comments are **not parsing boundaries**: reviewer text may
contain the same marker strings. They are for humans and downstream convenience only.

When consolidation succeeds, the consolidated report points to the raw audit-trail filename.
The original reviewer text is preserved inside finding blocks.

---

## 10. User-facing caveats

These belong in `GUIDE.md`:

- native vendor review surfaces do not all accept the same exact target selector; don't edit
  the repo during a run
- reviewer agreement is ordering information, not confidence
- vendor project instructions (`CLAUDE.md`, `AGENTS.md`, settings, commands) are loaded by
  the vendor CLI and can affect its review
- model/effort lists are advisory and vendor-version-sensitive
- a CLI being installed does not prove it is authenticated
- parallel lanes can hit subscription/provider rate limits
- Gemini currently requires explicit instructions because no supported headless native
  review operation is available
- Windows shim/process behavior is version-sensitive; `crbuddy check` is the diagnostic path

---

## 11. Deliberately open

- whether `init` should gain a fully non-interactive mode
- whether vendor model lists should remain hardcoded/advisory or be queried where possible
- whether project-local config needs an explicit first-use trust acknowledgement
- whether future native vendor review APIs will permit stronger identical-snapshot guarantees
  without sacrificing the native review behavior
- whether per-vendor concurrency limits become necessary in addition to global
  `maxConcurrent`

Do not expand these into features merely because they are listed here; they are unresolved
design space, not a roadmap.
