import type { RuleConfig } from '../../src/core/config';
import type { Move, Player } from '../../src/core/types';
import type { WinReason } from '../../src/core/result';
import { formatMovetextFromMoves } from '../mgn/format';
import type { MgnGame } from '../mgn/types';
import type { StrategyEntry, StrategyPhase } from './types';

const PREFIX_LENGTHS = [2, 4, 6, 8, 10];
const MIN_SAMPLES = 3;
const MIN_WIN_RATE = 0.58;

interface PrefixStats {
  total: number;
  blackWins: number;
  whiteWins: number;
  moves: Move[];
  gameIds: string[];
}

interface MotifStats {
  total: number;
  wins: number;
  pattern: string;
  phase: StrategyPhase;
  tags: string[];
  title: string;
  summary: string;
}

function historyKey(moves: Move[]): string {
  return moves
    .map((m) =>
      m.kind === 'PLACE'
        ? `P:${m.to.r},${m.to.c}`
        : `M:${m.from.r},${m.from.c}>${m.to.r},${m.to.c}`,
    )
    .join('|');
}

function gameId(game: MgnGame, index: number): string {
  return `sp-${game.headers.date ?? 'x'}-${index}`;
}

function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

/** 셀프플레이 MGN에서 전략서 엔트리를 규칙 기반으로 추출 (LLM·API 없음) */
export function extractStrategies(games: MgnGame[], config: RuleConfig): StrategyEntry[] {
  const prefixes = new Map<string, PrefixStats>();
  const motifs = new Map<string, MotifStats>();

  games.forEach((game, index) => {
    const gid = gameId(game, index);
    const winner = game.headers.result;
    if (winner === 'DRAW') return;

    const moves = game.moves.map((e) => e.move);
    const reason = game.headers.termination;

    for (const len of PREFIX_LENGTHS) {
      if (moves.length < len) continue;
      const slice = moves.slice(0, len);
      const key = historyKey(slice);
      const prev = prefixes.get(key) ?? {
        total: 0,
        blackWins: 0,
        whiteWins: 0,
        moves: slice,
        gameIds: [],
      };
      prev.total++;
      if (winner === 'BLACK') prev.blackWins++;
      else prev.whiteWins++;
      prev.gameIds.push(gid);
      prefixes.set(key, prev);
    }

    if (reason && moves.length > 0) {
      recordMotif(motifs, moves, reason, config);
    }
  });

  const strategies: StrategyEntry[] = [];
  const now = new Date().toISOString();

  for (const [key, stats] of prefixes) {
    if (stats.total < MIN_SAMPLES) continue;
    const blackRate = stats.blackWins / stats.total;
    const whiteRate = stats.whiteWins / stats.total;
    const dominant: Player | null =
      blackRate >= MIN_WIN_RATE ? 'BLACK' : whiteRate >= MIN_WIN_RATE ? 'WHITE' : null;
    if (!dominant) continue;

    const winRate = dominant === 'BLACK' ? blackRate : whiteRate;
    const pattern = formatMovetextFromMoves(stats.moves, config);
    strategies.push({
      id: `sp-opening-${shortHash(key)}`,
      title: `오프닝 패턴 (${dominant === 'BLACK' ? '흑' : '백'} ${(winRate * 100).toFixed(0)}%)`,
      phase: 'opening',
      summary: `셀프플레이 ${stats.total}판 중 ${dominant === 'BLACK' ? '흑' : '백'} 승률 ${(winRate * 100).toFixed(0)}%`,
      mgnPattern: pattern,
      tags: ['opening', 'selfplay', dominant === 'BLACK' ? 'black' : 'white'],
      lessons: [`${stats.total}판 검증 — 승률 ${(winRate * 100).toFixed(0)}%`],
      sourceGames: [...new Set(stats.gameIds)].slice(0, 12),
      confidence: Math.min(0.95, winRate * Math.min(1, stats.total / 12)),
      updatedAt: now,
    });
  }

  for (const [, m] of motifs) {
    if (m.total < MIN_SAMPLES || m.wins / m.total < MIN_WIN_RATE) continue;
    const winRate = m.wins / m.total;
    strategies.push({
      id: `sp-motif-${shortHash(m.pattern)}`,
      title: m.title,
      phase: m.phase,
      summary: m.summary,
      mgnPattern: m.pattern,
      tags: [...m.tags, 'selfplay'],
      lessons: [`${m.total}판 중 ${m.wins}승`],
      sourceGames: [],
      confidence: Math.min(0.9, winRate * Math.min(1, m.total / 10)),
      updatedAt: now,
    });
  }

  return dedupeStrategies(strategies).sort((a, b) => b.confidence - a.confidence);
}

function tailMovetext(moves: Move[], config: RuleConfig, maxTokens = 6): string {
  if (!moves.length) return '';
  const full = formatMovetextFromMoves(moves, config);
  const tokens = full.replace(/\d+\./g, ' ').trim().split(/\s+/).filter(Boolean);
  return tokens.slice(-maxTokens).join(' ');
}

function recordMotif(
  motifs: Map<string, MotifStats>,
  moves: Move[],
  reason: WinReason,
  config: RuleConfig,
) {
  const pattern = tailMovetext(moves, config);
  if (!pattern) return;

  const defs: Partial<Record<WinReason, Omit<MotifStats, 'total' | 'wins'>>> = {
    capture: {
      pattern,
      phase: 'middlegame',
      tags: ['punish', 'king-capture'],
      title: '왕 잡기 마무리',
      summary: '상대 왕을 직접 잡는 수술로 대국을 끝낸다',
    },
    goal: {
      pattern,
      phase: 'endgame',
      tags: ['goal', 'king-rush'],
      title: '목적지 돌파',
      summary: '왕을 목적지에 도달시키는 마무리 패턴',
    },
    surround: {
      pattern,
      phase: 'middlegame',
      tags: ['surround', 'defense'],
      title: '왕 포위 승리',
      summary: '호위로 상대 왕을 포위해 승리한다',
    },
  };

  const def = defs[reason];
  if (!def) return;

  const key = `${reason}|${pattern}`;
  const prev = motifs.get(key) ?? { total: 0, wins: 0, ...def };
  prev.total++;
  prev.wins++;
  motifs.set(key, prev);
}

function dedupeStrategies(list: StrategyEntry[]): StrategyEntry[] {
  const map = new Map<string, StrategyEntry>();
  for (const s of list) {
    const prev = map.get(s.id);
    if (!prev || s.confidence > prev.confidence) map.set(s.id, s);
  }
  return [...map.values()];
}
