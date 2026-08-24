# crbuddy

crbuddy is a small, blocking CLI application installed globally with `npm i -g crbuddy`. The use case is that I found myself constantly doing a lot of steps every time I wanted to do a code review process, which for me means opening multiple harnesses from different vendors, deciding on models and thinking levels, prompting them, copy/pasting their output into a new file, and then feeding it back to the controlling or working agent on the project.

crbuddy turns all that into one command, `crbuddy go`, and writes a file containing all of the reviews - or just one, if that's your process - to the repo root. The terminal shows the run as it happens. `crbuddy config` or `crbuddy init` interactively sets up your global or local settings for the app; do that first.

More details can be found in [`GUIDE.md`](GUIDE.md), but this should be enough information for most users to get started.

## Example run

```bash
Chris@coz-desktop-2023 ~/ai/crbuddy $ crbuddy go
crbuddy beginning run using local configuration
Reviewing 35 file(s), 205 KB.
Starting 2 reviews at 4:19pm…
  Claude Code (sonnet) - started
  Codex CLI (gpt-5.6-terra) - started
  Codex CLI (gpt-5.6-terra) - done in 2m 30s
  Claude Code (sonnet) - done in 12m 50s
Consolidating 7 findings…
Wrote CODE-REVIEW-HANDOFF.md and CODE-REVIEW-HANDOFF.raw.md.
```

## License

MIT
