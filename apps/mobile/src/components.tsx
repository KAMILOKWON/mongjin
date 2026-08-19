import { useMemo, type ReactNode } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { Coord, Piece, Player } from '../../../packages/game-core/src';
import type { SessionSnapshot } from './game/engine';
import { colors, shadow, spacing, typography } from './theme';

const stoneImages = {
  BLACK: {
    KING: require('../../../assets/ui/stone-black-king.png'),
    GUARD: require('../../../assets/ui/stone-black-guard.png'),
  },
  WHITE: {
    KING: require('../../../assets/ui/stone-white-king.png'),
    GUARD: require('../../../assets/ui/stone-white-guard.png'),
  },
} as const;

const boardTexture = require('../../../assets/ui/board-light-ash.png');

export function PieceImage({ piece, player, type, ghostly = false, size }: { piece?: Piece | null; player?: Player; type?: Piece['type']; ghostly?: boolean; size?: number }) {
  const actualPlayer = player ?? piece?.player ?? 'BLACK';
  const actualType = type ?? piece?.type ?? 'GUARD';
  return <Image source={stoneImages[actualPlayer][actualType]} resizeMode="contain" style={[styles.piece, size != null && { width: size, height: size }, ghostly && styles.ghostPiece]} />;
}

export function PrimaryButton({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, disabled && styles.disabled]}>
      <Text style={styles.primaryText}>{title}</Text>
    </Pressable>
  );
}

export function SecondaryButton({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, disabled && styles.disabled]}>
      <Text style={styles.secondaryText}>{title}</Text>
    </Pressable>
  );
}

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const body = <View style={styles.screenBody}>{children}</View>;
  return scroll ? <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} bounces>{body}</ScrollView> : <View style={styles.screen}>{body}</View>;
}

export function ScreenNav({ title, onBack, right }: { title: string; onBack: () => void; right?: React.ReactNode }) {
  return (
    <View style={styles.nav}>
      <Pressable onPress={onBack} hitSlop={12} style={styles.navSide}><Text style={styles.back}>‹</Text></Pressable>
      <Text style={styles.navTitle}>{title}</Text>
      <View style={styles.navRight}>{right}</View>
    </View>
  );
}

export function ChoicePill({ title, active, onPress, description }: { title: string; active: boolean; onPress: () => void; description?: string }) {
  return (
    <Pressable onPress={onPress} style={[styles.choice, active && styles.choiceActive]}>
      <Text style={[styles.choiceTitle, active && styles.choiceTitleActive]}>{title}</Text>
      {description ? <Text style={[styles.choiceDescription, active && styles.choiceDescriptionActive]}>{description}</Text> : null}
    </Pressable>
  );
}

