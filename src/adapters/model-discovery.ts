import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runProcess } from '../run/spawn.js';
import { Adapter, ModelDiscoveryContext, VendorModel } from './types.js';

const DISCOVERY_TIMEOUT_MS = 20_000;

interface JsonObject {
  [key: string]: unknown;
}

/**
 * Keep the base vendor registry usable without discovery. Callers that want
 * live catalogs wrap those adapters here; unsupported vendors are returned
 * unchanged and therefore use their built-in model list.
 */
export function withModelDiscovery(adapter: Adapter): Adapter {
  if (adapter.discoverModels) return adapter;

  if (adapter.name === 'codex') {
    return {
      ...adapter,
      discoverModels: (context) => discoverCodexModels(adapter.command, context),
    };
  }

  if (adapter.name === 'gemini') {
    return {
      ...adapter,
      discoverModels: (context) => discoverGeminiModels(adapter.command, context),
    };
  }

  return adapter;
}

async function runDiscovery(
  command: string,
  args: string[],
  context: ModelDiscoveryContext,
  stdin?: string,
): Promise<{ stdout: string; stderr: string }> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'crbuddy-models-'));

  try {
    const result = await runProcess({
      command,
      args,
      cwd: context.cwd,
      stdin,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      scratchDir: scratch,
      id: `models-${command}-${process.pid}`,
      signal: context.signal,
    });

    if (result.spawnError) {
      throw new Error(result.spawnError);
    }

    if (result.timedOut) {
      throw new Error(`\`${command} ${args.join(' ')}\` did not return within 20s.`);
    }

    if (result.code !== 0) {
      const detail = `${result.stderr}\n${result.stdout}`.trim().slice(0, 240);
      throw new Error(
        `\`${command} ${args.join(' ')}\` exited ${result.code}` +
          (detail ? `: ${detail}` : '.'),
      );
    }

    return { stdout: result.stdout, stderr: result.stderr };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Codex currently exposes its effective catalog as JSON through
 * `codex debug models`. The shape has used both ModelInfo-style (`slug`,
 * `supported_reasoning_levels`) and ModelPreset-style (`model`,
 * `supported_reasoning_efforts`) names, so parse both rather than binding
 * crbuddy to one internal representation.
 */
export async function discoverCodexModels(
  command: string,
  context: ModelDiscoveryContext,
): Promise<VendorModel[] | null> {
  const { stdout } = await runDiscovery(command, ['debug', 'models'], context);
  const models = parseCodexModelCatalog(stdout);
  return models.length > 0 ? models : null;
}

export function parseCodexModelCatalog(text: string): VendorModel[] {
  const parsed = JSON.parse(text) as unknown;
  const records = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray(parsed.models)
      ? parsed.models
      : [];

  const models: VendorModel[] = [];
  const seen = new Set<string>();

  for (const candidate of records) {
    if (!isObject(candidate)) continue;

    const visibility = stringValue(candidate.visibility)?.toLowerCase();
    if (visibility === 'hide' || visibility === 'none') continue;
    if (candidate.show_in_picker === false || candidate.showInPicker === false) continue;

    const id =
      stringValue(candidate.slug) ??
      stringValue(candidate.model) ??
      stringValue(candidate.id);

    if (!id || seen.has(id)) continue;
    seen.add(id);

    const label =
      stringValue(candidate.display_name) ??
      stringValue(candidate.displayName) ??
      id;
    const description = stringValue(candidate.description);
    const efforts = reasoningEfforts(
      candidate.supported_reasoning_levels ?? candidate.supported_reasoning_efforts,
    );

    models.push({
      id,
      label,
      ...(description ? { hint: description } : {}),
      ...(efforts.length > 0 ? { efforts } : {}),
    });
  }

  return models;
}

/**
 * Gemini CLI exposes the same model list used by its `/model` UI through ACP
 * session setup. No model prompt is sent: initialize a short-lived ACP
 * session, read `result.models.availableModels`, then let stdin EOF close it.
 */
export async function discoverGeminiModels(
  command: string,
  context: ModelDiscoveryContext,
): Promise<VendorModel[] | null> {
  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: context.cwd, mcpServers: [] },
    },
  ];

  const stdin = `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`;
  const { stdout } = await runDiscovery(command, ['--acp'], context, stdin);
  const models = parseGeminiAcpModels(stdout);
  return models.length > 0 ? models : null;
}

export function parseGeminiAcpModels(text: string): VendorModel[] {
  const messages = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });

  const response = messages.find(
    (message) => isObject(message) && message.id === 2,
  );

  if (!isObject(response)) return [];

  if (isObject(response.error)) {
    const message = stringValue(response.error.message) ?? 'Gemini ACP session/new failed.';
    throw new Error(message);
  }

  const result = isObject(response.result) ? response.result : null;
  const catalog = result && isObject(result.models) ? result.models : null;
  const available = catalog && Array.isArray(catalog.availableModels)
    ? catalog.availableModels
    : [];
  const models: VendorModel[] = [];
  const seen = new Set<string>();

  for (const candidate of available) {
    if (!isObject(candidate)) continue;

    const id = stringValue(candidate.modelId) ?? stringValue(candidate.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const label = stringValue(candidate.name) ?? id;
    const description = stringValue(candidate.description);

    models.push({
      id,
      label,
      ...(description ? { hint: description } : {}),
    });
  }

  return models;
}

function reasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const efforts: string[] = [];
  const seen = new Set<string>();

  for (const candidate of value) {
    const effort =
      typeof candidate === 'string'
        ? candidate
        : isObject(candidate)
          ? stringValue(candidate.effort)
          : null;

    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    efforts.push(effort);
  }

  return efforts;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
