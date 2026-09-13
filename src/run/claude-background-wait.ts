export const CLAUDE_BACKGROUND_WAIT_CEILING_ENV =
  'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS';

/**
 * Claude Code print mode otherwise terminates still-running background agents
 * after its own 10-minute wait ceiling. crbuddy already owns the actual
 * per-run wall-clock timeout, so disable Claude's inner ceiling and let the
 * crbuddy timeout remain authoritative.
 */
export function configureClaudeBackgroundWait(
  env: NodeJS.ProcessEnv = process.env,
): void {
  env[CLAUDE_BACKGROUND_WAIT_CEILING_ENV] = '0';
}
