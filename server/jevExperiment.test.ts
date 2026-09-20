import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { JEV_BOT, JEV_EXPIRES_AT, JevExperiment } from './jevExperiment';
import { ensureRankedBots, isRankedBotId, selectRankedBot } from './rankedBots';
import { FileProfileRepository } from './profileRepository';
import { createRankedBot, chooseOfficialBotMove } from './officialBot';

const state = initialState(DEFAULT_CONFIG);
const decision = { move: legalMoves(state, DEFAULT_CONFIG)[0]!, elapsedMs: 20, model: 'typesafe-ai/jev', inputTokens: 100, outputTokens: 1, cost: 0 };
const env = { MONGJIN_JEV_ENABLED: '1', AI_GATEWAY_API_KEY: 'test-key' };
const beforeExpiry = () => Date.parse('2026-09-20T00:00:00Z');

it('JEV is opt-in, starts at 1200, preserves records, and stays excluded after disabling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mongjin-jev-roster-'));
  try {
    const repo = new FileProfileRepository(join(dir, 'profiles.json'));
    expect(await ensureRankedBots(repo)).toHaveLength(14);
    const roster = await ensureRankedBots(repo, true);
    const jev = roster.find((p) => p.playerId === JEV_BOT.id)!;
    expect(jev).toMatchObject({ name: 'JEV', rating: 1200, wins: 0, losses: 0 });
    expect(isRankedBotId(jev.playerId)).toBe(true);
    await repo.saveProfile({ ...jev, rating: 1500, wins: 12, losses: 2 });
    expect((await ensureRankedBots(repo, true)).find((p) => p.playerId === jev.playerId)).toMatchObject({ rating: 1500, wins: 12, losses: 2 });
    for (let i = 0; i < 100; i++) {
      expect(selectRankedBot(roster, 1200, { random: () => i / 100 }).playerId).not.toBe(jev.playerId);
    }
    expect(selectRankedBot([jev], 1200, { includeJev: true }).playerId).toBe(jev.playerId);
    expect(() => chooseOfficialBotMove(createRankedBot(jev), state, DEFAULT_CONFIG)).toThrow('asynchronous');
    expect((await ensureRankedBots(repo)).find((p) => p.playerId === jev.playerId)?.rating).toBe(1500);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('never admits disabled, missing-key, or nearly expired experiments; never calls after expiry', async () => {
  const decide = vi.fn().mockResolvedValue(decision);
  expect(new JevExperiment({}, beforeExpiry, decide).canMatch).toBe(false);
  expect(new JevExperiment({ MONGJIN_JEV_ENABLED: '1' }, beforeExpiry, decide).canMatch).toBe(false);
  const cutoff = Date.parse(JEV_EXPIRES_AT);
  expect(new JevExperiment(env, () => cutoff - 1, decide).canMatch).toBe(false);
  const expired = new JevExperiment(env, () => cutoff, decide);
  await expect(expired.move(state, DEFAULT_CONFIG)).rejects.toThrow('expired');
  expect(decide).not.toHaveBeenCalled();
});

it('requires zero cost, stops unverified billing, and does not expose API keys in status', async () => {
  const decide = vi.fn().mockResolvedValue({ ...decision, cost: null });
  const experiment = new JevExperiment(env, beforeExpiry, decide);
  await expect(experiment.move(state, DEFAULT_CONFIG)).rejects.toThrow('billing_unverified');
  expect(experiment.canMatch).toBe(false);
  expect(JSON.stringify(experiment.status)).not.toContain('test-key');
  expect(experiment.status.successfulMoves).toBe(0);
});

it('uses only JEV, bounds timeouts by the deadline, and rejects late responses', async () => {
  let time = Date.parse(JEV_EXPIRES_AT) - 100;
  const decide = vi.fn().mockImplementation(async () => { time += 101; return decision; });
  const experiment = new JevExperiment(env, () => time, decide);
  await expect(experiment.move(state, DEFAULT_CONFIG)).rejects.toThrow('expired');
  expect(decide.mock.calls[0]![2].timeoutMs).toBe(100);
  expect(experiment.status.successfulMoves).toBe(0);
});

it('keeps a free valid model selection and does not count cancellation as a model failure', async () => {
  const decide = vi.fn().mockResolvedValue(decision);
  const experiment = new JevExperiment(env, beforeExpiry, decide);
  expect(await experiment.move(state, DEFAULT_CONFIG)).toEqual(decision);
  expect(experiment.status.successfulMoves).toBe(1);
  const controller = new AbortController(); controller.abort();
  await expect(experiment.move(state, DEFAULT_CONFIG, controller.signal)).rejects.toThrow('aborted');
  expect(experiment.status.failures).toBe(0);
});
