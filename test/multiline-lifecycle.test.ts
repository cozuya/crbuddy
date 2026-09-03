import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { multilineText } from '../src/util/multiline-prompt.js';
import { PromptAborted } from '../src/util/prompt.js';
import { createWizardUI } from '../src/util/wizard-prompt.js';

class TtyInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  readonly rawStates: boolean[] = [];

  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
    this.rawStates.push(enabled);
  }
}

class FakeLifecycleEmitter {
  readonly listeners = new Map<string, (...args: unknown[]) => void>();

  once(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, listener);
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    if (this.listeners.get(event) === listener) this.listeners.delete(event);
  }

  emit(event: string): void {
    const listener = this.listeners.get(event);
    if (!listener) return;
    this.listeners.delete(event);
    listener();
  }
}

function capture(stream: PassThrough): () => string {
  let value = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    value += chunk;
  });
  return () => value;
}

test('external SIGINT restores terminal modes and preserves the signal outcome', async () => {
  const input = new TtyInput();
  const output = new PassThrough();
  const written = capture(output);
  const lifecycle = new FakeLifecycleEmitter();
  const reraised: string[] = [];
  const result = multilineText(
    'Review instructions',
    input,
    output,
    lifecycle,
    (signal) => reraised.push(signal),
  );

  lifecycle.emit('SIGINT');

  await assert.rejects(result, PromptAborted);
  assert.equal(input.isRaw, false);
  assert.deepEqual(reraised, ['SIGINT']);
  assert.match(written(), /\u001b\[\?9001l/);
  assert.match(written(), /\u001b\[<u/);
  assert.match(written(), /\u001b\[\?2004l/);
  assert.equal(lifecycle.listeners.has('SIGINT'), false);
  assert.equal(lifecycle.listeners.has('SIGTERM'), false);
  assert.equal(lifecycle.listeners.has('SIGHUP'), false);
});

test('injected terminal capabilities drive multiline hint text', async () => {
  const input = new TtyInput();
  const output = new PassThrough();
  const written = capture(output);
  const ui = await createWizardUI({
    interactive: true,
    platform: 'linux',
    environment: { KITTY_WINDOW_ID: '1' },
    input,
    output,
    loadClack: async () => ({}) as typeof import('@clack/prompts'),
  });

  const result = ui.multiline('Review instructions');
  input.write('valid\r');

  assert.equal(await result, 'valid');
  assert.match(written(), /Shift\+Enter\/Ctrl\+J adds a line/);
  assert.match(written(), /paste is multiline-safe/);
});
