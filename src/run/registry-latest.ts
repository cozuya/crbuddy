import { parentPort, workerData } from 'node:worker_threads';

// As in ntfy-post: a short-lived worker owns fetch's sockets so the caller can
// close them even when TLS setup stalls. Only the tag's value, or null, crosses
// back. No top-level await: a request that never settles would otherwise have
// Node print an "unsettled top-level await" warning on the user's terminal.
async function latest(): Promise<string | null> {
  const { url } = workerData as { url: string };
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
  });
  const body: unknown = response.ok ? await response.json() : null;
  const tag =
    body && typeof body === 'object' ? (body as { latest?: unknown }).latest : undefined;

  return typeof tag === 'string' ? tag : null;
}

latest().then(
  (tag) => parentPort?.postMessage(tag),
  () => parentPort?.postMessage(null),
);
