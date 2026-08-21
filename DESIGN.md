# crbuddy — design specification

A CLI that fans one code review out across several vendor coding agents in parallel,
each blind to the others, and collects the results into one markdown file intended to
be consumed by a coding agent that will make the fixes.

This document is the authoritative design. Decisions here were reached deliberately and
several of them are deliberately *not* the obvious choice. Where a decision has a
rationale attached, the rationale exists to stop the decision being "helpfully" reversed.
If you think something here is wrong, say so — do not silently implement the alternative.

---

## 1. Scope and non-goals

**Is:** a small, local, blocking CLI. Global npm install. Runs the user's own already-
authenticated vendor coding CLIs as subprocesses. Produces markdown.

**Is not, deliberately:**

- Not a daemon. No background mode, no `status` subcommand, no resumability, no state directory.
- Not a hosted service. crbuddy holds no model credentials of any kind.
- Not a fix applier. It produces a report; something else acts on it.
- No sampling knob. An earlier design had a per-entry repeat count. It was cut: two entries
  with the same model express the same thing, and the evidence that repeated samples of one
  lane add information for open-ended review is weak (self-consistency's gains are on tasks
  with a unique checkable answer; code review is not one). Do not re-add it.
- No cross-invocation state. One run produces one report describing the current tree.
  Re-invoking overwrites. No reconciling last week's findings against changed code.

### Distribution

npm, global install (`npm i -g crbuddy`). Node is already present on the target user's
machine because the vendor CLIs need it. Do not add a Rust/Go build.

---

## 2. Commands

### `crbuddy go [instructions]`

Runs the panel. Blocking — the user runs it in a spare terminal and waits.

The optional positional argument is a review instruction that **overrides `instructions`
on every panel entry**, for a one-off "run this panel for X" without editing config.

### `crbuddy init`

Interactive setup wizard. Writes a config file.

### `crbuddy config`

Same implementation as `init`. Two names for one command. `init` is the discoverable name
for first use; `config` is the name people reach for later. Both load-and-edit an existing
config rather than overwriting it.

---

## 3. Configuration

### Location and precedence

- Global: `~/.crbuddy/`
- Project-local: in the repo.

**A project-local config replaces the global one entirely.** No implicit merging. Array
merging for `panel` is ambiguous (append? by model? by index?) and implicit inheritance
makes "what panel did this repo actually request?" hard to answer.

Reserve, but do not implement yet, an explicit `extends` key so inheritance can be added
later without breaking configs that relied on omission meaning "unset."

Include `configVersion` from the first release. The schema will change.

### Schema

Named fields throughout. No positional tuples — they are position-sensitive and make
future additions awkward.

```jsonc
{
  "configVersion": 1,

  "output": {
    "merged": "CODE-REVIEW-HANDOFF.md",
    "raw": "CODE-REVIEW-HANDOFF.raw.md"
  },

  // "uncommitted" | { "base": "main" }
  "target": "uncommitted",

  // Off by default. When true, `go` refuses to start if an output file already
  // exists and prompts the user to delete it. See §6 for why this is not the
  // mechanism that protects against self-contamination.
  "refuseIfOutputExists": false,

  "merge": {
    "enabled": true,
    "model": "…",
    "effort": "high"
  },

  "panel": [
    {
      "id": "opus-default",        // stable, used in provenance; optional, generated if absent
      "model": "…",                 // vendor + model
      "effort": "high",             // crbuddy's vocabulary — see §7
      "instructions": "…"          // optional; see §5
    }
  ]
}
```

`panel` entries carry stable IDs so provenance reads `security-opus` rather than
`entry 3`, and so reordering the array doesn't renumber the report.

### `crbuddy init` / `crbuddy config` flow

1. **Global or project-local.** First question.
2. **Detect available vendor CLIs.** The panel a user can build is bounded by what is
   installed. Detection drives the rest of the wizard. Detection is binary-exists plus
   version-parses — see §9 on why it is not an auth probe.
3. **Build the panel.** Per-entry walkthrough: model, effort, optional custom instructions.
   Repeat until done. Not presets — the walkthrough is the primary path.
