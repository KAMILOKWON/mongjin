import { Text, View } from 'react-native';
import { Board, PrimaryButton, Screen, ScreenNav, SecondaryButton, styles } from '../components';
import { colors, spacing } from '../theme';
import { useT } from '../useT';
import { useAppStore } from '../store';

export function TutorialScreen() {
  const t = useT();
  const session = useAppStore((state) => state.session);
  const snapshot = useAppStore((state) => state.snapshot);
  const leave = useAppStore((state) => state.leaveGame);
  const practice = useAppStore((state) => state.openAI);
  if (!session || !snapshot) return null;
  const total = t.tutorialLessons.length;
  const finished = snapshot.tutorialFinished;
  const lesson = t.tutorialLessons[Math.min(snapshot.tutorialStep, total - 1)]!;
  return (
    <Screen scroll={false}>
      <ScreenNav title={t.tutorial} onBack={() => void leave()} />
      <View style={{ flex: 1 }}>
        {!finished ? (
          <Text style={{ color: colors.inkSoft, fontSize: 13, fontWeight: '700', textAlign: 'center' }}>
            <Text style={{ color: colors.blue, fontSize: 20, fontWeight: '800' }}>{snapshot.tutorialStep + 1}</Text>
            {' / '}
            {total}
          </Text>
        ) : null}
        <Text style={{ color: colors.ink, fontSize: 23, fontWeight: '800', textAlign: 'center', marginTop: 4 }}>
          {finished ? t.tutorialDoneTitle : lesson.title}
        </Text>
        <Text style={{ color: colors.inkSoft, fontSize: 15, fontWeight: '600', lineHeight: 24, textAlign: 'center', marginTop: 6, marginBottom: spacing.md }}>
          {finished ? t.tutorialDoneCoach : lesson.coach}
        </Text>

        <View style={{ flex: 1, justifyContent: 'center' }}><Board snapshot={snapshot} getHighlight={(coord) => session.highlights(coord)} onPress={(coord) => session.tap(coord)} tutorial /></View>

        {!finished ? (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 4 }} accessibilityLabel={`${snapshot.tutorialStep + 1} / ${total}`}>
              {Array.from({ length: total }, (_, index) => (
                <View key={index} style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 1, borderColor: index === snapshot.tutorialStep ? colors.blue : index < snapshot.tutorialStep ? `${colors.blue}61` : colors.line, backgroundColor: index === snapshot.tutorialStep ? colors.blue : index < snapshot.tutorialStep ? `${colors.blue}61` : colors.line }} />
              ))}
            </View>
            <View style={{ alignItems: 'center', gap: 3, paddingVertical: 11, paddingHorizontal: 14, marginTop: spacing.md, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.line, borderRadius: 14, backgroundColor: colors.surface }}>
              <Text style={{ color: colors.blue, fontSize: 11, fontWeight: '800' }}>{t.todoNow} ☝</Text>
              <Text style={{ color: colors.ink, fontSize: 14, fontWeight: '700', textAlign: 'center' }}>{snapshot.tutorialHintArmed ? lesson.hintArmed : lesson.hintIdle}</Text>
            </View>
          </>
        ) : (
          <View style={{ marginTop: spacing.md, paddingBottom: 8 }}>
            <PrimaryButton title={t.practiceWithAI} onPress={() => practice('easy', 'BLACK')} />
            <View style={{ height: 10 }} />
            <SecondaryButton title={t.goHome} onPress={() => void leave()} />
          </View>
        )}
      </View>
    </Screen>
  );
}
