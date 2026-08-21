import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ADAPTERS } from '../adapters/vendors.js';
import { isNewerThanStamp } from '../adapters/effort.js';
import { probe, runProcess } from '../run/spawn.js';
import { findRepoRoot } from '../git/target.js';

interface FlagCheck {
  candidates: string[];
  required?: boolean;
}

/** Flags crbuddy relies on, per vendor. Required ones refuse the lane. */
const FLAG_CHECKS: Record<string, FlagCheck[]> = {
  claude: [
    { candidates: ['--permission-mode'], required: true },
    { candidates: ['--no-session-persistence', '--no-save-session'] },
    { candidates: ['--effort', '--reasoning-effort'] },
  ],
  codex: [
    { candidates: ['--sandbox', '-s'], required: true },
    { candidates: ['--ephemeral'] },
    { candidates: ['--skip-git-repo-check'] },
    { candidates: ['--color'] },
    { candidates: ['-c'] },
  ],
  gemini: [
    { candidates: ['--approval-mode'], required: true },
    { candidates: ['--prompt', '-p'] },
  ],
};

async function readHelp(
  adapter: { command: string; helpArgs(): string[]; name: string },
  scratch: string,
): Promise<string | null> {
  const result = await runProcess({
    command: adapter.command,
    args: adapter.helpArgs(),
    cwd: scratch,
    timeoutMs: 20_000,
    scratchDir: scratch,
    id: `check-help-${adapter.name}`,
  });

  const help = `${result.stdout}\n${result.stderr}`;

  return help.trim() === '' ? null : help;
}

function supported(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,\\[])${escaped}([\\s,=\\]]|$)`, 'm').test(help);
}

/**
 * `crbuddy check` — everything crbuddy knows about this machine.
 *
 * Read-only: it runs `--version` and `--help` on each vendor CLI and reports
 * what it found. It contacts no models, writes nothing, and changes nothing.
 *
 * This exists because "vendor not detected" is the single most likely thing
 * to go wrong, and a checkmark with no reason attached makes it impossible
 * to tell a PATH problem from a shim problem from a broken install.
 */
export async function runCheck(): Promise<number> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'crbuddy-check-'));

  try {
    console.log('');
    console.log(`platform      ${process.platform} (${process.arch})`);
    console.log(`node          ${process.version}`);

    if (process.platform === 'win32') {
      console.log(`PATHEXT       ${process.env.PATHEXT ?? '(unset)'}`);
    }

    const repoRoot = await findRepoRoot(process.cwd()).catch(() => null);
    console.log(`git repo      ${repoRoot ?? '(not inside a working tree)'}`);
    console.log('');
    console.log('Vendor CLIs');
    console.log('');

    let usable = 0;

    for (const adapter of ADAPTERS) {
      const result = await probe(adapter.command, adapter.versionArgs());

      const mark = result.present ? 'OK  ' : 'MISS';

      console.log(`  ${mark} ${adapter.label} — \`${adapter.command}\``);

      if (result.output) {
        console.log(`       reported: ${result.output}`);
      }

      if (result.present) {
        usable += 1;

        const version = adapter.parseVersion(result.output ?? '');

        if (version) {
          console.log(
            `       version:  ${version} (lists written for ${adapter.listsStampedFor})`,
          );

          if (isNewerThanStamp(version, adapter.listsStampedFor)) {
            console.log(
              `       note:     newer than crbuddy's lists; init may not offer` +
                ` every model or effort value this CLI supports`,
            );
          }
        } else {
          console.log(`       version:  could not parse`);
        }

        console.log(
          `       models:   ${adapter.models.map((m) => m.id).join(', ')}`,
        );

        if (adapter.efforts.length > 0) {
          console.log(`       effort:   ${adapter.efforts.join(', ')}`);
        } else {
          console.log(`       effort:   (this CLI has no effort control)`);
        }

        // Which flags crbuddy will actually pass, read from the CLI's help.
        // This is where a version mismatch becomes visible before it costs
        // you a five-minute run.
        const help = await readHelp(adapter, scratch);

        if (help === null) {
          console.log(`       flags:    could not read \`${adapter.command} ` +
            `${adapter.helpArgs().join(' ')}\`; all flags assumed supported`);
        } else {
          const checks = FLAG_CHECKS[adapter.name] ?? [];

          const report = checks.map((entry) => {
            const found = entry.candidates.find((flag) => supported(help, flag));

            return found
              ? `${found}${entry.required ? '' : ''}`
              : `${entry.candidates[0]} MISSING${entry.required ? ' (required)' : ''}`;
          });

          if (report.length > 0) {
            console.log(`       flags:    ${report.join('  ')}`);
          }
        }
      }

      if (result.error) {
        console.log(`       problem:  ${result.error}`);
      }

      console.log('');
    }

    console.log(
      `${usable} of ${ADAPTERS.length} vendor CLI(s) usable. ` +
        `crbuddy does not check whether they are logged in.`,
    );
    console.log('');

    return usable > 0 ? 0 : 1;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
