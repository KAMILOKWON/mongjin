import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { moveForAction } from './mandakoCodec';

describe('built-in strongest practice opponent', () => {
  it('answers a real move without a Python runtime or checkpoint and keeps inference off the caller', async () => {
    const state = applyMove(initialState(DEFAULT_CONFIG), legalMoves(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG)[0]!);
    const env = { ...process.env };
    delete env.MONGJIN_MANDAKO_PYTHON;
    delete env.MONGJIN_MANDAKO_ROOT;
    delete env.MONGJIN_MANDAKO_CHECKPOINT;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/mandako-practice.mjs', import.meta.url))], {
      env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      const result = new Promise<number | null>((resolve, reject) => {
        child.stdout.on('data', chunk => { stdout += String(chunk); });
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        child.once('error', reject);
        child.once('close', resolve);
      });
      child.stdin.end(JSON.stringify({ id: 1, state }) + '\n');
      expect(await result, stderr).toBe(0);
      const reply = JSON.parse(stdout.trim());
      expect(reply.id).toBe(1);
      expect(legalMoves(state, DEFAULT_CONFIG)).toContainEqual(moveForAction(state, reply.action));
      expect(ticks).toBeGreaterThan(1);
    } finally {
      clearInterval(timer);
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }, 15_000);
});
