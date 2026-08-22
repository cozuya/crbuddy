# crbuddy

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

`crbuddy go` resolves what's under review, pins it as a git object, and runs
every configured entry against that same pinned range. Each run is an
independent reviewer with no knowledge of the others. When they finish, an
optional consolidation pass groups findings that appear to describe the same
defect.

**`CODE-REVIEW-HANDOFF.md` is always the deliverable.** With consolidation
on it holds findings grouped and ordered by how many reviewers raised them,
and `CODE-REVIEW-HANDOFF.raw.md` is written alongside as the unmerged audit
trail. With consolidation off — or if it fails — the primary file holds the
reviews unmerged, with a header saying so. The filename you point an agent at
never changes.

It's blocking on purpose — run it in a spare terminal. There's no daemon, no
`status` command, and no resumability, because a second terminal solves that
for free.

## Commands

| | |
|---|---|
| `crbuddy init` | Interactive setup. Writes a config. |
| `crbuddy config` | The same command; edits an existing config. |
| `crbuddy go [instructions]` | Run the panel. |
| `crbuddy doctor` | Report which vendor CLIs are usable, which flags they accept, and why not. Read-only; contacts no models. Also aliased as `doctor`. |

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

  // "uncommitted", or { "base": "main" } for a PR-style review
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
review behavior over the crbuddy-resolved range. With it, the adapter runs a
generic read-only agent given those instructions.

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
right. Published work puts the correlation between model agreement and
correctness in a weak-to-moderate range, and models err in correlated ways —
larger models more so, and across vendors rather than only within one. Treat
convergence as a reading order, not a verdict.

**The diff is pinned; the repository is not.** Every run reviews the identical
changeset, captured as a git object before any agent starts. But agents read
other files from the live working tree, so a file changing mid-run can be seen
differently by different reviewers. Don't edit while a panel is running.

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
releases, and a flag your version doesn't have produces a usage error (exit 2
from a clap-based CLI) that looks like a crbuddy bug. At preflight crbuddy
reads each CLI's own `--help` and only passes what it advertises. Optional
flags that are missing get dropped with a warning; a missing **safety** flag
— read-only enforcement — refuses that lane instead, because a reviewer that
can edit the working tree changes the very diff under review. If your CLI
supports a flag but doesn't advertise it parseably, pass it yourself via
`vendorArgs` and crbuddy will take that as handled. `crbuddy doctor` shows
what was detected.

**Preflight checks presence, not authentication.** crbuddy verifies the vendor
binary exists and reports a version. It does not probe whether you're logged
in: there's no uniform, free way to do that across vendors, and a wrong check
rots per vendor. An expired login shows up as a fast lane failure in the first
few seconds.

**Concurrency is unmanaged by default.** Six entries means six subprocesses.
That will hit per-subscription rate limits well before it hits your machine.
Set `maxConcurrent` if it bites.

**Reviewers are forced read-only, or refused.** Each adapter passes its
vendor's read-only switch — `--permission-mode plan`, `--sandbox read-only`,
`--approval-mode plan` — and if the installed CLI doesn't advertise one, that
lane is refused rather than run permissively.

**Ctrl-C aborts and writes nothing.** A partial panel is worse than no panel,
because a consuming agent can't tell it's partial. The previous review is
restored. Press it twice to stop waiting for children to exit politely.

**Windows.** npm-global CLIs install as `.cmd` shims, and Node refuses to
spawn those without a shell (the fix for CVE-2024-27980), so vendors that
ship a native `.exe` would be detected while shimmed ones would not.
Spawning goes through `cross-spawn` on Windows to resolve shims correctly,
and process-tree termination uses `taskkill /T`. If a vendor still shows as
missing, `crbuddy doctor` prints the actual reason.

## How output is structured

YAML frontmatter carries provenance: the pinned snapshot and base SHAs, the
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

Prototype. The pure-logic surface — config, target resolution, effort
mapping, merge validation, rendering — has unit tests and has been exercised
end to end. The three vendor adapters were written against documentation
rather than running binaries, so their flags are the most likely thing to be
wrong. Each vendor's flags live in one place in `src/adapters/vendors.ts`.

See `DESIGN.md` for why things are the way they are, including the non-goals.

## License

MIT
