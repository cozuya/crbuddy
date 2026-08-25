import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ADAPTERS } from '../adapters/vendors.js';
import { isNewerThanStamp } from '../adapters/effort.js';
import { isVersionAtLeast } from '../adapters/version.js';
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
    id: `doctor-help-${adapter.name}`,
  });

  const help = `${result.stdout}\n${result.stderr}`;

  return help.trim() === '' ? null : help;
}

function supported(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,\\[])${escaped}([\\s,=\\]]|$)`, 'm').test(help);
}

/**
 * `crbuddy doctor` — everything crbuddy knows about this machine.
 *
 * Read-only: it runs `--version` and `--help` on each vendor CLI and reports
 * what it found. It contacts no models, writes nothing, and changes nothing.
 */
export async function runDoctor(): Promise<number> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'crbuddy-doctor-'));

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
      const version = result.present ? adapter.parseVersion(result.output ?? '') : null;
      const versionOk = version !== null && isVersionAtLeast(version, adapter.minVersion);
      const mark = !result.present ? 'MISS' : versionOk ? 'OK  ' : 'OLD ';

      console.log(`  ${mark} ${adapter.label} - \`${adapter.command}\``);

      if (result.output) {
        console.log(`       reported: ${result.output}`);
      }

      if (result.present) {
        if (version) {
          console.log(
            `       version:  ${version} (minimum ${adapter.minVersion}; lists written for ${adapter.listsStampedFor})`,
          );

          if (!versionOk) {
            console.log(
              `       problem:  too old for this adapter; update to ${adapter.minVersion} or newer`,
            );
          } else {
            usable += 1;
          }

          if (versionOk && isNewerThanStamp(version, adapter.listsStampedFor)) {
            console.log(
              `       note:     newer than crbuddy's lists; init may not offer` +
                ` every model or effort value this CLI supports`,
            );
          }
        } else {
          console.log(`       version:  could not parse (minimum ${adapter.minVersion})`);
          console.log(
            `       problem:  crbuddy will refuse to guess at version-sensitive review behavior`,
          );
        }

        console.log(
          `       models:   ${adapter.models.map((m) => m.id).join(', ')}`,
        );

        if (adapter.efforts.length > 0) {
          console.log(`       effort:   ${adapter.efforts.join(', ')}`);
        } else {
          console.log(`       effort:   (this CLI has no effort control)`);
        }

        const help = await readHelp(adapter, scratch);

        if (help === null) {
          console.log(`       flags:    could not read \`${adapter.command} ` +
            `${adapter.helpArgs().join(' ')}\`; all flags assumed supported`);
        } else {
          const checks = FLAG_CHECKS[adapter.name] ?? [];

          const report = checks.map((entry) => {
            const found = entry.candidates.find((flag) => supported(help, flag));

            return found
              ? `${found}`
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
