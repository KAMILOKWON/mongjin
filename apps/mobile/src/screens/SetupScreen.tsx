import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { PrimaryButton, Screen, ScreenNav } from '../components';
import { colors, spacing, typography } from '../theme';
import { useT } from '../useT';
import { useAppStore } from '../store';
import type { AiDifficulty, HumanColorChoice } from '../../../../packages/game-data/src';

export function SetupScreen() {
  const t = useT();
  const [difficulty, setDifficulty] = useState<AiDifficulty>('normal');
  const [color, setColor] = useState<HumanColorChoice>('BLACK');
  const openAI = useAppStore((state) => state.openAI);
  const goHome = useAppStore((state) => state.leaveGame);

  const difficulties: Array<{ key: AiDifficulty; label: string; description: string }> = [
    { key: 'easy', label: t.diffEasy, description: t.diffEasyDesc },
    { key: 'normal', label: t.diffNormal, description: t.diffNormalDesc },
    { key: 'hard', label: t.diffHard, description: t.diffHardDesc },
  ];
  const colorsChoice: Array<{ key: HumanColorChoice; label: string }> = [
    { key: 'BLACK', label: t.colorBlackFirst },
    { key: 'WHITE', label: t.colorWhiteSecond },
    { key: 'random', label: t.colorRandom },
  ];
  const current = difficulties.find((item) => item.key === difficulty)!;

  return (
    <Screen scroll={false}>
      <ScreenNav title={t.aiMatch} onBack={() => void goHome()} />
      <View style={{ flex: 1, paddingTop: 2 }}>
        <Text style={[typography.display, { color: colors.ink, fontSize: 24, marginBottom: 22 }]}>{t.setupHeading}</Text>

        <SetupField title={t.botDifficulty}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {difficulties.map((item) => <Choice key={item.key} title={item.label} active={difficulty === item.key} onPress={() => setDifficulty(item.key)} />)}
          </View>
          <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 2 }}>{current.description}</Text>
        </SetupField>

        <SetupField title={t.myColor}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {colorsChoice.map((item) => <Choice key={item.key} title={item.label} active={color === item.key} onPress={() => setColor(item.key)} />)}
          </View>
        </SetupField>

        <View style={{ flex: 1 }} />
        <PrimaryButton title={t.startGame} onPress={() => openAI(difficulty, color)} />
      </View>
    </Screen>
  );
}

function SetupField({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 22 }}>
      <Text style={[typography.title, { color: colors.inkSoft, fontSize: 13, marginBottom: 10 }]}>{title}</Text>
      {children}
    </View>
  );
}

function Choice({ title, active, onPress }: { title: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm, borderRadius: 22, borderWidth: 1, borderColor: active ? colors.blue : colors.line, backgroundColor: active ? colors.blue : colors.surface }, pressed && { opacity: 0.78 }]}>
      <Text style={{ color: active ? colors.panel : colors.ink, fontSize: 13, fontWeight: '500' }}>{title}</Text>
    </Pressable>
  );
}
