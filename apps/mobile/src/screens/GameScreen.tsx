import { useEffect, useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, Text, View } from 'react-native';
import { Board, GuardTray, PrimaryButton, ScreenNav, SecondaryButton, PieceImage, styles } from '../components';
import { colors, typography } from '../theme';
import { format, type Dict } from '../i18n';
import { useT } from '../useT';
import { resultCopy, selectVisibleProfile, useAppStore } from '../store';
import type { SessionSnapshot } from '../game/engine';
import { showGameOverInterstitial } from '../ads';

function modeTitle(snapshot: SessionSnapshot, t: Dict): string {
  switch (snapshot.mode.kind) {
    case 'local': return t.localMode;
    case 'ai': return format(t.aiModeDiff, { difficulty: snapshot.mode.difficulty === 'easy' ? t.diffEasy : snapshot.mode.difficulty === 'normal' ? t.diffNormal : t.diffHard });
    case 'ghost': return snapshot.mode.tape.ownerName;
    case 'online': return snapshot.mode.matchKind === 'friend' ? t.friendMatch : snapshot.mode.opponentName;
    case 'tutorial': return t.tutorialMode;
  }
}

function resultTitle(snapshot: SessionSnapshot, t: Dict): string {
  if (!snapshot.result) return '';
  if (snapshot.mode.kind === 'local' || snapshot.mode.kind === 'ai' || snapshot.mode.kind === 'tutorial') return snapshot.result.winner === 'BLACK' ? t.blackWins : t.whiteWins;
  return snapshot.result.winner === snapshot.humanSide ? t.victory : t.defeat;
}

export function GameScreen() {
  const t = useT();
  const session = useAppStore((state) => state.session);
  const snapshot = useAppStore((state) => state.snapshot);
  const leave = useAppStore((state) => state.leaveGame);
  const profile = useAppStore((state) => state.profile);
  const onlineProfile = useAppStore((state) => state.onlineProfile);
  const [remaining, setRemaining] = useState(0);
  const [resultModalVisible, setResultModalVisible] = useState(true);
  const finishedGameExitStarted = useRef(false);

  useEffect(() => {
    const tick = () => setRemaining(snapshot?.moveDeadline ? Math.max(0, Math.ceil((snapshot.moveDeadline - Date.now()) / 1000)) : 0);
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [snapshot?.moveDeadline]);

  if (!session || !snapshot) return null;

  const online = snapshot.mode.kind === 'online';
  const quick = snapshot.mode.kind === 'ghost' || (snapshot.mode.kind === 'online' && snapshot.mode.matchKind !== 'friend');
  const hasSeats = snapshot.mode.kind === 'ghost' || online;
  const visibleProfile = selectVisibleProfile(profile, onlineProfile);
  const onBack = () => {
    if (snapshot.result) { void leave(); return; }
    if (quick) {
      Alert.alert(t.resignConfirmTitle, t.resignConfirmBody, [
        { text: t.cancel, style: 'cancel' },
        { text: t.resign, style: 'destructive', onPress: () => session.resign() },
      ]);
    } else {
      Alert.alert(t.exitConfirmTitle, t.exitConfirmBody, [
        { text: t.cancel, style: 'cancel' },
        { text: t.endGameAction, style: 'destructive', onPress: () => void leave() },
      ]);
    }
  };

  const actionTitle = snapshot.result ? t.exit : quick ? t.resign : t.endGameBtn;
  const showInterstitialThenLeave = async () => {
    if (finishedGameExitStarted.current) return;
    finishedGameExitStarted.current = true;
    await showGameOverInterstitial();
    await leave();
  };
  const leaveThenShowInterstitial = async () => {
    if (finishedGameExitStarted.current) return;
    finishedGameExitStarted.current = true;
    await leave();
    setTimeout(() => { void showGameOverInterstitial(); }, 0);
  };
  const leaveFinishedGame = () => {
    if (Platform.OS === 'ios') {
      setResultModalVisible(false);
      return;
    }
    void leaveThenShowInterstitial();
  };

  return (
    <View style={styles.screen}>
      <View style={{ paddingHorizontal: 16 }}>
        <ScreenNav title={quick ? t.quickMatch : modeTitle(snapshot, t)} onBack={onBack} right={quick && !snapshot.result ? <Pressable onPress={onBack} hitSlop={10}><Text style={{ color: colors.ink, fontSize: 20, fontWeight: '800' }}>•••</Text></Pressable> : null} />

        {hasSeats ? <SeatRow snapshot={snapshot} profileName={visibleProfile.name} profileRating={visibleProfile.rating} /> : null}

        <View style={{ marginVertical: 8 }}>
          <Board snapshot={snapshot} getHighlight={(coord) => session.highlights(coord)} onPress={(coord) => session.tap(coord)} />
        </View>

        <View style={{ alignItems: 'center', gap: 10, paddingHorizontal: 0 }}>
          {snapshot.result ? (
            <Text style={{ color: colors.blueStrong, fontSize: 16, fontWeight: '800', textAlign: 'center' }}>{resultTitle(snapshot, t)} · {resultCopy(snapshot.result, snapshot)}</Text>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: snapshot.state.turn === 'BLACK' ? colors.ink : colors.surface, borderWidth: 1, borderColor: colors.line }} />
              <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '800' }}>{snapshot.thinking ? (quick ? t.opponentThinking : t.aiThinking) : format(t.turnOf, { side: snapshot.state.turn === 'BLACK' ? t.black : t.white })}</Text>
            </View>
          )}

          <View style={{ flexDirection: 'row', gap: 10, width: '100%' }}>
            <View style={{ flex: 1 }}><GuardTray player="WHITE" label={t.whiteGuards} count={snapshot.state.guardsInHand.WHITE} active={!snapshot.result && snapshot.state.turn === 'WHITE'} /></View>
            <View style={{ flex: 1 }}><GuardTray player="BLACK" label={t.blackGuards} count={snapshot.state.guardsInHand.BLACK} active={!snapshot.result && snapshot.state.turn === 'BLACK'} /></View>
          </View>
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 10, padding: 16 }}>
        {quick ? <MoveClock remaining={remaining} /> : online ? <View style={{ flex: 1 }} /> : <View style={{ flex: 1 }}><SecondaryButton title={t.undo} onPress={() => session.undo()} disabled={!snapshot.canUndo} /></View>}
        <View style={{ flex: 1 }}><PrimaryButton title={actionTitle} onPress={onBack} /></View>
      </View>

      {snapshot.result ? <ResultModal snapshot={snapshot} visible={resultModalVisible} onConfirm={leaveFinishedGame} onDismiss={() => { void showInterstitialThenLeave(); }} /> : null}
    </View>
  );
}

