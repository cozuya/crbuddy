import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ADAPTERS, claudeHooksDisabledReason } from '../adapters/vendors.js';
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
    { candidates: ['--settings'], required: true },
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
      const help = result.present ? await readHelp(adapter, scratch) : null;
      const checks = FLAG_CHECKS[adapter.name] ?? [];
      const flagResults =
        help === null
          ? []
          : checks.map((entry) => ({
              entry,
              found: entry.candidates.find((flag) => supported(help, flag)),
            }));
      const missingRequired = flagResults.filter(
        ({ entry, found }) => entry.required && !found,
      );
      // Preserve the existing fallback when help itself cannot be read: doctor
      // cannot prove a required flag is absent, so it reports the uncertainty
      // and lets go perform the authoritative build-time check.
      const requiredFlagsOk = help === null || missingRequired.length === 0;
      const hookDisabledBy =
        adapter.name === 'claude' ? claudeHooksDisabledReason(repoRoot) : null;
      const adapterUsable =
        result.present && versionOk && requiredFlagsOk && hookDisabledBy === null;
      const mark = !result.present
        ? 'MISS'
        : !versionOk
          ? 'OLD '
          : requiredFlagsOk && hookDisabledBy === null
            ? 'OK  '
            : 'BAD ';

      if (adapterUsable) usable += 1;

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

        if (help === null) {
          console.log(`       flags:    could not read \`${adapter.command} ` +
            `${adapter.helpArgs().join(' ')}\`; all flags assumed supported`);
        } else {
          const report = flagResults.map(({ entry, found }) =>
            found
              ? `${found}`
              : `${entry.candidates[0]} MISSING${entry.required ? ' (required)' : ''}`,
          );

          if (report.length > 0) {
            console.log(`       flags:    ${report.join('  ')}`);
          }

          if (missingRequired.length > 0) {
            console.log(
              `       problem:  required flag(s) missing; crbuddy go will refuse this adapter`,
            );
          }
        }

        if (hookDisabledBy) {
          console.log(
            `       problem:  ${hookDisabledBy}; crbuddy go will refuse Claude`,
          );
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
