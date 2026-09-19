import { spawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await pause(10);
  }
  throw new Error('로컬 매칭 검증 시간 초과');
}

// Explicit disposable database only. Never reads the application's DATABASE_URL.
it.skipIf(!process.env.MONGJIN_TEST_DATABASE_URL)(
  '최근 상대 조회가 지연돼도 취소한 요청으로 봇 방을 만들지 않고 다음 요청은 정상 매칭한다',
  async () => {
    const pool = new Pool({ connectionString: process.env.MONGJIN_TEST_DATABASE_URL, max: 2 });
    let server: ChildProcess | undefined;
    let socket: WebSocket | undefined;
    let locked = false;
    const lock = await pool.connect();
    try {
      server = spawn(process.execPath, ['--import', 'tsx', 'index.ts'], {
        cwd: dirname(fileURLToPath(import.meta.url)),
        env: { ...process.env, DATABASE_URL: process.env.MONGJIN_TEST_DATABASE_URL, HOST: '127.0.0.1', PORT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      server.stdout!.on('data', (chunk) => { output += chunk; });
      server.stderr!.on('data', (chunk) => { output += chunk; });
      const url = await until(() => output.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0]);
      socket = new WebSocket(url);
      const messages: Array<{ type: string; opponent?: { isBot?: boolean } }> = [];
      socket.on('message', (raw) => messages.push(JSON.parse(String(raw))));
      const next = (type: string) => until(() => {
        const index = messages.findIndex((message) => message.type === type);
        return index >= 0 ? messages.splice(index, 1)[0] : undefined;
      });
      await until(() => socket!.readyState === WebSocket.OPEN);
      socket.send(JSON.stringify({ type: 'HELLO' }));
      await next('IDENTITY');

      await lock.query('BEGIN');
      await lock.query('LOCK TABLE mongjin_bot_matches IN ACCESS EXCLUSIVE MODE');
      locked = true;
      socket.send(JSON.stringify({ type: 'MATCHMAKE_BOT' }));
      await until(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%SELECT bot_player_id, bot_name%'`)).rowCount);
      socket.send(JSON.stringify({ type: 'CANCEL_MATCHMAKING' }));
      await next('QUEUE_LEFT');
      await lock.query('ROLLBACK');
      locked = false;
      await pause(600);
      expect(messages.some((message) => message.type === 'MATCH_FOUND')).toBe(false);

      socket.send(JSON.stringify({ type: 'MATCHMAKE_BOT' }));
      expect((await next('MATCH_FOUND')).opponent?.isBot).toBe(true);
    } finally {
      if (locked) await lock.query('ROLLBACK');
      lock.release();
      socket?.terminate();
      if (server && server.exitCode === null) {
        const stopped = new Promise((resolve) => server!.once('exit', resolve));
        server.kill('SIGTERM');
        await stopped;
      }
      await pool.end();
    }
  },
  20000,
);
