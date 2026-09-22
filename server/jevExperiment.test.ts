import { expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { JEV_EXPIRES_AT, JevExperiment } from './jevExperiment';

const state = initialState(DEFAULT_CONFIG);
const decision = { move: legalMoves(state, DEFAULT_CONFIG)[0]!, elapsedMs: 20, model: 'typesafe-ai/jev', inputTokens: 100, outputTokens: 1, cost: 0 };
const env = { MONGJIN_JEV_ENABLED: '1', AI_GATEWAY_API_KEY: 'test-key' };
const beforeExpiry = () => Date.parse('2026-09-20T00:00:00Z');

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
