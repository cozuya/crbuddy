import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLAUDE_BACKGROUND_WAIT_CEILING_ENV,
  configureClaudeBackgroundWait,
} from '../src/run/claude-background-wait.js';

test('crbuddy disables Claude Code print-mode background wait ceiling', () => {
  const env: NodeJS.ProcessEnv = {
    [CLAUDE_BACKGROUND_WAIT_CEILING_ENV]: '600000',
  };

  configureClaudeBackgroundWait(env);

  assert.equal(env[CLAUDE_BACKGROUND_WAIT_CEILING_ENV], '0');
});
