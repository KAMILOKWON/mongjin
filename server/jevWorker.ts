import { chooseParallelJevMove, ParallelTurnError, type ParallelTurnOptions } from './jevParallel';
import { JevError } from './jev';

process.once('message', async (message: Omit<ParallelTurnOptions, 'signal' | 'evaluate' | 'facts' | 'search' | 'onTrace'>) => {
  try {
    const result = await chooseParallelJevMove({ ...message, onTrace: (trace) => process.send?.({ type: 'trace', trace }) });
    process.send?.({ type: 'result', result });
  } catch (error) {
    process.send?.({ type: 'error', code: error instanceof JevError ? error.code : 'invalid_response',
      status: error instanceof JevError ? error.status : undefined,
      trace: error instanceof ParallelTurnError ? error.trace : undefined });
  }
});
