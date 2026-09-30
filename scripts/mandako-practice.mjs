// Keep strongest-bot search off the matchmaking server's event loop.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
const { choosePracticeMove } = await tsImport('../server/practiceBot.ts', import.meta.url);
const { actionId } = await tsImport('../server/mandakoCodec.ts', import.meta.url);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let request;
  try {
    request = JSON.parse(line);
    const move = choosePracticeMove(request.state);
    process.stdout.write(JSON.stringify({ id: request.id, action: actionId(request.state, move) }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ id: request?.id, error: 'PRACTICE_SEARCH_FAILED' }) + '\n');
  }
}