4. **Merge settings.** Enabled; if so, model and effort.
5. **Review target.**
6. Write.

If a config already exists at the target path, load it and edit it. Never overwrite blind.

---

## 4. Target resolution

crbuddy owns the definition of what is under review. Do not delegate this to the vendors.

### `uncommitted`

Defined as: **all tracked changes in the index and working tree, plus all non-ignored
untracked files, relative to HEAD; relative to the empty tree if HEAD does not exist.**

Note that plain `git diff` does not show untracked files. Untracked files are in scope and
must be included, via intent-to-add or equivalent.

Explicit handling required for:

- ignored files — excluded
- intent-to-add entries
- unmerged / conflicted index entries — **refuse to run** in v0.1; "review my changes"
  is too ambiguous mid-conflict to normalize
- dirty submodules — treat as opaque gitlinks, report as uncovered
- symlinks, binary files
- empty diff — refuse fast, do not spend five minutes reviewing nothing
- repo with no commits, shallow clone, sparse checkout, linked worktrees

Resolve the worktree root via git, not by looking for a literal `.git/` directory —
linked worktrees and submodules use different layouts. Output paths are relative to the
worktree root, not the shell's cwd.

### Branch target

Resolve all symbolic refs at startup and record resolved OIDs. Report the requested base,
the resolved base OID, the head OID, and the merge-base OID — not merely `base: main`.

A shallow clone may lack the merge base. Fail with a clear message; do not silently fetch.

### Pinning

**Capture the target as a git object before starting any run.** `git stash create` (or
equivalent plumbing) produces a commit representing the exact working state without
touching the tree.

Every run is then told to review `<base>..<snapshot-sha>`. This:

- composes with vendor review commands that accept a range argument (see §5)
- removes the need to inject a large diff as prompt text, which would hit Windows'
  command-line limit and vendor prompt ceilings
- makes the changeset immune to the tree mutating mid-run
- gives you a SHA to stamp into the report, which the consuming fix-agent needs to detect
  staleness

File reads by the agents are still against the live tree. Document that; the *diff*
guarantee is what's being made.

Also compute and record a diff digest, a changed-file manifest (status + path), and byte/
file counts. The manifest matters for binaries, renames, and submodules where diff text
alone is insufficient, and it feeds the merge step.

**Diff size guard:** warn, or refuse without a flag, past a threshold. A lockfile-heavy
diff otherwise produces N expensive reviews of silently truncated context.

---

## 5. Adapters

### The invocation is semantic, not a string

An adapter exposes a **review operation**, not a command line. The two operations are:

1. native review of the crbuddy-resolved target
2. generic read-only agent run with custom instructions

The vendor's own slash command or subcommand is an *implementation detail of the adapter*.

This matters because vendor review commands are **scope-selecting operations** — they
compute their own target. Passing `/review` as an opaque string while also claiming every
run reviews an identical changeset is a contradiction. It is also already wrong at the
command level: Codex exposes `codex review` as a command distinct from `codex exec`, and
some Claude review paths behave differently under `-p` than their interactive form.

Config therefore carries `instructions` (the user's criteria, verbatim) separately from
the choice of operation. The `go` positional argument overrides `instructions`, not the
operation.

Keep a raw escape hatch (per-entry `vendorArgs`) for users who need to reach a flag the
adapter doesn't model. It is the escape hatch, not the normal path.

### Flag capability detection

Vendor flags churn. crbuddy reads each CLI's own `--help` at preflight (for the exact
subcommand it will invoke) and builds argv from what that binary advertises.

- **Optional flag missing** → dropped, warning recorded in the run and the output header.
- **Safety flag missing** (read-only enforcement) → the lane is REFUSED. Running a reviewer
  that can edit the working tree changes the changeset under review, so degrading is not an
  option here.
- **Escape hatch** → if the user already passes an equivalent flag in `vendorArgs`, the
  requirement is considered met. Help output is not a perfect oracle, and a flag the CLI
  supports but does not advertise parseably must not permanently block a working lane.
- **Help unreadable** → assume support. Failing closed there would break every lane on one
  unparseable `--help`, which is worse than one clear usage error.

