import { Component, type ErrorInfo, type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { TDSMobileAITProvider } from '@toss/tds-mobile-ait';
import {
  Button,
  ListRow,
  Paragraph,
  SegmentedControl,
  TextField,
  Top,
} from '@toss/tds-mobile';
import { GameController, PLAYER_KO, stoneHtml } from '../ui/gameController';
import type { HumanColorChoice, OpponentMode } from '../game/settings';
import '../ui/board.css';
import './ait.css';

const game = new GameController();

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

function HandRow({ player }: { player: 'BLACK' | 'WHITE' }) {
  const snap = useGameSnapshot();
  const n = snap.state.guardsInHand[player];
  return (
    <ListRow
      contents={
        <ListRow.Texts
          type="2RowTypeA"
          top={`${PLAYER_KO[player]} 호위`}
          bottom={`${n} / 8`}
        />
      }
      right={
        <span
          className="hand-stones"
          dangerouslySetInnerHTML={{ __html: stoneHtml(player, n) }}
        />
      }
      verticalPadding="small"
    />
  );
}

function MongjinApp() {
  const snap = useGameSnapshot();
  const boardRef = useRef<HTMLDivElement>(null);
  const [roomCode, setRoomCode] = useState('');

  useEffect(() => {
    game.init();
    return () => game.destroy();
  }, []);

  useEffect(() => {
    if (snap.onlineRoomId) setRoomCode(snap.onlineRoomId);
  }, [snap.onlineRoomId]);

  useLayoutEffect(() => {
    if (boardRef.current) game.attachBoard(boardRef.current);
  }, []);

  useEffect(() => {
    const onResize = () => game.refreshBoardLayout();
    window.addEventListener('resize', onResize);
    const wrap = boardRef.current?.parentElement;
    const ro =
      wrap && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(onResize)
        : null;
    if (wrap && ro) ro.observe(wrap);
    return () => {
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
    };
  }, []);

  return (
    <div className="ait-shell">
      <Top
        title={<Top.TitleParagraph size={22}>몽진</Top.TitleParagraph>}
        subtitleBottom={<Top.SubtitleParagraph>蒙塵 — 왕의 피난길</Top.SubtitleParagraph>}
      />

      <div className="ait-board-wrap">
        <div ref={boardRef} className="ait-board" />
      </div>

      <section className="ait-panel">
        {snap.resultLabel ? (
          <Paragraph typography="t4" fontWeight="bold" color="adaptive-grey-900">
            {snap.resultLabel}
          </Paragraph>
        ) : (
          <Paragraph typography="t4" fontWeight="semibold" color="adaptive-grey-800">
            {snap.turnLabel}
          </Paragraph>
        )}
        <HandRow player="BLACK" />
        <HandRow player="WHITE" />
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
          disabled={snap.aiThinking}
          onClick={() => game.reset()}
        >
          새 게임
        </Button>
      </div>

      <section className="ait-panel">
        <Paragraph typography="t6" fontWeight="semibold" color="adaptive-grey-600">
          대전 방식
        </Paragraph>
        <SegmentedControl
          alignment="fixed"
          value={snap.settings.mode}
          onChange={(value) => game.setMode(String(value) as OpponentMode)}
        >
          <SegmentedControl.Item value="ai">컴퓨터</SegmentedControl.Item>
          <SegmentedControl.Item value="local">같이 두기</SegmentedControl.Item>
          <SegmentedControl.Item value="online">온라인</SegmentedControl.Item>
        </SegmentedControl>

        {snap.settings.mode === 'ai' && (
          <>
            <Paragraph typography="t6" fontWeight="semibold" color="adaptive-grey-600">
              내 색
            </Paragraph>
            <SegmentedControl
              alignment="fixed"
              value={snap.settings.humanColor}
              onChange={(value) => game.setHumanColor(String(value) as HumanColorChoice)}
            >
              <SegmentedControl.Item value="BLACK">흑</SegmentedControl.Item>
              <SegmentedControl.Item value="WHITE">백</SegmentedControl.Item>
              <SegmentedControl.Item value="random">랜덤</SegmentedControl.Item>
            </SegmentedControl>
          </>
        )}

        {snap.settings.mode === 'online' && (
          <>
            <Button size="medium" display="block" onClick={() => game.createRoom()}>
              입장코드 생성
            </Button>
            <TextField
              variant="line"
              label="입장코드"
              labelOption="sustain"
              placeholder="6자리 코드"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
            />
            <Button
              size="medium"
              variant="weak"
              display="block"
              onClick={() => game.joinRoom(roomCode)}
            >
              참가
            </Button>
            {snap.onlineStatus && (
              <Paragraph
                typography="t7"
                color={snap.onlineError ? 'red500' : 'adaptive-grey-600'}
              >
                {snap.onlineStatus}
              </Paragraph>
            )}
          </>
        )}
      </section>
    </div>
  );
}

export function App() {
  return (
    <TDSMobileAITProvider brandPrimaryColor="#e0b35c">
      <ErrorBoundary>
        <MongjinApp />
      </ErrorBoundary>
    </TDSMobileAITProvider>
  );
}
