import { Component, type ErrorInfo, type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { TDSMobileAITProvider } from '@toss/tds-mobile-ait';
import {
  Asset,
  Button,
  Paragraph,
  TextField,
} from '@toss/tds-mobile';
import { GameController } from '@shared/ui/gameController';
import {
  AI_DIFFICULTY_PRESETS,
  type AiDifficulty,
  type HumanColorChoice,
  type OpponentMode,
} from '@shared/game/settings';
import '@shared/ui/board.css';
import './ait.css';
import tutorialGoalUrl from '../assets/tutorial/tutorial-goal.jpg';
import tutorialPlaceUrl from '../assets/tutorial/tutorial-place.jpg';
import tutorialMoveUrl from '../assets/tutorial/tutorial-move.jpg';
import tutorialProtectUrl from '../assets/tutorial/tutorial-protect.jpg';
import blackGuardUrl from '../assets/ui/stone-black-guard.png';
import blackKingUrl from '../assets/ui/stone-black-king.png';
import whiteGuardUrl from '../assets/ui/stone-white-guard.png';
import whiteKingUrl from '../assets/ui/stone-white-king.png';

const game = new GameController();

type Screen = 'home' | 'setup' | 'match' | 'game' | 'profile' | 'tutorial';

const TUTORIAL_STEPS = [
  {
    title: '왕을 피난시키세요',
    image: tutorialGoalUrl,
    alt: '흑 왕이 상대편 끝줄의 가운데 목적지로 이동하는 경로',
    copy: '자기 왕(王)을 상대 진영 맨 끝줄의 가운데 세 칸 중 하나에 먼저 올리면 이깁니다. 목적지에 도착한 턴이 끝나는 순간 승리합니다.',
  },
  {
    title: '호위를 배치하세요',
    image: tutorialPlaceUrl,
    alt: '왕과 호위에 상하좌우로 맞닿은 칸에 새 호위를 배치하는 모습',
    copy: '매 턴 호위 하나를 자기 말과 상하좌우로 맞닿은 빈 칸에 둘 수 있습니다. 호위는 진영마다 8개입니다. 양쪽 목적지 칸에는 호위를 둘 수 없습니다.',
  },
  {
    title: '두거나, 움직이세요',
    image: tutorialMoveUrl,
    alt: '왕은 여덟 방향, 호위는 상하좌우 네 방향으로 움직이는 방법',
    copy: '한 턴에는 호위를 새로 두거나, 이미 있는 말 하나를 움직입니다. 둘 다 할 수는 없습니다. 왕은 여덟 방향 1칸, 호위는 상하좌우 1칸입니다.',
  },
  {
    title: '왕을 끝까지 지키세요',
    image: tutorialProtectUrl,
    alt: '세 호위가 왕을 둘러싸고 상대 호위의 접근을 막는 모습',
    copy: '호위는 상대 호위와 상대 왕을 잡을 수 있습니다. 왕이 잡히면 즉시 패배합니다. 왕은 잡지 못하고 빈 칸으로만 움직이니, 혼자 돌진하지 마세요.',
  },
] as const;

const MODE_LABEL: Record<OpponentMode, string> = {
  ai: '컴퓨터 대전',
  local: '같이 두기',
  online: '랜덤 대전',
};

const MODE_DESCRIPTION: Record<OpponentMode, string> = {
  online: '접속 중인 상대와 자동 매칭',
  ai: '난이도와 진영을 골라 연습',
  local: '한 기기에서 흑·백을 번갈아',
};

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
  profileName,
  profileMeta,
}: {
  onSelect: (mode: OpponentMode) => void;
  onProfile: () => void;
  onTutorial: () => void;
  profileName: string;
  profileMeta: string;
}) {
  const [mode, setMode] = useState<OpponentMode>('online');

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
        </button>
      </div>

      <div className="ait-preview-wrap" aria-hidden="true">
        <PreviewBoard />
      </div>

      <section className="ait-home-dock" aria-label="대국 설정">
        <div className="ait-mode-tabs" role="group" aria-label="대국 방식">
          {(['online', 'ai', 'local'] as OpponentMode[]).map((option) => (
            <button
              key={option}
              type="button"
              className={mode === option ? 'is-active' : ''}
              aria-pressed={mode === option}
              onClick={() => setMode(option)}
            >
              {MODE_LABEL[option]}
            </button>
          ))}
        </div>
        <p className="ait-mode-description">{MODE_DESCRIPTION[mode]}</p>
        <button type="button" className="ait-home-start" onClick={() => onSelect(mode)}>
          대국 시작
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
}: {
  onBack: () => void;
  onRetry: () => void;
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
            {snap.onlineStatus || 'iPhone과 Android에서 접속 중인 상대를 찾습니다'}
          </Paragraph>
          {snap.profile && (
            <div className="ait-match-rating">
              {snap.profile.name} · Elo {snap.profile.rating} · {snap.profile.rank}위
            </div>
          )}
          {snap.onlineError && (
            <Button size="large" variant="weak" display="block" onClick={onRetry}>
              다시 찾기
            </Button>
          )}
        </>
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

function GameScreen({ onLeave }: { onLeave: () => void }) {
  const snap = useGameSnapshot();
  const boardRef = useRef<HTMLDivElement>(null);
  const isWhiteTurn = snap.state.turn === 'WHITE';
  const turnDetail = snap.turnLabel.includes(' · ')
    ? snap.turnLabel.split(' · ').slice(1).join(' · ')
    : null;
  const modeLabel = MODE_LABEL[snap.settings.mode];
  const chip =
    snap.settings.mode === 'ai'
      ? `${modeLabel} · ${AI_DIFFICULTY_PRESETS[snap.settings.aiDifficulty].label}`
      : snap.onlineOpponent
        ? `${snap.onlineOpponent.name}`
        : modeLabel;

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

  const leaveLabel = snap.settings.mode === 'online' ? '대국 종료' : '새 게임';

  return (
    <div className="ait-screen ait-game">
      <ScreenNav title={chip} onBack={onLeave} />

      <div className="ait-board-wrap">
        <div ref={boardRef} className="ait-board" />
      </div>

      <section className="ait-hud">
        {snap.resultLabel ? (
          <p className="ait-result">{snap.resultLabel}</p>
        ) : (
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
        )}
        {snap.onlineStatus && snap.settings.mode === 'online' && (
          <p className={`ait-online-note${snap.onlineError ? ' is-error' : ''}`}>{snap.onlineStatus}</p>
        )}
        <div className="ait-guard-trays">
          <GuardTray
            player="WHITE"
            count={snap.state.guardsInHand.WHITE}
            active={!snap.resultLabel && isWhiteTurn}
          />
          <GuardTray
            player="BLACK"
            count={snap.state.guardsInHand.BLACK}
            active={!snap.resultLabel && !isWhiteTurn}
          />
        </div>
      </section>

      <div className="ait-actions">
        <Button
          size="large"
          variant="weak"
          display="block"
          disabled={!snap.canUndo || snap.aiThinking}
          onClick={() => game.undo()}
        >
          무르기
        </Button>
        <Button
          size="large"
          display="block"
          disabled={snap.aiThinking && snap.settings.mode !== 'online'}
          onClick={() => {
            if (snap.settings.mode === 'online') onLeave();
            else game.reset();
          }}
        >
          {leaveLabel}
        </Button>
      </div>
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
            <strong>{snap.profile ? `${snap.profile.rank}위` : '—'}</strong>
            <small>
              {snap.profile
                ? `Elo ${snap.profile.rating} · ${snap.profile.wins}승 ${snap.profile.losses}패 · 승률 ${snap.profile.winRate}%`
                : '첫 온라인 대전에서 프로필이 만들어집니다'}
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
  const [step, setStep] = useState(0);
  const current = TUTORIAL_STEPS[step];
  const last = step === TUTORIAL_STEPS.length - 1;

  return (
    <div className="ait-screen">
      <ScreenNav title="튜토리얼" onBack={onBack} />
      <div className="ait-screen-body ait-tutorial-body">
        <div className="ait-tutorial-visual">
          <img src={current.image} alt={current.alt} />
          <span aria-hidden="true">{step + 1}</span>
        </div>
        <h3 className="ait-tutorial-title">{current.title}</h3>
        <p className="ait-tutorial-copy">{current.copy}</p>
        <div className="ait-tutorial-progress" aria-label="튜토리얼 진행">
          {TUTORIAL_STEPS.map((item, index) => (
            <span key={item.title} className={index === step ? 'is-active' : ''}>
              {index + 1}
            </span>
          ))}
        </div>
        <div className="ait-tutorial-actions">
          <Button
            size="large"
            variant="weak"
            display="block"
            disabled={step === 0}
            onClick={() => setStep((n) => Math.max(0, n - 1))}
          >
            이전
          </Button>
          <Button
            size="large"
            display="block"
            onClick={() => {
              if (last) onPractice();
              else setStep((n) => n + 1);
            }}
          >
            {last ? '연습 대국 시작' : '다음'}
          </Button>
        </div>
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
    if (snap.profile && !profileName) setProfileName(snap.profile.name);
  }, [snap.profile, profileName]);

  useEffect(() => {
    if (screen === 'match' && snap.onlineSide) setScreen('game');
  }, [screen, snap.onlineSide]);

  const leaveToMenu = () => {
    matchStarted.current = false;
    game.detachBoard();
    if (snap.onlineWaiting) game.cancelRandomMatch();
    game.setMode('local');
    setScreen('home');
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

  const startMatchmaking = () => {
    matchStarted.current = true;
    game.startRandomMatch();
  };

  useEffect(() => {
    if (screen !== 'match') return;
    if (matchStarted.current) return;
    startMatchmaking();
  }, [screen]);

  const profileLabel = snap.profile?.name ?? '나그네';
  const profileMeta = snap.profile
    ? `${snap.profile.rank}위 · Elo ${snap.profile.rating}`
    : '온라인 프로필 준비 중';

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
        />
      )}
      {screen === 'game' && <GameScreen onLeave={leaveToMenu} />}
      {screen === 'profile' && (
        <ProfileScreen
          profileName={profileName}
          onNameChange={setProfileName}
          onSave={() => game.updateProfileName(profileName)}
          onBack={() => setScreen('home')}
        />
      )}
      {screen === 'tutorial' && (
        <TutorialScreen onBack={() => setScreen('home')} onPractice={startAi} />
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
