# crbuddy

crbuddy is a small, blocking CLI application installed globally with `npm i -g crbuddy`.  If you type that and are told you don't have Node.js and npm installed, [install the current Node.js LTS release first](https://nodejs.org/en/download); npm is included with it.

The use case is that I found myself constantly doing a lot of steps every time I wanted to do a code review process, which for me means opening multiple harnesses from different vendors, deciding on models and thinking levels, prompting them, copy/pasting their output into a new file, and then feeding it back to the controlling or working agent on the project.

crbuddy turns all that into one command, `crb go`, and outputs either a file containing all of the reviews - or just one, if that's your process - to the repo root or the results to the terminal.  `crb config` or `crb init` interactively sets up your global or local settings for the app; do that first.

More details can be found in [`GUIDE.md`](GUIDE.md), but this should be enough information for most users to get started.  This application currently supports Codex CLI, Claude Code, and Gemini CLI.

## Note on AI usage

This app does not have "AI inside of it", it uses yours and will spend tokens on your behalf just like a manual code review from an agent.

## Example run

```bash
user@computer ~/GIT_REPO $ crbuddy go
crbuddy beginning run using local configuration
Reviewing 35 file(s), 205 KB.
Starting 2 reviews at 4:19pm…
  Claude Code (sonnet) - started
  Codex CLI (gpt-5.6-terra) - started
  Codex CLI (gpt-5.6-terra) - done in 9m 30s
  Claude Code (sonnet) - done in 12m 50s
Wrote CODE-REVIEW-HANDOFF.md.
```

## License

MIT
