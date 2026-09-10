import { parentPort, workerData } from 'node:worker_threads';

// A short-lived worker owns fetch's sockets so the caller can close them even
// when TLS setup stalls. Only a success flag crosses back; errors stay private.
try {
  const { endpoint, body } = workerData as { endpoint: string; body: string };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Title: 'crbuddy finished',
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body,
    redirect: 'error',
  });
  void response.body?.cancel().catch(() => {});
  parentPort?.postMessage(response.ok);
} catch {
  parentPort?.postMessage(false);
}
