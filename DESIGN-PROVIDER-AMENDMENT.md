# Claude Code provider routing - design amendment

This branch intentionally amends the original `DESIGN.md` statement that crbuddy stores no model credentials.

Claude Code remains one adapter/harness. A Claude panel or consolidation entry may optionally name a `provider`; absence means Anthropic. The supported provider set in this version is Anthropic, Z.ai, DeepSeek, and Kimi. Providers are not separate adapters and there is no generic custom-provider escape hatch in this version.

For a non-Anthropic provider, crbuddy launches the existing `claude -p` / `/code-review` path with an isolated child environment containing that provider's Anthropic-compatible endpoint, model mappings, and credential. This preserves Claude Code's review orchestration and read-only controls while changing the model backend.

Provider API keys are global user credentials, never repository configuration. They are stored in plaintext at `~/.crbuddy/credentials.json`; interactive setup masks key entry, warns that the file is plaintext and readable by any process/account with filesystem access, and asks before saving. The file is created with restrictive permissions where the platform supports them. Credential values must never appear in project config, reports, provenance, diagnostics, or `doctor` output.

The project config schema adds an optional `provider` field to Claude panel entries and to Claude consolidation config. Existing configs without the field remain valid and mean Anthropic.