Terminal failure lines carry the first line of the CLI's own stderr; `exit_2` with no
detail sends the user digging through the raw file for something crbuddy already had.

### Adapter responsibilities

Each adapter defines, per vendor:

- how to invoke a review of a given git range, non-interactively
- how to invoke a generic read-only run with instructions
- the effort mapping (§7)
- **explicit non-interactive permission settings.** A subprocess is not non-interactive
  merely because you expect it to be. Codex's current guidance is explicit `-a never` plus
  a read-only sandbox rather than the deprecated `--full-auto`. Reviewers never need write
  access; pass read-only unconditionally. This does not conflict with letting project
  files (CLAUDE.md, AGENTS.md) supply context.
- **ephemeral session flags** where available (`codex exec --ephemeral`, Claude's
  no-session-persistence equivalent) so N reviews don't clutter vendor history
- what constitutes the final model output versus diagnostics. Codex streams progress to
  stderr and prints only the final agent message to stdout — "verbatim output" cannot mean
  concatenating both.
- what constitutes success. Exit code is primary, plus a small set of known failure
  patterns. A zero exit with blank or malformed output is not a successful review.
- minimum supported CLI version, and record the detected version per run

### Process handling

- **Never build shell command strings.** Arbitrary instruction text, paths with spaces,
  quotes, metacharacters. Use direct spawn with an argv array.
- **Windows:** global npm installs are `.cmd` shims, which changes both spawning and
  argument escaping. Node's Windows signal behavior also differs. If Windows is untested,
  say so in the README.
- **stdin must not be shared or inherited.** If any supposedly non-interactive CLI hits an
  approval or login prompt, N processes will compete for the same terminal. Neutralize
  stdin; if a vendor wants interaction anyway, fail that lane rather than hang.
- **Stream output to per-run temp files.** Do not accumulate N large strings in memory,
  and drain all child pipes continuously or they backpressure the child.
- **Strip ANSI escapes** from captured output; some CLIs emit color even when piped.
- **Encoding:** assume UTF-8, but one CLI emitting an invalid byte must not kill the panel.
  Mark that lane malformed and preserve diagnostics.

---

## 6. Execution model

### Blocking

One `crbuddy go`, one terminal, wait. Discrete events append lines; scrollback beats a
spinner when a run misbehaves. Terminal bell at the end, **TTY only** (don't put BEL bytes
in CI logs). No intermediate report.

On a TTY there is additionally one live status line pinned to the bottom (spinner, elapsed,
which lanes are still running). A multi-minute wait with a frozen screen is
indistinguishable from a hang. It is strictly additive: off a TTY nothing renders, so piped
and CI output stays append-only.

Two weights: full brightness for state changes and anything actionable, dim for everything
else. A periodic "still going" line was tried and removed — the live line already carries
elapsed time, so the interval line was redundant noise.

### Concurrency

Unmanaged by default: N configured runs means N subprocesses. Rate limiting is the user's
problem.

**But put a semaphore between config and spawn from day one**, defaulted to unlimited.
Adding `maxConcurrent` later then becomes a policy change rather than an execution-engine
rewrite. Per-vendor concurrency is the more useful second dimension if it's ever needed.

Before shipping, verify empirically that two parallel runs of the same vendor CLI in one
repo do not fight over lock or session state. If they do, per-vendor serialization is v0.1,
not v2.

### Timeouts

**Every run has a timeout.** Non-negotiable, and the reason is structural: without one, a
hung lane means the completion signal never fires and the user's only remedy is Ctrl-C,
which by design destroys every completed review. A timeout converts a hang into an ordinary
lane failure, which the reporting path already handles. Separate timeout for the merge step.

### Cancellation

Ctrl-C aborts everything and leaves no output.

This requires **process-tree termination**, not child termination — vendor CLIs spawn
shells, MCP servers, helper processes. Process groups on POSIX, job/tree termination on
Windows. Graceful interrupt, then forced. A second Ctrl-C escalates. Note that installing
a Node SIGINT handler removes the default behavior, so exiting becomes your responsibility.

### Self-contamination

