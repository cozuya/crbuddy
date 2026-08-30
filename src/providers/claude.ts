import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { CREDENTIALS_FILENAME, HOME_CONFIG_DIR } from '../config/schema.js';

export const CLAUDE_PROVIDER_IDS = ['anthropic', 'zai', 'deepseek', 'kimi'] as const;
export type ClaudeProviderId = (typeof CLAUDE_PROVIDER_IDS)[number];
export type RoutedClaudeProviderId = Exclude<ClaudeProviderId, 'anthropic'>;

export interface ProviderModel {
  id: string;
  label: string;
  hint?: string;
}

export interface ClaudeProviderDefinition {
  id: ClaudeProviderId;
  label: string;
  models: ProviderModel[];
  defaultModel: string;
  credentialRequired: boolean;
}

export const CLAUDE_PROVIDERS: ClaudeProviderDefinition[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    models: [
      { id: 'fable', label: 'Fable', hint: 'frontier tier' },
      { id: 'opus', label: 'Opus', hint: 'deep reasoning, slowest' },
      { id: 'sonnet', label: 'Sonnet', hint: 'balanced' },
      { id: 'haiku', label: 'Haiku', hint: 'fast and cheap' },
    ],
    defaultModel: 'opus',
    credentialRequired: false,
  },
  {
    id: 'zai',
    label: 'Z.ai',
    models: [
      { id: 'glm-5.3[1m]', label: 'GLM-5.3 [1m]', hint: 'flagship, 1M context' },
      { id: 'glm-5.3-flash[1m]', label: 'GLM-5.3 Flash [1m]', hint: 'faster/cheaper' },
    ],
    defaultModel: 'glm-5.3[1m]',
    credentialRequired: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-pro[1m]', label: 'DeepSeek V4 Pro [1m]', hint: 'flagship' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', hint: 'faster/cheaper' },
    ],
    defaultModel: 'deepseek-v4-pro[1m]',
    credentialRequired: true,
  },
  {
    id: 'kimi',
    label: 'Kimi',
    models: [
      { id: 'k3[1m]', label: 'K3 [1m]', hint: '1M context' },
      { id: 'k3-256k', label: 'K3 256K', hint: 'smaller context' },
    ],
    defaultModel: 'k3[1m]',
    credentialRequired: true,
  },
];

const BY_ID = new Map(CLAUDE_PROVIDERS.map((provider) => [provider.id, provider]));

export function getClaudeProvider(id: string | undefined): ClaudeProviderDefinition {
  const normalized = id ?? 'anthropic';
  const provider = BY_ID.get(normalized as ClaudeProviderId);

  if (!provider) {
    throw new Error(
      `Unknown Claude Code provider ${JSON.stringify(normalized)}. Known providers: ` +
        CLAUDE_PROVIDER_IDS.join(', '),
    );
  }

  return provider;
}

export function isClaudeProvider(value: string): value is ClaudeProviderId {
  return BY_ID.has(value as ClaudeProviderId);
}

export interface ProviderCredential {
  apiKey: string;
}

export type ClaudeCredentials = Partial<Record<RoutedClaudeProviderId, ProviderCredential>>;

export function credentialsPath(): string {
  return path.join(homedir(), HOME_CONFIG_DIR, CREDENTIALS_FILENAME);
}

function parseCredentials(text: string, file: string): ClaudeCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Claude provider credentials at ${file} are not valid JSON: ${String(error)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Claude provider credentials at ${file} must be a JSON object.`);
  }

  const result: ClaudeCredentials = {};
  const raw = parsed as Record<string, unknown>;

  for (const id of ['zai', 'deepseek', 'kimi'] as RoutedClaudeProviderId[]) {
    const value = raw[id];
    if (value === undefined) continue;

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${file}: ${id} credential must be an object.`);
    }

    const apiKey = (value as Record<string, unknown>).apiKey;
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new Error(`${file}: ${id}.apiKey must be a non-empty string.`);
    }

    result[id] = { apiKey };
  }

  return result;
}

export async function loadClaudeCredentials(): Promise<ClaudeCredentials> {
  const file = credentialsPath();
  try {
    return parseCredentials(await readFile(file, 'utf8'), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export function loadClaudeCredentialsSync(): ClaudeCredentials {
  const file = credentialsPath();
  try {
    return parseCredentials(readFileSync(file, 'utf8'), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveClaudeCredentials(credentials: ClaudeCredentials): Promise<void> {
  const file = credentialsPath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  await chmod(file, 0o600).catch(() => {});
}

const ACTIVE_BY_MODEL = new Map<string, ClaudeProviderId>();

export function resetClaudeProviderRegistry(): void {
  ACTIVE_BY_MODEL.clear();
}

export function registerClaudeModelProvider(model: string, providerId: string | undefined): void {
  const provider = getClaudeProvider(providerId);
  const existing = ACTIVE_BY_MODEL.get(model);

  if (existing && existing !== provider.id) {
    throw new Error(
      `Claude model ${JSON.stringify(model)} is configured with two providers ` +
        `(${existing} and ${provider.id}). Use distinct model IDs/providers in one config.`,
    );
  }

  ACTIVE_BY_MODEL.set(model, provider.id);
}

export function providerForClaudeModel(model: string): ClaudeProviderDefinition {
  return getClaudeProvider(ACTIVE_BY_MODEL.get(model));
}

export function providerDisplayName(providerId: string | undefined): string {
  return getClaudeProvider(providerId).label;
}

export function claudeProviderEnv(
  model: string,
  credentials?: ClaudeCredentials,
): Record<string, string> {
  const provider = providerForClaudeModel(model);
  if (provider.id === 'anthropic') return {};

  const allCredentials = credentials ?? loadClaudeCredentialsSync();
  const credential = allCredentials[provider.id];
  if (!credential) {
    throw new Error(
      `No API key is stored for ${provider.label}. Run \`crbuddy init\` and configure ` +
        `a Claude Code reviewer using ${provider.label}.`,
    );
  }

  const key = credential.apiKey;

  if (provider.id === 'zai') {
    const flash = model.includes('flash') ? model : 'glm-5.3-flash[1m]';
    return {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_FABLE_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: flash,
      CLAUDE_CODE_SUBAGENT_MODEL: flash,
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: model.includes('[1m]') ? '1000000' : '200000',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: model.includes('[1m]') ? '1000000' : '200000',
    };
  }

  if (provider.id === 'deepseek') {
    const flash = 'deepseek-v4-flash';
    const primary = model === flash ? flash : model;
    return {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_FABLE_MODEL: primary,
      ANTHROPIC_DEFAULT_OPUS_MODEL: primary,
      ANTHROPIC_DEFAULT_SONNET_MODEL: primary,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: flash,
      CLAUDE_CODE_SUBAGENT_MODEL: flash,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
    };
  }

  const context = model === 'k3-256k' ? '262144' : '1048576';
  return {
    ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: context,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: context,
  };
}
