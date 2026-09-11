import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { HOME_CONFIG_DIR } from './schema.js';

export interface NtfyNotification {
  provider: 'ntfy';
  endpoint: string;
}

/** User preferences are independent of project/global review config selection. */
export interface GlobalSettings {
  notifications?: NtfyNotification;
}

export function homeSettingsPath(): string {
  return path.join(homedir(), HOME_CONFIG_DIR, 'settings.json');
}

export function isNtfyEndpoint(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.protocol === 'https:' &&
      url.hostname === 'ntfy.sh' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      // After parsing the URL, restrict the path to one hosted ntfy topic.
      // ntfy permits 1-64 letters, digits, underscores or dashes.
      /^\/[A-Za-z0-9_-]{1,64}$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export async function loadGlobalSettings(
  warn: (message: string) => void = console.error,
  file = homeSettingsPath(),
): Promise<GlobalSettings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid settings');
    }

    const notifications = (parsed as GlobalSettings).notifications;
    if (notifications === undefined) return {};

    if (
      !notifications ||
      notifications.provider !== 'ntfy' ||
      typeof notifications.endpoint !== 'string' ||
      !isNtfyEndpoint(notifications.endpoint)
    ) {
      throw new Error('Invalid notification settings');
    }

    return {
      notifications: { provider: 'ntfy', endpoint: notifications.endpoint },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // JSON and filesystem errors can contain user data. Never echo them.
      warn(
        'Warning: could not read global notification settings; notifications ' +
          'are disabled. Repair ~/.crbuddy/settings.json manually to preserve ' +
          'its values, or run `crb config` to replace them.',
      );
    }

    return {};
  }
}

export async function saveGlobalSettings(
  settings: GlobalSettings,
  file = homeSettingsPath(),
): Promise<void> {
  const temporary = path.join(path.dirname(file), `.settings-${randomUUID()}.tmp`);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    // Replacing with a private file also fixes permissive existing modes and
    // leaves the previous preferences intact if writing the new ones fails.
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, file);
  } catch {
    throw new Error(
      'Could not save global notification settings to ~/.crbuddy/settings.json.',
    );
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