function SeatRow({ snapshot, profileName, profileRating }: { snapshot: SessionSnapshot; profileName: string; profileRating: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
      <Seat player="WHITE" snapshot={snapshot} profileName={profileName} profileRating={profileRating} />
      <Seat player="BLACK" snapshot={snapshot} profileName={profileName} profileRating={profileRating} />
    </View>
  );
}

function Seat({ player, snapshot, profileName, profileRating }: { player: 'BLACK' | 'WHITE'; snapshot: SessionSnapshot; profileName: string; profileRating: number }) {
  const t = useT();
  const mine = snapshot.humanSide === player;
  const name = mine ? profileName : snapshot.mode.kind === 'ghost' ? snapshot.mode.tape.ownerName : snapshot.mode.kind === 'online' ? snapshot.mode.opponentName : t.opponentGeneric;
  const rating = mine ? profileRating : snapshot.mode.kind === 'ghost' ? snapshot.mode.tape.ownerRating : snapshot.mode.kind === 'online' ? snapshot.mode.opponentRating : null;
  const white = player === 'WHITE';
  const side = player === 'BLACK' ? t.black : t.white;
  const active = snapshot.result == null && snapshot.state.turn === player;
  const foreground = white ? colors.ink : colors.panel;
  return (
    <View style={[{ flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 58, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 14, backgroundColor: white ? colors.whiteTray : colors.blackTray, borderWidth: active ? 2 : 1, borderColor: active ? colors.blue : white ? '#DED9CF' : colors.blackTray }, active && { paddingHorizontal: 9, paddingVertical: 8 }]}>
      <PieceImage player={player} type="GUARD" size={30} />
      <View style={{ flex: 1, minWidth: 0, marginLeft: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: foreground, fontSize: 14, fontWeight: '600' }}>{name}</Text>
          {mine ? <Text style={{ color: foreground, fontSize: 10, fontWeight: '900', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 999, backgroundColor: white ? `${colors.blue}24` : '#FFFFFF29', overflow: 'hidden' }}>{t.me}</Text> : null}
        </View>
        <Text numberOfLines={1} style={{ color: white ? colors.inkSoft : '#D8E0E5', fontSize: 11, marginTop: 2 }}>{rating ? format(t.sideWithElo, { side, rating }) : side}</Text>
      </View>
    </View>
  );
}

function MoveClock({ remaining }: { remaining: number }) {
  const t = useT();
  const running = remaining > 0;
  const urgent = running && remaining <= 10;
  return (
    <View style={{ flex: 1, minHeight: 54, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: urgent ? `${colors.capture}8C` : colors.line }}>
      <Text style={{ color: urgent ? colors.capture : colors.ink, fontSize: 20, fontWeight: '900', fontVariant: ['tabular-nums'] }}>{running ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : '—:—'}</Text>
      <Text style={{ color: urgent ? colors.capture : colors.inkSoft, fontSize: 11, fontWeight: '600', marginTop: 2 }}>{running ? t.remainingTime : t.clockOpponentTurn}</Text>
    </View>
  );
}

function ResultModal({ snapshot, visible, onConfirm, onDismiss }: { snapshot: SessionSnapshot; visible: boolean; onConfirm: () => void; onDismiss: () => void }) {
  const t = useT();
  if (!snapshot.result) return null;
  return <Modal transparent animationType="fade" visible={visible} onRequestClose={onConfirm} onDismiss={onDismiss}><View style={{ flex: 1, backgroundColor: '#00000061', alignItems: 'center', justifyContent: 'center', padding: 32 }}><View style={{ width: '100%', maxWidth: 340, backgroundColor: colors.panel, borderRadius: 22, paddingHorizontal: 22, paddingTop: 26, paddingBottom: 20, ...styles.resultCard }}><Text style={[typography.display, { color: colors.ink, fontSize: 23, textAlign: 'center' }]}>{resultTitle(snapshot, t)}</Text><Text style={{ color: colors.inkSoft, fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 8 }}>{resultCopy(snapshot.result, snapshot)}</Text><View style={{ marginTop: 16 }}><PrimaryButton title={t.confirm} onPress={onConfirm} /></View></View></View></Modal>;
}
