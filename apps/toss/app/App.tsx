import { Component, type ErrorInfo, type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { TDSMobileAITProvider } from '@toss/tds-mobile-ait';
import {
  Asset,
  Button,
  Paragraph,
  TextField,
} from '@toss/tds-mobile';
import { GameController, type GameSnapshot } from '@shared/ui/gameController';
import {
  AI_DIFFICULTY_PRESETS,
  opponentOf,
  type AiDifficulty,
  type HumanColorChoice,
  type OpponentMode,
} from '../../../packages/game-data/src';
import '@shared/ui/board.css';
import './ait.css';
import blackGuardUrl from '../assets/ui/stone-black-guard.png';
import blackKingUrl from '../assets/ui/stone-black-king.png';
import whiteGuardUrl from '../assets/ui/stone-white-guard.png';
import whiteKingUrl from '../assets/ui/stone-white-king.png';

const game = new GameController();

type Screen = 'home' | 'setup' | 'match' | 'friend' | 'game' | 'profile' | 'tutorial';

const MODE_LABEL: Record<OpponentMode, string> = {
  ai: '컴퓨터 대전',
  local: '같이 두기',
  online: '랜덤 대전',
  ghost: '빠른 대전',
};

type HomeTab = OpponentMode | 'friend';

const HOME_TABS: Array<{ key: HomeTab; label: string; description: string; cta: string }> = [
  { key: 'online', label: '빠른 대전', description: '접속 중인 상대와 자동 매칭', cta: '대국 시작' },
  { key: 'friend', label: '친구', description: '입장코드로 친구와 대국합니다', cta: '코드 만들기' },
  { key: 'ai', label: '컴퓨터', description: '난이도와 진영을 골라 연습합니다', cta: '대국 준비' },
  { key: 'local', label: '같이 두기', description: '한 기기에서 흑·백을 번갈아 둡니다', cta: '대국 시작' },
];

function useGameSnapshot() {
  return useSyncExternalStore(
    (cb) => game.subscribe(cb),
    () => game.getSnapshot(),
    () => game.getSnapshot(),
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[mongjin]', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="ait-error">
          <Paragraph typography="t4" fontWeight="bold" color="red500">
            오류가 발생했어요
          </Paragraph>
          <Paragraph typography="t7" color="adaptive-grey-700">
            {this.state.error}
          </Paragraph>
        </div>
      );
    }
    return this.props.children;
  }
}

function PreviewBoard() {
  const files = 'abcdefghi';
  const cells = Array.from({ length: 81 }, (_, index) => {
    const r = Math.floor(index / 9);
    const c = index % 9;
    const goal = (r === 0 || r === 8) && c >= 3 && c <= 5;
    const king = (r === 0 || r === 8) && c === 4;
    return (
      <div key={index} className={`ait-preview-cell${goal ? ' is-goal' : ''}`}>
        {c === 0 && <span className="ait-preview-rank">{9 - r}</span>}
        {r === 8 && <span className="ait-preview-file">{files[c]}</span>}
        {king && (
          <img
            className="ait-preview-king"
            src={r === 8 ? blackKingUrl : whiteKingUrl}
            alt=""
          />
        )}
      </div>
    );
  });
  return (
    <div className="ait-preview-board">
      <div className="ait-preview-grid">{cells}</div>
    </div>
  );
}

function ScreenNav({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header className="ait-nav">
      <button type="button" className="ait-nav-back" onClick={onBack} aria-label="뒤로">
        ‹
      </button>
      <h2>{title}</h2>
    </header>
  );
}

