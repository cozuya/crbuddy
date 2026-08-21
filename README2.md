# crbuddy — detailed documentation

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
trail. With consolidation off — or if it fails — the primary file holds the
reviews unmerged, with a header saying so. The filename you point an agent at
never changes.

It's blocking on purpose — run it in a spare terminal. There's no daemon, no
`status` command, and no resumability, because a second terminal solves that
for free.

## Differences from `ai-jury`

[`ai-jury`](https://github.com/berkayturanci/ai-jury) is the closest existing
tool I know of to crbuddy. The overlap is real: both are local-first CLIs that
can fan code review across multiple vendors in parallel and produce one report.
If that were the whole design, there would be little reason for crbuddy to
exist.

The two tools make a different choice about what the multi-model layer is
*for*.

**crbuddy is an evidence collector and handoff tool.** It automates the review
process you might otherwise do manually: invoke each vendor's own code-review
product, keep those reviewers independent, preserve their results, optionally
group duplicates, and hand the resulting evidence to the coding agent that is
already controlling or implementing the work.

**ai-jury is a deliberative review system.** Its first round is independent,
but later rounds intentionally show reviewers each other's findings so they can
cross-examine them. A chair then verifies findings against the code, can drop
false positives, and synthesizes a verdict; alternatively the panel can vote.
Its current documentation describes the pipeline as independent review →
cross-examination → verification → synthesis/verdict:
[ai-jury: How it works](https://ai-jury.dev/#how-it-works).

That difference propagates through almost everything else.

| | crbuddy | ai-jury |
|---|---|---|
| Primary purpose | Automate several independent reviews and create a handoff for another coding agent | Convene a multi-agent jury and reach a review verdict |
| Review primitive | The vendor's native review operation where one is available | Headless agent/provider invocation under ai-jury's review protocol |
| Claude review | Native `/code-review` / `/review` flow | Headless `claude -p` reviewer |
| Codex review | Native Codex review flow | Headless `codex exec` reviewer |
| Reviewer blindness | Reviewers remain blind to each other for the entire run | Round 1 is independent; later rounds cross-examine other reviewers' findings |
| Consolidation authority | Duplicate grouping only; original findings survive verbatim | Verification can reject false positives; chair synthesizes the surviving findings |
| Final decision | None. crbuddy does not decide whether the code is good | Chair verdict or panel vote |
| Intended consumer | Usually another coding agent that will inspect/fix the code | Human/CI/GitHub workflow consuming a verdict and report |
| Credentials | Holds no model credentials; uses already-authenticated local vendor CLIs | Supports coding CLIs, hosted APIs, and local/open-weight engines |
| Provider surface | Intentionally small vendor-adapter surface | Broad provider surface: coding CLIs, APIs, local models, arbitrary CLI agents |
| GitHub awareness | None required; reviews local git state / branch targets | First-class PR and issue review, posting, and GitHub Action support |
| CI role | Produces review artifacts; optional strict exit behavior | Full CI gating, JSON/SARIF, PR comments, classification and related workflow features |
| Extra orchestration | One review round plus optional duplicate grouping | Debate rounds, verification, auto-depth, caching/incremental review, chunking, replay/theater, etc. |

### "Native CLI" means something different here

This naming is easy to misunderstand because both projects use vendor CLIs.
ai-jury correctly describes itself as using native coding-agent CLIs: Claude
runs through `claude`, Codex through `codex`, and so on. Its orchestrator then
supplies the review protocol to those headless agents. At the time this section
was written, its public diagram showed `claude -p` and `codex exec`, and its
architecture described an adapter as turning a prompt into a headless
subprocess.

crbuddy uses "native review" more narrowly. With no custom instructions, it is
trying to invoke the **review feature the vendor itself ships** — for example
Claude Code's `/code-review` flow or Codex's review command — including the
vendor's own review behavior and heuristics. crbuddy does not try to reproduce
those behaviors with a universal review prompt.

If a vendor does not expose a usable headless native review operation, crbuddy
should not silently pretend that a generic agent prompt is equivalent. A panel
entry with explicit `instructions` is the opt-in escape hatch: that lane is
then intentionally a generic read-only agent run.

### Blind evidence vs deliberation

This is the architectural distinction that matters most.

In crbuddy, reviewer A never learns what reviewer B found. A finding from
Claude cannot anchor Codex toward the same conclusion, and Codex cannot talk
Claude out of a finding. The panel produces multiple pieces of evidence that
remain independently generated.

The consolidation model sees the completed findings only after review is over,
and its authority is intentionally tiny: it may say "these finding IDs appear
to describe the same defect." It cannot adjudicate whether the defect is real.
Every input finding ID must appear exactly once in the result or consolidation
is rejected.

ai-jury intentionally does more. Its own documentation says that after the
independent first round, agents see the other reviews and emit agree/dispute/
missed responses. The verification stage then re-judges candidate findings and
drops false positives before the chair synthesizes a verdict. That is useful if
you want the review system itself to make the final judgment. It is a different
information flow from crbuddy.

### Why would I use one instead of the other?

Use **ai-jury** if you want a full review system: broad provider support,
PR/issue integration, cross-examination, false-positive verification, a final
APPROVE/COMMENT/REQUEST-CHANGES decision, CI gating, local models, hosted APIs,
large-diff machinery, and the rest of its considerably larger feature surface.
It is the more capable general-purpose product.

Use **crbuddy** if you already have a coding-agent workflow and the annoying
part is repeatedly opening several vendor tools, choosing their models/effort,
running each vendor's normal code review, copying the answers together, and
feeding them back to the agent doing the work. crbuddy tries to make exactly
that operation one command without turning the reviewers into a debating jury
or inserting another model as the authority that decides which findings are
true.

This is a point-in-time comparison of public behavior, not a claim that
`ai-jury` will always work this way. Its feature set changes quickly; see its
[current documentation](https://ai-jury.dev/) for the current version.

## Commands

| | |
|---|---|
| `crbuddy init` | Interactive setup. Writes a config. |
| `crbuddy config` | The same command; edits an existing config. |
| `crbuddy go [instructions]` | Run the panel. |
| `crbuddy check` | Report which vendor CLIs are usable, which flags they accept, and why not. Read-only; contacts no models. Also aliased as `doctor`. |

The optional positional argument to `go` overrides the review instructions on
**every** panel entry, for a one-off run without editing config:

```
crbuddy go "focus only on error handling and resource cleanup"
```

Flags: `--force` runs despite an oversized diff, `--strict` exits 2 on partial
success.

## Configuration

Global at `~/.crbuddy/config.json`, or per-repository at
`.crbuddy/config.json`. **A project-local config replaces the global one
entirely** — there is no merging, because merging arrays of panel entries is
ambiguous and makes "which panel actually ran?" hard to answer.

```jsonc
{
  "configVersion": 1,

  "output": {
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
    { "vendor": "codex", "model": "gpt-5.6-sol", "effort": "xhigh" },
    {
      "id": "security",
      "vendor": "gemini",
      "model": "gemini-2.5-pro",
      "instructions": "Review only for security issues: injection, authz, secrets handling."
    }
  ]
}
```

Other keys, all optional: `refuseIfOutputExists` (default `false`),
`timeoutMs`, `mergeTimeoutMs`, `maxConcurrent` (`0` = unlimited),
`maxDiffBytes`.

Unknown keys are a hard error. A typo that silently does nothing is worse
than a failed startup.

### Panel entries

`instructions` is optional. Without it, the adapter runs that vendor's native
review behavior. With it, the adapter runs a generic read-only agent given
those instructions.

`vendorArgs` is an escape hatch — extra argv appended verbatim — for reaching
a flag crbuddy doesn't model.

### Effort

Effort values are **vendor-native and passed through verbatim**. There is no
crbuddy effort vocabulary and no translation.

`crbuddy init` offers each vendor's own values — Claude Code's `low` through
`max`, Codex's `none` through `max`, nothing at all for a CLI without an
effort setting — plus an "Other…" escape for anything the shipped list
doesn't cover. Whatever you pick is written to config and handed to the CLI
unchanged.

An earlier design had a portable vocabulary (`low | medium | high | max`)
translated and clamped per vendor. It was removed. `model` was already a
vendor-native string in config, so an abstract `effort` alongside it was
inconsistent; and clamping could silently downgrade a run, which then needed
version stamps and clamp reporting to detect. Passing the value through
deletes the failure mode instead of instrumenting it. An unusable value now
fails fast, attributed to the lane that used it.

Omit `effort` to pass no flag at all.

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
provenance, but vendor-native review surfaces are not identical APIs. Some can
consume a specific range and some expose selectors such as uncommitted changes
or a base branch. Don't edit while a panel is running; otherwise a native
reviewer that selects live repository state may observe a different tree.

**Vendor project files are loaded by design.** Running inside your repo means
each CLI picks up that repo's own `CLAUDE.md`, `AGENTS.md`, project-local
commands, and settings. That's usually what you want, and it's also the most
likely explanation for a run that behaves nothing like it does elsewhere.

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
finding that's too large or too small — never one that's missing.

**Flags are detected, not assumed.** Vendor CLI flags churn between
releases, and a flag your version doesn't have produces a usage error that can
look like a crbuddy bug. At preflight crbuddy reads each CLI's own `--help` and
only passes what it advertises. Optional flags that are missing get dropped
with a warning; a missing **safety** flag — read-only enforcement — refuses
that lane instead. If your CLI supports a flag but doesn't advertise it
parseably, pass it yourself via `vendorArgs`. `crbuddy check` shows what was
detected.

**Preflight checks presence, not authentication.** crbuddy verifies the vendor
binary exists and reports a version. It does not probe whether you're logged
in: there's no uniform, free way to do that across vendors, and a wrong check
rots per vendor. An expired login shows up as a lane failure.

**Concurrency is unmanaged by default.** Six entries means six subprocesses.
That will hit per-subscription rate limits well before it hits your machine.
Set `maxConcurrent` if it bites.

**Reviewers are forced read-only, or refused.** Each adapter passes its
vendor's read-only/sandboxing mechanism when needed, and if crbuddy cannot
establish a safe native invocation that lane is refused rather than run
permissively.

**Ctrl-C aborts and writes nothing.** A partial panel is worse than no panel,
because a consuming agent can't tell it's partial. The previous review is
restored. Press it twice to stop waiting for children to exit politely.

**Windows.** npm-global CLIs install as `.cmd` shims, and Node refuses to
spawn those without a shell in some cases. Spawning goes through `cross-spawn`
on Windows to resolve shims correctly, and process-tree termination uses
`taskkill /T`. If a vendor still shows as missing, `crbuddy check` prints the
actual reason.

## How output is structured

YAML frontmatter carries provenance: the captured snapshot and base SHAs, the
diff digest, per-run CLI versions and applied effort, failures with reasons,
and any clamps. A visible report block summarizes the same thing for a human
skimming rendered markdown.

HTML comment markers delimit reviews, clusters, and findings. **They are
navigation aids, not a parsing boundary** — a model's verbatim output can
contain the closing marker. Both files are rendered from structured data;
nothing in crbuddy parses markdown back out of them.

## Exit codes

| | |
|---|---|
| `0` | Panel completed, and consolidation if enabled |
| `1` | No usable review produced |
| `2` | Partial success — only with `--strict` |

Partial success exits `0` by default so `crbuddy go && agent ...` doesn't
break on one flaky vendor. Use `--strict` in a hook where that matters.

## Status

Prototype. The pure-logic surface — config, target resolution, merge
validation, rendering, and adapter dispatch — has unit tests. Vendor CLIs
change quickly, so the native adapter layer is the most version-sensitive part
of the program. Run `crbuddy check` on the machine that will actually execute
the panel.

See `DESIGN.md` for why things are the way they are, including the non-goals.

## License

MIT