export function Board({ snapshot, getHighlight, onPress, tutorial = false }: { snapshot: SessionSnapshot; getHighlight: (coord: Coord) => ReturnType<import('./game/engine').GameSession['highlights']>; onPress: (coord: Coord) => void; tutorial?: boolean }) {
  const { width } = useWindowDimensions();
  const boardSize = Math.min(Math.max(width - 32, 260), 390);
  const rows = useMemo(() => Array.from({ length: 9 }, (_, r) => r), []);
  return (
    <View style={[styles.board, { width: boardSize, height: boardSize }]}> 
      <Image source={boardTexture} resizeMode="cover" style={styles.boardTexture} />
      <View pointerEvents="none" style={styles.boardTint} />
      <View style={styles.boardInner}>
        {rows.map((r) => (
          <View key={r} style={styles.boardRow}>
            {rows.map((c) => {
              const coord = { r, c };
              const mark = snapshot.mode.kind === 'tutorial' && snapshot.tutorialFinished
                ? { isGoalBlack: r === 0 && c >= 3 && c <= 5, isGoalWhite: r === 8 && c >= 3 && c <= 5, isSelected: false, isLastMove: false, isTarget: false, isPlace: false, isCapture: false, isHint: false }
                : getHighlight(coord);
              const piece = snapshot.state.board[r]?.[c] ?? null;
              return (
                <Pressable
                  key={`${r}-${c}`}
                  onPress={() => onPress(coord)}
                  style={[styles.cell, mark?.isGoalBlack && styles.goalBlack, mark?.isGoalWhite && styles.goalWhite, mark?.isLastMove && styles.lastMove, mark?.isSelected && styles.selected, mark?.isTarget && styles.target, mark?.isPlace && styles.placeHint, mark?.isCapture && styles.capture]}
                >
                  {piece ? <PieceImage piece={piece} ghostly={snapshot.mode.kind === 'ghost' && piece.player === snapshot.mode.tape.side} /> : null}
                  {r === 0 && c === 0 ? <Text style={styles.rankLabel}>9</Text> : null}
                  {c === 0 && r > 0 ? <Text style={styles.rankLabel}>{9 - r}</Text> : null}
                  {r === 8 ? <Text style={styles.fileLabel}>{'abcdefghi'[c]}</Text> : null}
                  {mark?.isHint ? <View style={styles.hintDot} /> : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
      <View pointerEvents="none" style={styles.boardFrame} />
    </View>
  );
}

export function GuardTray({ player, count, active }: { player: Player; count: number; active: boolean }) {
  return (
    <View style={[styles.tray, player === 'WHITE' ? styles.whiteTray : styles.blackTray, active && styles.activeTray]}>
      <View style={styles.trayHeader}><Text style={[styles.trayLabel, player === 'BLACK' && styles.trayOnDark]}>{player === 'BLACK' ? '흑' : '백'} 호위</Text><Text style={[styles.trayCount, player === 'BLACK' && styles.trayOnDark]}>{count} / 8</Text></View>
      <View style={styles.trayGrid}>{Array.from({ length: 8 }, (_, index) => <View key={index} style={styles.traySlot}>{index < count ? <PieceImage player={player} type="GUARD" /> : null}</View>)}</View>
    </View>
  );
}

export function PreviewBoard() {
  const rows = useMemo(() => Array.from({ length: 9 }, (_, index) => index), []);
  return (
    <View style={styles.previewBoard}>
      <Image source={boardTexture} resizeMode="cover" style={styles.boardTexture} />
      <View pointerEvents="none" style={styles.boardTint} />
      <View style={styles.previewGrid}>
        {rows.map((r) => (
          <View key={r} style={styles.previewRow}>
            {rows.map((c) => {
              const goal = (r === 0 || r === 8) && c >= 3 && c <= 5;
              return (
                <View key={c} style={[styles.previewCell, goal && styles.previewGoal]}>
                  {r === 8 && c === 4 ? <PieceImage player="BLACK" type="KING" /> : null}
                  {r === 0 && c === 4 ? <PieceImage player="WHITE" type="KING" /> : null}
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.panel },
  screenBody: { flex: 1, width: '100%', paddingHorizontal: spacing.xl, paddingTop: 24, paddingBottom: 28 },
  scrollContent: { flexGrow: 1 },
  nav: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  back: { color: colors.ink, fontSize: 32, fontWeight: '300', lineHeight: 38 },
  navSide: { width: 32 },
  navTitle: { flex: 1, textAlign: 'center', color: colors.ink, fontSize: 18, fontWeight: '800' },
  navRight: { width: 32, alignItems: 'flex-end' },
  primaryButton: { minHeight: 54, borderRadius: 16, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
  primaryText: { color: colors.panel, fontSize: 17, fontWeight: '800' },
  secondaryButton: { minHeight: 52, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
  secondaryText: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  pressed: { opacity: 0.78 },
  disabled: { opacity: 0.45 },
  choice: { borderWidth: 1, borderColor: colors.line, borderRadius: 14, backgroundColor: colors.surface, padding: spacing.md, marginBottom: spacing.sm },
  choiceActive: { borderColor: colors.blue, backgroundColor: '#EEF4F8' },
  choiceTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  choiceTitleActive: { color: colors.blueStrong },
  choiceDescription: { color: colors.inkSoft, fontSize: 12, marginTop: 4, lineHeight: 17 },
  choiceDescriptionActive: { color: colors.blueStrong },
  board: { alignSelf: 'center', backgroundColor: colors.wood, borderRadius: 13, padding: 8, overflow: 'hidden', ...shadow },
  boardTexture: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, opacity: 0.55 },
  boardTint: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.wood, opacity: 0.55 },
  boardInner: { flex: 1 },
  boardRow: { flex: 1, flexDirection: 'row' },
  boardFrame: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 13, borderWidth: 1, borderColor: colors.woodEdge },
  cell: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderColor: `${colors.woodEdge}B8`, backgroundColor: `${colors.panel}4D`, alignItems: 'center', justifyContent: 'center' },
  goalBlack: { backgroundColor: '#8CAFCB55' },
  goalWhite: { backgroundColor: '#FFFFFF88' },
  lastMove: { backgroundColor: '#A9C8DC88' },
  selected: { borderWidth: 2, borderColor: colors.blue },
  target: { backgroundColor: '#8FB9D077' },
  placeHint: { backgroundColor: '#8FB9D055' },
  capture: { backgroundColor: `${colors.capture}66` },
  hintDot: { position: 'absolute', width: 10, height: 10, borderRadius: 5, backgroundColor: colors.blue, opacity: 0.8 },
  piece: { width: '82%', height: '82%' },
  ghostPiece: { opacity: 0.72 },
  rankLabel: { position: 'absolute', top: 2, left: 3, color: `${colors.ink}99`, fontSize: 8, fontWeight: '800' },
  fileLabel: { position: 'absolute', right: 3, bottom: 1, color: `${colors.ink}99`, fontSize: 8, fontWeight: '800' },
  tray: { borderRadius: 14, paddingHorizontal: 10, paddingTop: 9, paddingBottom: 10, ...shadow },
  whiteTray: { backgroundColor: colors.whiteTray },
  blackTray: { backgroundColor: colors.blackTray },
  activeTray: { borderWidth: 2, borderColor: colors.blue },
  trayHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 7 },
  trayLabel: { color: colors.ink, fontSize: 11, fontWeight: '900' },
  trayCount: { color: colors.inkSoft, fontSize: 11, fontWeight: '800' },
  trayOnDark: { color: colors.panel },
  trayGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -2, marginBottom: -2 },
  traySlot: { width: '25%', aspectRatio: 1, paddingHorizontal: 2, paddingBottom: 4, alignItems: 'center', justifyContent: 'center' },
  previewBoard: { width: '100%', aspectRatio: 1, padding: 8, backgroundColor: colors.wood, borderRadius: 12, overflow: 'hidden', ...shadow },
  previewGrid: { flex: 1 },
  previewRow: { flex: 1, flexDirection: 'row' },
  previewCell: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderColor: `${colors.woodEdge}88`, alignItems: 'center', justifyContent: 'center' },
  previewGoal: { backgroundColor: '#8CAFCB44' },
  resultCard: shadow,
});