function HomeScreen({
  onSelect,
  onProfile,
  onTutorial,
  onFriend,
  profileName,
  profileMeta,
}: {
  onSelect: (mode: OpponentMode) => void;
  onProfile: () => void;
  onTutorial: () => void;
  onFriend: () => void;
  profileName: string;
  profileMeta: string;
}) {
  const [tab, setTab] = useState<HomeTab>('online');
  const current = HOME_TABS.find((item) => item.key === tab)!;

  const start = () => {
    if (tab === 'friend') onFriend();
    else onSelect(tab);
  };

  return (
    <div className="ait-screen ait-home">
      <div className="ait-home-top">
        <header className="ait-hero">
          <h1>몽진</h1>
        </header>
        <button
          type="button"
          className="ait-profile-chip"
          onClick={onProfile}
          aria-label={`${profileName}, ${profileMeta}. 프로필 열기`}
        >
          <strong>{profileName}</strong>
          <span>{profileMeta}</span>
        </button>
      </div>

      <div className="ait-preview-wrap" aria-hidden="true">
        <PreviewBoard />
      </div>

      <section className="ait-home-dock" aria-label="대국 설정">
        <div className="ait-mode-tabs" role="group" aria-label="대국 방식">
          {HOME_TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={tab === item.key ? 'is-active' : ''}
              aria-pressed={tab === item.key}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="ait-mode-description">{current.description}</p>
        <button type="button" className="ait-home-start" onClick={start}>
          {current.cta}
        </button>
        <button type="button" className="ait-text-btn" onClick={onTutorial}>
          튜토리얼
        </button>
      </section>
    </div>
  );
}

function SetupScreen({
  difficulty,
  color,
  onDifficulty,
  onColor,
  onBack,
  onStart,
}: {
  difficulty: AiDifficulty;
  color: HumanColorChoice;
  onDifficulty: (value: AiDifficulty) => void;
  onColor: (value: HumanColorChoice) => void;
  onBack: () => void;
  onStart: () => void;
}) {
  const preset = AI_DIFFICULTY_PRESETS[difficulty];
  return (
    <div className="ait-screen">
      <ScreenNav title="컴퓨터 대전" onBack={onBack} />
      <div className="ait-screen-body ait-setup-body">
        <p className="ait-lead">대국을 준비하세요</p>
        <section className="ait-setup-panel">
          <div className="ait-setup-group">
            <p className="ait-field-label">봇 난이도</p>
            <div className="ait-choice-row" role="group" aria-label="봇 난이도">
              {(['easy', 'normal', 'hard'] as AiDifficulty[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={difficulty === option ? 'is-active' : ''}
                  aria-pressed={difficulty === option}
                  onClick={() => onDifficulty(option)}
                >
                  {AI_DIFFICULTY_PRESETS[option].label}
                </button>
              ))}
            </div>
            <p className="ait-field-help">{preset.description}</p>
          </div>
          <div className="ait-setup-group">
            <p className="ait-field-label">내 색</p>
            <div className="ait-choice-row" role="group" aria-label="내 색">
              {([
                ['BLACK', '흑 · 선공'],
                ['WHITE', '백 · 후공'],
                ['random', '랜덤'],
              ] as const).map(([option, label]) => (
                <button
                  key={option}
                  type="button"
                  className={color === option ? 'is-active' : ''}
                  aria-pressed={color === option}
                  onClick={() => onColor(option)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <button type="button" className="ait-home-start" onClick={onStart}>
            대국 시작
          </button>
        </section>
      </div>
    </div>
  );
}

function MatchScreen({
  onBack,
  onRetry,
  onRelogin,
}: {
  onBack: () => void;
  onRetry: () => void;
  onRelogin: () => void;
}) {
  const snap = useGameSnapshot();

  return (
    <div className="ait-screen">
      <ScreenNav title="랜덤 대전" onBack={onBack} />
      <div className="ait-screen-body ait-match-body">
        <>
          <div className="ait-match-pulse" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p className="ait-lead">{snap.onlineWaiting ? '상대를 찾는 중' : '매칭 준비'}</p>
          <Paragraph typography="t6" color="adaptive-grey-600" style={{ textAlign: 'center' }}>
            {snap.onlineStatus || '접속 중인 상대를 찾습니다'}
          </Paragraph>
          {snap.visibleProfile && (
            <div className="ait-match-rating">
              {snap.visibleProfile.name} · Elo {snap.visibleProfile.rating}
              {snap.rankInfo ? ` · ${snap.rankInfo.rank}위` : ''}
            </div>
          )}
          {snap.onlineLoggedOut ? (
            <Button size="large" display="block" onClick={onRelogin}>
              토스로 다시 로그인
            </Button>
          ) : (
            snap.onlineError && (
              <Button size="large" variant="weak" display="block" onClick={onRetry}>
                다시 찾기
              </Button>
            )
          )}
        </>
      </div>
    </div>
  );
}

function FriendScreen({
  onBack,
  onCreate,
  onJoin,
}: {
  onBack: () => void;
  onCreate: () => void;
  onJoin: (code: string) => void;
}) {
  const snap = useGameSnapshot();
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const inRoom = snap.onlineMatchKind === 'friend' && snap.onlineRoomId !== null;
  const busy = snap.onlineWaiting && !snap.onlineError;

  const copyCode = async () => {
    if (!snap.onlineRoomId) return;
    try {
      await navigator.clipboard.writeText(snap.onlineRoomId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 클립보드를 쓸 수 없는 WebView에서는 코드를 화면에서 직접 확인 */
    }
  };

  return (
    <div className="ait-screen">
      <ScreenNav title="친구와 두기" onBack={onBack} />
      <div className="ait-screen-body ait-match-body">
        {inRoom ? (
          <>
            <div className="ait-match-pulse" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p className="ait-lead">친구를 기다리는 중</p>
            <div className="ait-friend-code" aria-label={`입장코드 ${snap.onlineRoomId}`}>
              {snap.onlineRoomId}
            </div>
            <Paragraph typography="t6" color="adaptive-grey-600" style={{ textAlign: 'center' }}>
              {snap.onlineStatus || '친구에게 입장코드를 알려주세요'}
            </Paragraph>
            <Button size="large" variant="weak" display="block" onClick={copyCode}>
              {copied ? '복사했어요' : '입장코드 복사'}
            </Button>
            <Button size="large" variant="weak" display="block" onClick={onBack}>
              대기 취소
            </Button>
          </>
        ) : (
          <>
            <p className="ait-lead">입장코드로 친구와 대국해요</p>
            <section className="ait-setup-card ait-friend-card">
              <Button size="large" display="block" disabled={busy} onClick={onCreate}>
                입장코드 만들기
              </Button>
              <TextField
                variant="line"
                label="입장코드"
                labelOption="sustain"
                placeholder="친구에게 받은 코드"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
              <Button
                size="large"
                variant="weak"
                display="block"
                disabled={busy}
                onClick={() => onJoin(code)}
              >
                코드로 참가하기
              </Button>
              {snap.onlineStatus && (
                <p className={`ait-online-note${snap.onlineError ? ' is-error' : ''}`}>
                  {snap.onlineStatus}
                </p>
              )}
              <p className="ait-field-help">친구 대전은 전적에 반영되지 않아요</p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function GuardTray({
  player,
  count,
  active,
}: {
  player: 'BLACK' | 'WHITE';
  count: number;
  active: boolean;
}) {
  const isWhite = player === 'WHITE';
  const label = isWhite ? '백' : '흑';
  const guardUrl = isWhite ? whiteGuardUrl : blackGuardUrl;

  return (
    <section
      className={`ait-guard-tray is-${player.toLowerCase()}${active ? ' is-active' : ''}`}
      aria-label={`${label} 호위 ${count}개 남음`}
    >
      <header className="ait-guard-tray-label">
        <strong>{label} 호위</strong>
        <span>{count} / 8</span>
      </header>
      <div className="ait-guard-grid" aria-hidden="true">
        {Array.from({ length: 8 }, (_, index) => (
          <span className="ait-guard-slot" key={index}>
            {index < count && <img src={guardUrl} alt="" draggable={false} />}
          </span>
        ))}
      </div>
    </section>
  );
}

function SeatRow({ snap }: { snap: GameSnapshot }) {
  return (
    <div className="ait-seats">
      <Seat player="WHITE" snap={snap} />
      <Seat player="BLACK" snap={snap} />
    </div>
  );
}

function Seat({ player, snap }: { player: 'BLACK' | 'WHITE'; snap: GameSnapshot }) {
  const isWhite = player === 'WHITE';
  // 고스트 폴백 대국은 ai 모드로 진행되므로 humanSide가 내 자리다
  const mySide = snap.onlineSide ?? (snap.settings.mode === 'ai' ? snap.humanSide : null);
  const opponentSide = mySide ? opponentOf(mySide) : null;
  const mine = mySide === player;
  const isOpponentSeat = opponentSide === player;
  const opponent = snap.onlineOpponent;
  const name = mine
    ? snap.visibleProfile?.name ?? '나'
    : isOpponentSeat && opponent
      ? opponent.name
      : '상대';
  const rating = mine ? snap.visibleProfile?.rating : isOpponentSeat ? opponent?.rating : null;
  const active = !snap.resultTitle && snap.state.turn === player;

  return (
    <section className={`ait-seat is-${player.toLowerCase()}${active ? ' is-active' : ''}`}>
      <img
        className="ait-seat-stone"
        src={isWhite ? whiteGuardUrl : blackGuardUrl}
        alt=""
        draggable={false}
      />
      <div className="ait-seat-info">
        <div className="ait-seat-name">
          <strong>{name}</strong>
          {mine && <span className="ait-seat-me">나</span>}
        </div>
        <span className="ait-seat-detail">
          {isWhite ? '백' : '흑'}
          {rating !== null && rating !== undefined ? ` · Elo ${rating}` : ''}
        </span>
      </div>
    </section>
  );
}

function MoveClock({ remaining, waiting }: { remaining: number; waiting: boolean }) {
  const running = remaining > 0 && !waiting;
  const urgent = running && remaining <= 10;
  const label = running
    ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
    : '—:—';
  return (
    <div className={`ait-clock${urgent ? ' is-urgent' : ''}`} role="timer" aria-label={running ? `남은 시간 ${label}` : '상대 차례'}>
      <strong>{label}</strong>
      <span>{running ? '남은 시간' : '상대 차례'}</span>
    </div>
  );
}

function GameScreen({ onLeave }: { onLeave: () => void }) {
  const snap = useGameSnapshot();
  const boardRef = useRef<HTMLDivElement>(null);
  const isWhiteTurn = snap.state.turn === 'WHITE';
  const turnDetail = snap.turnLabel.includes(' · ')
    ? snap.turnLabel.split(' · ').slice(1).join(' · ')
    : null;
  const modeLabel = MODE_LABEL[snap.settings.mode];
  const chip =
    snap.onlineOpponent
      ? snap.onlineOpponent.name
      : snap.settings.mode === 'ai'
      ? `${modeLabel} · ${AI_DIFFICULTY_PRESETS[snap.settings.aiDifficulty].label}`
      : modeLabel;
  const quickFallback = snap.onlineOpponent?.isBot === true;
  const quick = snap.onlineMatchKind === 'random' || quickFallback;
  const friendRunning =
    snap.settings.mode === 'online' && snap.onlineMatchKind === 'friend' && !snap.resultTitle && snap.onlineSide !== null;
  const canResign = quick && !snap.resultTitle;
  // 'resign' = 항복 확인, 'leave' = 친구 대국 종료 확인
  const [ask, setAsk] = useState<null | 'resign' | 'leave'>(null);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    const tick = () => {
      setRemaining(snap.moveDeadline ? Math.max(0, Math.ceil((snap.moveDeadline - Date.now()) / 1000)) : 0);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [snap.moveDeadline]);

  useLayoutEffect(() => {
    if (boardRef.current) game.attachBoard(boardRef.current);
    return () => game.detachBoard();
  }, []);

  useEffect(() => {
    const onResize = () => game.refreshBoardLayout();
    window.addEventListener('resize', onResize);
    const wrap = boardRef.current?.parentElement;
    const ro =
      wrap && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    if (wrap && ro) ro.observe(wrap);
    return () => {
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
    };
  }, []);

  useEffect(() => {
    setAsk(null);
  }, [snap.resultTitle]);

  const leaveLabel = snap.resultTitle ? '나가기' : canResign ? '항복' : friendRunning ? '대국 종료' : '새 게임';

  const primaryAction = () => {
    if (snap.resultTitle) {
      onLeave();
      return;
    }
    if (canResign) {
      setAsk('resign');
      return;
    }
    if (friendRunning) {
      setAsk('leave');
      return;
    }
    game.reset();
  };

  const confirmAction = () => {
    if (ask === 'resign') game.resign();
    else if (ask === 'leave') onLeave();
    setAsk(null);
  };

  /** 뒤로 가기: 진행 중 빠른 대전은 항복 확인, 그 외에는 메인으로 나간다 */
  const backAction = () => {
    if (snap.resultTitle) {
      onLeave();
      return;
    }
    if (canResign) {
      setAsk('resign');
      return;
    }
    if (friendRunning) {
      setAsk('leave');
      return;
    }
    onLeave();
  };

  return (
    <div className="ait-screen ait-game">
      <ScreenNav title={chip} onBack={backAction} />

      {snap.onlineOpponent && <SeatRow snap={snap} />}

      <div className="ait-board-wrap">
        <div ref={boardRef} className="ait-board" />
      </div>

      <section className="ait-hud">
        {snap.resultTitle ? (
          <>
            <p className="ait-result">{snap.resultTitle}</p>
            <p className="ait-result-sentence">{snap.resultSentence}</p>
          </>
        ) : (
          <>
            <div className={`ait-turn${isWhiteTurn ? ' is-white' : ' is-black'}`} role="status">
              <Asset.Icon
                name="icon-system-arrow-back-android-outlined"
                color={isWhiteTurn ? '#315f89' : '#202a33'}
                frameShape={{ width: 26, height: 26 }}
                style={{ transform: isWhiteTurn ? 'rotate(180deg)' : undefined }}
                alt=""
              />
              <strong>{isWhiteTurn ? '백 차례' : '흑 차례'}</strong>
              {turnDetail && <span>{turnDetail}</span>}
            </div>
            {snap.ghostNote && <p className="ait-ghost-note">{snap.ghostNote}</p>}
          </>
        )}
        {snap.onlineStatus && snap.settings.mode === 'online' && (
          <p className={`ait-online-note${snap.onlineError ? ' is-error' : ''}`}>{snap.onlineStatus}</p>
        )}
        <div className="ait-guard-trays">
          <GuardTray
            player="WHITE"
            count={snap.state.guardsInHand.WHITE}
            active={!snap.resultTitle && isWhiteTurn}
          />
          <GuardTray
            player="BLACK"
            count={snap.state.guardsInHand.BLACK}
            active={!snap.resultTitle && !isWhiteTurn}
          />
        </div>
      </section>

      <div className="ait-actions">
        {ask ? (
          <>
            <Button size="large" variant="weak" display="block" onClick={() => setAsk(null)}>
              취소
            </Button>
            <Button size="large" display="block" onClick={confirmAction}>
              {ask === 'resign' ? '항복' : '종료'}
            </Button>
          </>
        ) : (
          <>
            {quick ? (
              <MoveClock remaining={remaining} waiting={Boolean(snap.resultTitle) || snap.aiThinking || !snap.isMyTurn} />
            ) : snap.settings.mode === 'online' ? (
              <div />
            ) : (
              <Button
                size="large"
                variant="weak"
                display="block"
                disabled={!snap.canUndo || snap.aiThinking}
                onClick={() => game.undo()}
              >
                무르기
              </Button>
            )}
            <Button
              size="large"
              display="block"
              disabled={snap.aiThinking && snap.settings.mode !== 'online' && !quickFallback}
              onClick={primaryAction}
            >
              {leaveLabel}
            </Button>
          </>
        )}
      </div>
      {ask === 'resign' && (
        <p className="ait-confirm-note" role="alert">
          이 대국은 패배로 기록됩니다. 상대 입장에서는 당신이 항복한 것으로 남습니다.
        </p>
      )}
      {ask === 'leave' && (
        <p className="ait-confirm-note" role="alert">
          진행 중인 대국은 저장되지 않습니다.
        </p>
      )}
    </div>
  );
}

function ProfileScreen({
  profileName,
  onNameChange,
  onSave,
  onBack,
}: {
  profileName: string;
  onNameChange: (value: string) => void;
  onSave: () => void;
  onBack: () => void;
}) {
  const snap = useGameSnapshot();

  return (
    <div className="ait-screen">
      <ScreenNav title="내 프로필" onBack={onBack} />
      <div className="ait-screen-body ait-profile-body">
        <>
          <div className="ait-rank-card">
            <span>전체 순위</span>
            <strong>{snap.rankInfo ? `${snap.rankInfo.rank}위` : '—'}</strong>
            <small>
              {snap.visibleProfile
                ? `Elo ${snap.visibleProfile.rating} · ${snap.visibleProfile.wins}승 ${snap.visibleProfile.losses}패 · 승률 ${snap.visibleProfile.winRate}%`
                : '대국을 두면 전적이 쌓입니다'}
              {snap.rankInfo ? ` · ${snap.rankInfo.totalPlayers}명 중` : ''}
            </small>
          </div>
          <section className="ait-setup-card">
            <TextField
              variant="line"
              label="닉네임"
              labelOption="sustain"
              placeholder="2~12자"
              value={profileName}
              onChange={(e) => onNameChange(e.target.value)}
            />
            <Button size="large" variant="weak" display="block" onClick={onSave}>
              닉네임 저장
            </Button>
          </section>
        </>
      </div>
    </div>
  );
}

function TutorialScreen({
  onBack,
  onPractice,
}: {
  onBack: () => void;
  onPractice: () => void;
}) {
  const snap = useGameSnapshot();
  const boardRef = useRef<HTMLDivElement>(null);
  const total = snap.tutorialTotal;
  const step = snap.tutorialStep;

  useLayoutEffect(() => {
    if (boardRef.current) game.attachBoard(boardRef.current);
    return () => game.detachBoard();
  }, []);

  useEffect(() => {
    const onResize = () => game.refreshBoardLayout();
    window.addEventListener('resize', onResize);
    const wrap = boardRef.current?.parentElement;
    const ro =
      wrap && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    if (wrap && ro) ro.observe(wrap);
    return () => {
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
    };
  }, []);

  return (
    <div className="ait-screen ait-tutorial">
      <ScreenNav title="튜토리얼" onBack={onBack} />
      <div className="ait-screen-body ait-tutorial-body">
        {!snap.tutorialFinished && <p className="ait-tutorial-count"><strong>{step}</strong> / {total}</p>}
        <h3 className="ait-tutorial-title">{snap.tutorialTitle}</h3>
        {snap.tutorialCoach && <p className="ait-tutorial-copy">{snap.tutorialCoach}</p>}
        <div className="ait-board-wrap ait-tutorial-board">
          <div ref={boardRef} className="ait-board" />
        </div>
        {!snap.tutorialFinished ? (
          <>
            <div className="ait-tutorial-progress" aria-label={`레슨 ${step} / ${total}`}>
              {Array.from({ length: total }, (_, index) => (
                <span
                  key={index}
                  className={index === step - 1 ? 'is-active' : index < step - 1 ? 'is-done' : ''}
                />
              ))}
            </div>
            <div className="ait-hint-panel" aria-live="polite">
              <span>지금 할 일 ☝</span>
              <strong>{snap.tutorialHint}</strong>
            </div>
          </>
        ) : (
          <div className="ait-tutorial-actions">
            <Button size="large" display="block" onClick={onPractice}>
              컴퓨터로 연습하기
            </Button>
            <Button size="large" variant="weak" display="block" onClick={onBack}>
              홈으로
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function MongjinApp() {
  const snap = useGameSnapshot();
  const [screen, setScreen] = useState<Screen>('home');
  const [profileName, setProfileName] = useState('');
  const [setupDifficulty, setSetupDifficulty] = useState<AiDifficulty>('normal');
  const [setupColor, setSetupColor] = useState<HumanColorChoice>('BLACK');
  const matchStarted = useRef(false);

  useEffect(() => {
    game.setMode('local');
    game.init({ fetchProfile: true });
    return () => game.destroy();
  }, []);

  useEffect(() => {
    if (snap.visibleProfile && !profileName) setProfileName(snap.visibleProfile.name);
  }, [snap.visibleProfile, profileName]);

  useEffect(() => {
    if (screen === 'tutorial') game.enterTutorial();
  }, [screen]);

  useEffect(() => {
    if (screen === 'match' && (snap.onlineSide || snap.onlineOpponent?.isBot)) setScreen('game');
  }, [screen, snap.onlineSide, snap.onlineOpponent]);

  useEffect(() => {
    if (screen === 'friend' && snap.onlineMatchKind === 'friend' && snap.onlineOpponent) {
      setScreen('game');
    }
  }, [screen, snap.onlineMatchKind, snap.onlineOpponent]);

  const leaveToMenu = () => {
    matchStarted.current = false;
    game.detachBoard();
    if (snap.onlineWaiting) {
      if (snap.onlineMatchKind === 'friend') game.cancelFriendRoom();
      else game.cancelRandomMatch();
    }
    game.setMode('local');
    setScreen('home');
  };

  const closeTutorial = () => {
    game.exitTutorial();
    setScreen('home');
  };

  const practiceFromTutorial = () => {
    game.exitTutorial();
    setSetupDifficulty('normal');
    setSetupColor('BLACK');
    setScreen('setup');
  };

  const startLocal = () => {
    game.setMode('local');
    game.reset();
    setScreen('game');
  };

  const startAi = () => {
    game.setAiDifficulty(setupDifficulty);
    game.setHumanColor(setupColor);
    game.setMode('ai');
    setScreen('game');
  };

  const startOnline = () => {
    matchStarted.current = false;
    game.setMode('online');
    setScreen('match');
  };

  const startFriend = () => {
    matchStarted.current = false;
    game.setMode('online');
    setScreen('friend');
  };

  const startMatchmaking = () => {
    matchStarted.current = true;
    game.startRandomMatch();
  };

  useEffect(() => {
    if (screen !== 'match') return;
    if (matchStarted.current) return;
    startMatchmaking();
  }, [screen]);

  const profileLabel = snap.visibleProfile?.name ?? '나그네';
  const rankSuffix = snap.rankInfo ? `${snap.rankInfo.rank}위 · ` : '';
  const profileMeta = snap.visibleProfile
    ? `${rankSuffix}Elo ${snap.visibleProfile.rating} · ${snap.visibleProfile.wins}승`
    : '기록을 준비하는 중';

  return (
    <div className="ait-shell">
      {screen === 'home' && (
        <HomeScreen
          onSelect={(mode) => {
            if (mode === 'ai') setScreen('setup');
            else if (mode === 'local') startLocal();
            else startOnline();
          }}
          onProfile={() => setScreen('profile')}
          onTutorial={() => setScreen('tutorial')}
          onFriend={startFriend}
          profileName={profileLabel}
          profileMeta={profileMeta}
        />
      )}
      {screen === 'setup' && (
        <SetupScreen
          difficulty={setupDifficulty}
          color={setupColor}
          onDifficulty={setSetupDifficulty}
          onColor={setSetupColor}
          onBack={() => setScreen('home')}
          onStart={startAi}
        />
      )}
      {screen === 'match' && (
        <MatchScreen
          onBack={leaveToMenu}
          onRetry={startMatchmaking}
          onRelogin={() => {
            void game.retryTossLogin().then((ok) => {
              if (ok) startMatchmaking();
            });
          }}
        />
      )}
      {screen === 'friend' && (
        <FriendScreen
          onBack={leaveToMenu}
          onCreate={() => void game.createRoom()}
          onJoin={(code) => void game.joinRoom(code)}
        />
      )}
      {screen === 'game' && <GameScreen onLeave={leaveToMenu} />}
      {screen === 'profile' && (
        <ProfileScreen
          profileName={profileName}
          onNameChange={setProfileName}
          onSave={() => game.saveName(profileName)}
          onBack={() => setScreen('home')}
        />
      )}
      {screen === 'tutorial' && (
        <TutorialScreen onBack={closeTutorial} onPractice={practiceFromTutorial} />
      )}
      {snap.toast && (
        <div className="ait-toast" role="status">
          {snap.toast}
        </div>
      )}
    </div>
  );
}

export function App() {
  return (
    <TDSMobileAITProvider brandPrimaryColor="#315f89">
      <ErrorBoundary>
        <MongjinApp />
      </ErrorBoundary>
    </TDSMobileAITProvider>
  );
}
