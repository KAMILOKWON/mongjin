import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JevError, type JevErrorCode } from './jev';
import { ParallelTurnError, type ParallelTurnOptions, type ParallelTurnTrace, type chooseParallelJevMove } from './jevParallel';

/** CPU search runs outside the WebSocket event loop; a cancelled turn kills all its work. */
export function chooseRankedJevMove(options: Omit<ParallelTurnOptions, 'evaluate' | 'facts' | 'search'>): ReturnType<typeof chooseParallelJevMove> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new JevError('aborted', 'JEV turn cancelled')); return; }
    const remaining = options.deadlineMs - Date.now();
    if (remaining <= 0) { reject(new JevError('timeout', 'JEV turn expired')); return; }
    let child: ReturnType<typeof fork>;
    try {
      child = fork(fileURLToPath(new URL('./jevWorker.ts', import.meta.url)), [], {
        execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
      });
    } catch {
      reject(new JevError('worker_error', 'JEV worker could not start')); return;
    }
    let settled = false;
    let latestTrace: ParallelTurnTrace | undefined;
    const cleanup = () => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      child.kill();
    };
    const fail = (code: JevErrorCode, status?: number) => {
      if (settled) return; settled = true; cleanup();
      if (latestTrace) {
        latestTrace.status = code === 'aborted' ? 'cancelled' : 'error'; latestTrace.error = code;
        latestTrace.errorStatus = status;
        latestTrace.elapsedMs = Date.now() - Date.parse(latestTrace.startedAt);
        reject(new ParallelTurnError(code, latestTrace, status));
      } else reject(new JevError(code, `JEV worker failed: ${code}`, status));
    };
    const onAbort = () => fail('aborted');
    const timer = setTimeout(() => fail('timeout'), remaining);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('message', (message: { type: string; trace?: ParallelTurnTrace; result?: Awaited<ReturnType<typeof chooseParallelJevMove>>; code?: JevErrorCode; status?: number }) => {
      if (settled) return;
      if (message.trace) { latestTrace = message.trace; options.onTrace?.(message.trace); }
      if (message.type === 'error') fail(message.code ?? 'invalid_response', message.status);
      if (message.type === 'result' && message.result) { settled = true; cleanup(); resolve(message.result); }
    });
    child.once('error', () => fail('worker_error'));
    child.once('exit', () => { if (!settled) fail('worker_error'); });
    const { signal: _signal, onTrace: _onTrace, ...request } = options;
    child.send(request, (error) => { if (error) fail('worker_error'); });
  });
}
