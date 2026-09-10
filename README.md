# crbuddy

Independent multi-model code review for Claude Code, OpenAI Codex, and Gemini CLI.

crbuddy runs code reviews across multiple coding-agent CLIs in parallel, keeps the reviewers blind to one another, and writes one handoff for the coding agent or human making the fixes.

If Claude Code wrote your change and you want Codex and Gemini to review it independently - or Codex wrote it and you want a second opinion from Claude Code - crbuddy turns that cross-model review workflow into one command.

## Quick start

```bash
npm i -g crbuddy
crb init
crb go
```

`crb init` interactively creates global or per-repository configuration. `crb go` runs the configured review panel and blocks until it finishes.

## What it does

- Runs independent code-review lanes in parallel using the coding-agent CLIs you already have installed and authenticated.
- Supports Claude Code, Codex CLI, and Gemini CLI.
- Uses a vendor's native code-review operation when crbuddy has a supported headless native path and you have not supplied custom instructions.
- Keeps reviewers independent: one reviewer does not see another reviewer's output.
- Optionally groups findings that appear to describe the same defect without letting the consolidator reject, rewrite, or delete findings.
- Writes `CODE-REVIEW-HANDOFF.md` for the agent or human that will act on the reviews. The raw unmerged reviews are preserved when consolidation is enabled.

This is useful when you want independent code review, cross-model code review, or a second opinion from another model family without manually opening several coding-agent harnesses, prompting each one, collecting the outputs, and assembling a handoff.

crbuddy is a local CLI, not a hosted AI service. It holds no model credentials and uses your existing Claude Code, Codex, and Gemini CLI authentication and entitlements.

For configuration, targeting, consolidation, vendor behavior, and other details, see [`GUIDE.md`](GUIDE.md).

## Example run

```text
user@computer ~/GIT_REPO $ crb go
crbuddy beginning run using local configuration
Reviewing 35 file(s), 205 KB.
Starting 2 reviews at 4:19pm…
  Claude Code - started
  Codex CLI - started
  Codex CLI - done in 9m 30s
  Claude Code - done in 12m 50s
Wrote CODE-REVIEW-HANDOFF.md.
```

## License

MIT
