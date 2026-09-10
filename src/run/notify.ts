import { Worker } from 'node:worker_threads';

import { loadGlobalSettings } from '../config/settings.js';

export type ReviewOutcome = 'complete' | 'partial' | 'failed';

/** One best-effort delivery, called only after launched reviewer work ends. */
export async function notifyFinished(
  repoName: string,
  outcome: ReviewOutcome,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (signal.aborted) return;
    const { notifications } = await loadGlobalSettings();
    if (!notifications || signal.aborted) return;

    const status = outcome === 'partial' ? 'complete (partial)' : outcome;
    const delivered = await postNotification(
      notifications.endpoint,
      `${repoName}: review ${status}`,
      signal,
    );
    if (!delivered) throw new Error('Delivery failed');
  } catch {
    // fetch errors, redirect locations and response bodies may reveal the
    // secret topic. Keep this independent of both the error and run result.
    if (!signal.aborted) {
      console.error('Warning: ntfy notification delivery could not be confirmed.');
    }
  }
}

/** Termination bounds connection setup too: aborting fetch alone does not. */
async function postNotification(
  endpoint: string,
  body: string,
  signal: AbortSignal,
): Promise<boolean> {
  const worker = new Worker(new URL('./ntfy-post.js', import.meta.url), {
    workerData: { endpoint, body },
    stdout: true,
    stderr: true,
  });
  // Worker diagnostics must never expose the topic or response to the terminal.
  worker.stdout.resume();
  worker.stderr.resume();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};

  try {
    return await new Promise<boolean>((resolve) => {
      cancel = () => resolve(false);
      worker.once('message', (delivered: unknown) => resolve(delivered === true));
      worker.once('error', cancel);
      worker.once('exit', cancel);
      timeout = setTimeout(cancel, 2_000);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
    // Also close lingering TLS connections on success or a fast fetch error.
    await worker.terminate();
  }
}