This is the default lifecycle, not an edge case: `CODE-REVIEW-HANDOFF.md` sitting in the
repo root is an uncommitted file, so the next run reviews the previous run's review.
Excluding it from the diff is not sufficient — agents read the repo freely and can open it,
which also breaks blindness.

**Mechanism:** before the panel starts, move existing output files out of the review
universe (into a gitignored `.crbuddy/` or outside the repo). On success, replace them with
the new output. On total failure, restore them. This protects against contamination without
destroying the prior review.

`refuseIfOutputExists` (default false) is a separate, optional courtesy for users who want
to be asked before crbuddy touches an existing file at all. It is not the contamination
mechanism.

The `.crbuddy/` working directory must itself be excluded from the target, since untracked
files are in scope.

### Holding directory

Stashed outputs go in a PER-RUN holding directory. A shared one is unsafe: a hard stop
mid-run strands files there, and the next run — which stashed nothing of its own — would
delete the whole directory on failure, taking the stranded report with it. Each run also
recovers anything stranded by a previous one before stashing its own.

### Output files

`output.merged` is ALWAYS written and is always the deliverable. `output.raw` is written
only when consolidation succeeded, as the audit trail.

Anything else means the filename a user points a fix-agent at sometimes does not exist —
or, worse, is a stale artifact from a previous run sitting beside fresh reviews under a
different name.

### Writing output

- Stage temp files **on the destination filesystem** (beside the output), not in `/tmp` —
  cross-filesystem rename is not atomic and may not be a rename at all.
- Two renames are not one transaction. Write raw first, then merged. The merged file
  references the raw file's `runId`; a mismatch means one of them is stale.
- Every run gets a `runId` used in both outputs, temp filenames, and terminal diagnostics.
- **Take a per-repository lock.** Two concurrent `crbuddy go` invocations otherwise race,
  and atomic rename does not help — the slower one wins.
- Clean up temp litter on the next run; a crash leaves it behind.

### Exit codes

`0` on total failure only… no. Specifically:

- `0` — panel and merge completed as requested
- `1` — no usable review produced
- `2` — **reserved** for partial success

v0.1 may return `0` for partial success (matching the earlier decision), but reserve `2`
now so `--strict` can be added later without breaking anyone's hook. The motivating case:
merge crashes, five reviewers succeed, exit 0, and `crbuddy go && agent CODE-REVIEW-HANDOFF.md`
feeds the agent yesterday's merged file.

Merge failure is reported separately from reviewer failure — the merge is not a panel run.
On merge failure: raw output only, warn, and fall back cleanly.

### Preflight

Refuse to start on invalid config, or on a named vendor CLI that is missing or fails a
version check.

Do **not** attempt a real authentication probe. There is no uniform, free auth check across
vendors; it may cost a request, may be impossible without one, and will rot per vendor.
Auth failure surfaces as a fast lane failure in the first seconds, which the reporting path
already handles. Call this phase `preflight`, and don't promise it guarantees all runs can start.

---

## 7. Effort

**Vendor-native, passed through verbatim.** There is no crbuddy effort vocabulary and no
translation layer.

Each adapter declares the effort values its CLI accepts, plus a default. `init` offers that
list (skipping the question entirely for a CLI with no effort control) with an "Other"
escape, and stores the chosen string. `go` passes it to the CLI unchanged.

Config validation accepts any non-empty string. Validating against a hardcoded list would
mean a vendor adding a level breaks configs until crbuddy ships a release — the exact rot
this design exists to avoid. An unusable value surfaces as a fast, attributed lane failure.

An earlier design had a portable vocabulary translated and clamped per vendor. It was cut
for two reasons: `model` is already a vendor-native string in config, so an abstract
`effort` beside it was inconsistent; and clamping could silently downgrade a run, which then
required version stamps, clamp records in the output header, and staleness warnings purely
to detect damage the translation layer itself caused. Removing the layer removed all of it.

The per-vendor version stamp survives, scoped to `init` and `doctor`: it tells the user the
shipped model and effort lists may be incomplete for their CLI version. It does not affect
what runs.

## 8. Merge

### The rule

**The merge model has no authority to remove or rewrite any source finding.**

