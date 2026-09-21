import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BENCH_JEV_HELP,
  buildDryRunPlan,
  main,
  parseBenchArgs,
  resolveMatches,
} from './benchJev';

const FOUR_STRONG_PROFILES = [
  'tactical-1800:tactician:1800:1800',
  'guard-pressure-1800:guardian:1800:1800',
  'tactical-2000:tactician:2000:2000',
  'guard-pressure-2000:guardian:2000:2000',
] as const;

function explicitProfileArgs() {
  return FOUR_STRONG_PROFILES.flatMap((profile) => ['--opponent-profile', profile]);
}

describe('benchJev explicit opponent configuration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preserves the legacy default and matrix selections', () => {
    const defaults = parseBenchArgs(['--mock', '--outdir', '/tmp/jev-default']);
    expect(resolveMatches(defaults).map(({ botId, jevSide }) => ({ botId, jevSide }))).toEqual([
      { botId: 'ranked-bot-furnace', jevSide: 'BLACK' },
      { botId: 'ranked-bot-furnace', jevSide: 'WHITE' },
    ]);

    const matrix = parseBenchArgs(['--mock', '--outdir', '/tmp/jev-matrix', '--matrix']);
    expect(resolveMatches(matrix).map((match) => match.botId)).toEqual([
      'ranked-bot-may',
      'ranked-bot-may',
      'ranked-bot-uzumaki',
      'ranked-bot-uzumaki',
    ]);
  });

  it('accepts repeated ranked IDs and custom official-bot profiles in caller order', () => {
    const options = parseBenchArgs([
      '--mock', '--outdir', '/tmp/jev-explicit', '--side', 'BLACK',
      '--opponent', 'ranked-bot-faker',
      '--opponent', 'ranked-bot-guide',
      '--opponent-profile', FOUR_STRONG_PROFILES[0],
    ]);
    expect(resolveMatches(options)).toEqual([
      expect.objectContaining({
        botId: 'ranked-bot-faker',
        botSource: 'ranked-bot',
        botPersonality: 'tactician',
        botConfiguredSearchRating: 1500,
      }),
      expect.objectContaining({
        botId: 'ranked-bot-guide',
        botSource: 'ranked-bot',
        botPersonality: 'guardian',
        botConfiguredSearchRating: 1600,
      }),
      expect.objectContaining({
        botId: 'tactical-1800',
        botSource: 'custom-profile',
        botPersonality: 'tactician',
        botConfiguredSearchRating: 1800,
        botProfileEloLabel: 1800,
        botStrengthBasis: 'official-bot-config-not-empirical-elo',
      }),
    ]);
  });

  it('builds a deterministic four-policy, two-color plan with fully logged bot budgets', () => {
    const options = parseBenchArgs([
      '--live', '--dry-run', '--outdir', '/tmp/jev-v14-plan', '--seed', '731991',
      ...explicitProfileArgs(),
    ]);
    const first = buildDryRunPlan(options);
    const second = buildDryRunPlan(options);

    expect(first).toEqual(second);
    expect(first.gameCount).toBe(8);
    expect(first.games.map((game) => game.match.jevSide)).toEqual([
      'BLACK', 'WHITE', 'BLACK', 'WHITE', 'BLACK', 'WHITE', 'BLACK', 'WHITE',
    ]);
    expect(first.games.map((game) => game.opponentConfig.personality)).toEqual([
      'tactician', 'tactician', 'guardian', 'guardian',
      'tactician', 'tactician', 'guardian', 'guardian',
    ]);
    expect(first.games.map((game) => game.opponentConfig.configuredSearchRating)).toEqual([
      1800, 1800, 1800, 1800, 2000, 2000, 2000, 2000,
    ]);
    for (const game of first.games) {
      expect(game.opponentConfig.search).toEqual(expect.objectContaining({
        maxMs: expect.any(Number),
        maxDepth: expect.any(Number),
        maxNodes: expect.any(Number),
        choiceWindow: expect.any(Number),
        planStrength: expect.any(Number),
      }));
      expect(game.opponentConfig.firstThreeChoiceWindow).toBeGreaterThanOrEqual(12);
      expect(game.opponentConfig.strengthBasis).toBe(
        'official-bot-config-not-empirical-elo',
      );
    }
  });

  it('rejects ambiguous selectors and malformed strength profiles', () => {
    expect(() => parseBenchArgs([
      '--mock', '--outdir', '/tmp/out', '--matrix',
      '--opponent-profile', FOUR_STRONG_PROFILES[0],
    ])).toThrow('cannot be combined');
    expect(() => parseBenchArgs([
      '--mock', '--outdir', '/tmp/out',
      '--opponent-profile', 'bad:berserker:1800',
    ])).toThrow('personality must be');
    expect(() => parseBenchArgs([
      '--mock', '--outdir', '/tmp/out',
      '--opponent-profile', 'bad:tactician:1810',
    ])).toThrow('multiple of 20');
  });

  it('prints CLI help without requiring mode or output arguments', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--help']);
    expect(log).toHaveBeenCalledOnce();
    expect(BENCH_JEV_HELP).toContain('--opponent-profile');
    expect(log.mock.calls[0]?.[0]).toContain('--dry-run');
  });

  it('executes live dry-run planning without a key file or benchmark execution', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main([
      '--live', '--dry-run', '--outdir', '/path/that/is/not/created', '--seed', '731991',
      ...explicitProfileArgs(),
    ]);
    expect(log).toHaveBeenCalledOnce();
    const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(printed).toMatchObject({ mode: 'live', dryRun: true, gameCount: 8 });
  });
});
