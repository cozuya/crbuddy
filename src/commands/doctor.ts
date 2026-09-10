import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { withModelDiscovery } from '../adapters/model-discovery.js';
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
 * Read-only: it runs vendor version/help surfaces and, where supported, asks
 * the installed CLI for its model catalog. It sends no model prompt, writes
 * no repository files, and falls back to crbuddy's built-in catalog if live
 * discovery is unavailable.
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
    const discoveryCwd = repoRoot ?? process.cwd();
    console.log(`git repo      ${repoRoot ?? '(not inside a working tree)'}`);
    console.log('');
    console.log('Vendor CLIs');
    console.log('');

    let usable = 0;

    for (const registered of ADAPTERS) {
      const adapter = withModelDiscovery(registered);
      const result = await probe(adapter.command, adapter.versionArgs());
      const version = result.present ? adapter.parseVersion(result.output ?? '') : null;
      const versionOk = version !== null && isVersionAtLeast(version, adapter.minVersion);
      const mark = !result.present ? 'MISS' : versionOk ? 'OK  ' : 'OLD ';

      let models = adapter.models;
      let modelSource: 'reported by CLI' | 'fallback list' = 'fallback list';
      let modelError: string | null = null;

      if (result.present && adapter.discoverModels) {
        try {
          const discovered = await adapter.discoverModels({ cwd: discoveryCwd });
          if (discovered && discovered.length > 0) {
            models = discovered;
            modelSource = 'reported by CLI';
          } else {
            modelError = 'the CLI returned no usable models';
          }
        } catch (error) {
          modelError = error instanceof Error ? error.message : String(error);
        }
      }

      console.log(`  ${mark} ${adapter.label} - \`${adapter.command}\``);

      if (result.output) {
        console.log(`       reported: ${result.output}`);
      }

      if (result.present) {
        if (version) {
          console.log(
            `       version:  ${version} (minimum ${adapter.minVersion}; fallback lists written for ${adapter.listsStampedFor})`,
          );

          if (!versionOk) {
            console.log(
              `       problem:  too old for this adapter; update to ${adapter.minVersion} or newer`,
            );
          } else {
            usable += 1;
          }

          if (
            versionOk &&
            modelSource === 'fallback list' &&
            isNewerThanStamp(version, adapter.listsStampedFor)
          ) {
            console.log(
              `       note:     newer than crbuddy's fallback lists; init may not offer` +
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
          `       models:   ${models.map((model) => model.id).join(', ')} (${modelSource})`,
        );

        if (modelError) {
          console.log(`       models:   discovery failed: ${modelError}`);
        }

        const catalogEfforts = [
          ...new Set(models.flatMap((model) => model.efforts ?? [])),
        ];

        if (modelSource === 'reported by CLI' && catalogEfforts.length > 0) {
          console.log(`       effort:   model-specific: ${catalogEfforts.join(', ')}`);
        } else if (adapter.efforts.length > 0) {
          console.log(`       effort:   ${adapter.efforts.join(', ')}`);
        } else {
          console.log(`       effort:   (this CLI has no thinking-effort setting)`);
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
        `Model catalog discovery is best-effort; failures use fallback lists.`,
    );
    console.log('');

    return usable > 0 ? 0 : 1;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