It receives enumerated findings and returns **relationships** — which source IDs describe
the same defect. crbuddy renders the clusters mechanically from the original text.

This is architectural, not a prompt instruction, because the identity/correctness boundary
is conceptually leaky: deciding whether two findings are "the same" often *is* correctness
reasoning (same symptom / different root cause versus the reverse). You cannot prompt your
way out of that, so remove the authority instead.

Failure mode becomes visible under-deduplication rather than silent deletion.

### Two passes

1. **Segment.** Per run, split freeform output into an enumerated finding list with IDs.
2. **Cluster.** Group the enumerated findings across runs.

Clustering freeform blobs directly invites the model to summarize, which is to say destroy.

### Validation

Mechanically enforce, after pass 2:

- every input finding ID appears
- exactly once
- no unknown IDs
- no empty clusters

Reject and fall back to raw-only if validation fails.

### What the merger sees

Finding text, file/line locations, the changed-file manifest, and the pinned diff.
**No repository access.** Under the keep-both-when-unsure rule, ambiguity is already handled
safely, so code access buys little and mainly creates opportunities to adjudicate.

### Tie-break

Group only when the findings describe the same underlying defect such that fixing one
addresses the other. Same file is not sufficient. Same line is not sufficient. Same symptom
is not sufficient. When unsure, emit singletons.

Beware transitivity: A≈B and B≈C should not blindly connected-component into {A,B,C} when B
is an overly broad finding. Require each cluster to express one coherent defect identity.

### Ordering

Sort clusters by how many distinct vendors raised them. This is mechanical, requires no
correctness judgment, and is the priority signal a fix-agent needs.

Note the honest caveat, for the docs: cross-model agreement is a weak correctness signal.
Published measurements put agreement-versus-correctness correlation in the 0.2–0.6 range,
and models err in correlated ways — larger models more so, across vendors. Agreement counts
are a useful ordering heuristic and should not be presented as confidence.

---

## 9. Output format

Two files. The merged one is the deliverable; the raw one is the audit trail.

```markdown
---
crbuddy:
  version: 0.1.0
  runId: …
  generated: …
  target:
    kind: uncommitted
    snapshot: <sha>
    base: <sha>
    digest: …
    files: 23
  runs:
    configured: 6
    succeeded: 5
    failed: 1
  failures:
    - { id: codex-high, reason: rate_limited, exit: 1 }
  clamps:
    - { id: opus-max, requested: max, applied: high, vendorNative: "…" }
  adapters:
    - { id: opus-max, cli: "claude", cliVersion: "…", modelRequested: "…", modelActual: "…", wallClockMs: … }
---

<!-- crbuddy:report -->
**5 of 6 reviews completed.** …
<!-- /crbuddy:report -->

<!-- crbuddy:review id=opus-max -->
…
<!-- /crbuddy:review -->
```

Frontmatter is only frontmatter at byte 0, so a review emitting `---` cannot be mistaken
for it. The visible report block exists because an HTML comment alone is invisible in
rendered markdown.

**The HTML comment markers are for humans, not machines.** A model's verbatim output can
itself contain the closing marker. Do not parse them as a boundary — the merged file is
rendered from validated structured data, not parsed back out of markdown.

---

## 10. Documented caveats

These belong in the README, not buried:

- Agreement counts order findings; they are not a confidence score.
- Agents read the live tree even though the diff is pinned.
- Vendor project files (CLAUDE.md, AGENTS.md, project-local commands) are loaded by design
  and will influence reviews.
- Effort levels are crbuddy's vocabulary and are clamped per vendor; the applied native
  value is recorded per run.
- Windows support status.

---

## 11. Deliberately open

- Whether `init` should be runnable non-interactively, and whether it should refuse when
  stdin is not a TTY.
- Where the per-vendor model list comes from: hardcoded (rots) versus queried from the
  vendor CLI (may not be uniformly queryable).
- Project-local config as a trust boundary. A cloned repo's config can name output paths
  and instructions that cause authenticated agents to run. Minimum for v0.1: output paths
  must resolve inside the repo, colliding output paths are rejected, unknown config keys
  are fatal. A first-use trust acknowledgement is a later concern.
