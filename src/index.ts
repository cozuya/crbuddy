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

const HELP = `crbuddy - fan one code review across several agent CLIs, then consolidate.

Usage:
  crbuddy init                 Interactive setup. Writes a config.
  crbuddy config               Same as init; edits an existing config.
  crbuddy go [instructions]    Run the panel. Blocking.
  crbuddy doctor               Report which vendor CLIs are usable, and why not.

Options for \`go\`:
  --force           Run even if the diff exceeds maxDiffBytes.
  --whole-checkout  Review the whole checkout when the target diff is empty;
                    required when running without a terminal.
  --strict          Exit 2 when any run or the merge fails (default: exit 0).

Other:
  --help, -h   This text.
  --version    Print version.

The optional positional argument to \`go\` overrides the review instructions
on every panel entry, for a one-off run without editing config.

Exit codes:
  0  panel completed (and merge, if enabled)
  1  no usable review produced
  2  partial success, only with --strict
`;

async function version(): Promise<string> {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const manifest = await readFile(path.join(here, '..', 'package.json'), 'utf8');
    return (JSON.parse(manifest) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
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

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
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

    process.exitCode = 1;
  });
