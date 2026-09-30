import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError, loadConfig } from './config/load.js';
import { GitError, findRepoRoot } from './git/target.js';
import { LockError } from './util/lock.js';
import { PreflightError, runGo } from './commands/go.js';
import { parseGoArguments } from './commands/go-options.js';
import { runInit } from './commands/init.js';
import { runDoctor } from './commands/doctor.js';
import { runView } from './commands/view.js';
import { configureClaudeBackgroundWait } from './run/claude-background-wait.js';
import { UpdateCheck, startUpdateCheck } from './run/update-check.js';

const HELP = `crbuddy - fan one code review across several agent CLIs, then hand off every review.

First run: use \`crb init\` to set up your code review panel, then \`crb go\`
to run it.

Usage:
  crbuddy init                 Interactive setup. Writes a config.
  crbuddy config               Same as init; edits an existing config.
  crbuddy view                 Show the effective config. Read-only.
  crbuddy go [instructions]    Run the panel. Blocking.
  crbuddy doctor               Report which vendor CLIs are usable, and why not.

Options for \`go\`:
  --force           Run even if the diff exceeds maxDiffBytes.
  --whole-checkout  Review the whole checkout when the target diff is empty;
                    required when running without a terminal.
  --strict          Exit 2 when any run fails (default: exit 0).

Other:
  --help, -h   This text.
  --version    Print version.

The optional positional argument to \`go\` overrides the review instructions
on every panel entry, for a one-off run without editing config.

Exit codes:
  0  panel completed
  1  no review completed; the report may still hold output kept from a
     review that did not finish, marked possibly incomplete
  2  partial success, only with --strict
`;

let manifestVersion: Promise<string | null> | undefined;

/** This package's version, read once; null when it cannot be read. */
function installedVersion(): Promise<string | null> {
  manifestVersion ??= (async () => {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const manifest = await readFile(path.join(here, '..', 'package.json'), 'utf8');
      const { version } = JSON.parse(manifest) as { version?: unknown };
      return typeof version === 'string' ? version : null;
    } catch {
      return null;
    }
  })();

  return manifestVersion;
}

async function version(): Promise<string> {
  return (await installedVersion()) ?? '0.0.0';
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP);
    return 0;
  }

  if (args[0] === '--version' || args[0] === '-v') {
    console.log(await version());
    return 0;
  }

  const command = args[0];
  const rest = args.slice(1);

  const repoRoot = await findRepoRoot(process.cwd()).catch(() => null);

  // `doctor` is the conventional name for a read-only diagnostic across
  // toolchains (brew, flutter, npm); `check` stays as an alias.
  if (command === 'doctor' || command === 'check') {
    return runDoctor();
  }

  if (command === 'view') {
    if (rest.length > 0) {
      console.error('crbuddy view takes no arguments.');
      return 1;
    }

    return runView({ repoRoot });
  }

  if (command === 'init' || command === 'config') {
    const scope = rest.includes('--global')
      ? ('global' as const)
      : rest.includes('--project')
        ? ('project' as const)
        : undefined;

    return runInit({ repoRoot, ...(scope ? { scope } : {}) });
  }

  if (command !== 'go') {
    console.error(`Unknown command "${command}".\n`);
    console.error(HELP);
    return 1;
  }

  if (!repoRoot) {
    console.error('crbuddy go must be run inside a git working tree.');
    return 1;
  }

  const go = parseGoArguments(rest);

  if (go.unknownFlags.length > 0) {
    console.error(`Unknown option(s): ${go.unknownFlags.join(', ')}`);
    return 1;
  }

  if (go.positional.length > 1) {
    console.error(
      'crbuddy go takes at most one positional argument (the review instructions).\n' +
        'Quote it if it contains spaces.',
    );
    return 1;
  }

  // Claude Code print mode otherwise gives background agents only ten minutes
  // to finish after the top-level turn. crbuddy already has its own run timeout,
  // so make that timeout the single hard ceiling for Claude review work.
  configureClaudeBackgroundWait();

  const loaded = await loadConfig(repoRoot);

  return runGo({
    repoRoot,
    loaded,
    version: await version(),
    ...(go.positional[0] ? { instructionsOverride: go.positional[0] } : {}),
    force: go.force,
    wholeCheckout: go.wholeCheckout,
    strict: go.strict,
  });
}

function reportError(error: unknown): void {
  if (
    error instanceof ConfigError ||
    error instanceof GitError ||
    error instanceof LockError ||
    error instanceof PreflightError
  ) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.stack : String(error));
  }
}

/** Commands that end with an update notice. Never --version or --help. */
const UPDATE_NOTICE_COMMANDS = new Set(['go', 'init', 'config', 'view', 'doctor', 'check']);

/** Best effort: without a readable version of our own there is nothing to compare. */
async function beginUpdateCheck(command: string | undefined): Promise<UpdateCheck | null> {
  if (!UPDATE_NOTICE_COMMANDS.has(command ?? '')) return null;

  try {
    const installed = await installedVersion();
    return installed === null ? null : startUpdateCheck({ installed });
  } catch {
    return null;
  }
}

async function run(argv: string[]): Promise<number> {
  // Started before the command so the registry request overlaps its work.
  const update = await beginUpdateCheck(argv[2]);
  let code: number;

  try {
    code = await main(argv);
  } catch (error) {
    reportError(error);
    code = 1;
  }

  const notice = await update?.notice();
  if (notice) console.error(`\n${notice}`);

  return code;
}

run(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    reportError(error);
    process.exitCode = 1;
  });
