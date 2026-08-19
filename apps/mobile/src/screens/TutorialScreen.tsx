import { Text, View } from 'react-native';
import { Board, PrimaryButton, Screen, ScreenNav, SecondaryButton, styles } from '../components';
import { colors, spacing, typography } from '../theme';
import { useAppStore } from '../store';

export function TutorialScreen() {
  const session = useAppStore((state) => state.session);
  const snapshot = useAppStore((state) => state.snapshot);
  const leave = useAppStore((state) => state.leaveGame);
  const practice = useAppStore((state) => state.openAI);
  if (!session || !snapshot) return null;
  return (
    <Screen scroll={false}>
      <ScreenNav title="튜토리얼" onBack={() => void leave()} />
      <View style={{ backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 16, paddingVertical: 12, marginBottom: spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline' }}><Text style={[typography.title, { color: colors.ink, flex: 1 }]}>{snapshot.tutorialTitle}</Text><Text style={{ color: colors.inkSoft, fontSize: 13 }}>{Math.min(snapshot.tutorialStep + 1, 5)} / 5</Text></View>
        <Text style={{ color: colors.inkSoft, fontSize: 14, lineHeight: 20, marginTop: 6 }}>{snapshot.tutorialCoach}</Text>
      </View>
      <View style={{ flex: 1, justifyContent: 'center' }}><Board snapshot={snapshot} getHighlight={(coord) => session.highlights(coord)} onPress={(coord) => session.tap(coord)} tutorial /></View>
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, marginVertical: 12 }}>{Array.from({ length: 5 }, (_, index) => <View key={index} style={{ width: index === snapshot.tutorialStep ? 18 : 7, height: 7, borderRadius: 5, backgroundColor: index <= snapshot.tutorialStep ? colors.blue : colors.line }} />)}</View>
      {snapshot.tutorialFinished ? <View style={{ paddingBottom: 8 }}><Text style={{ color: colors.ink, fontSize: 16, fontWeight: '800', textAlign: 'center', marginBottom: 8 }}>규칙을 모두 익혔어요</Text><Text style={{ color: colors.inkSoft, fontSize: 14, textAlign: 'center', marginBottom: 12 }}>{snapshot.tutorialCoach}</Text><PrimaryButton title="컴퓨터로 연습하기" onPress={() => practice('easy', 'BLACK')} /><View style={{ height: 8 }} /><SecondaryButton title="홈으로" onPress={() => void leave()} /></View> : <View style={{ flexDirection: 'row', alignItems: 'flex-start', backgroundColor: colors.surface, borderRadius: 18, borderWidth: 1, borderColor: colors.line, padding: 14 }}><Text style={{ color: colors.blue, fontSize: 22, marginRight: 10 }}>☝</Text><View style={{ flex: 1 }}><Text style={{ color: colors.inkSoft, fontSize: 12 }}>지금 할 일</Text><Text style={{ color: colors.ink, fontSize: 17, fontWeight: '800', marginTop: 3 }}>{snapshot.tutorialHint}</Text></View></View>}
    </Screen>
  );
}
