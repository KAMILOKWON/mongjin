import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { PrimaryButton, Screen, ScreenNav } from '../components';
import { colors, spacing, typography } from '../theme';
import { useAppStore } from '../store';
import type { AiDifficulty, HumanColorChoice } from '../../../../packages/game-data/src';

const difficulties: Array<{ key: AiDifficulty; label: string; description: string }> = [
  { key: 'easy', label: '쉬움', description: '규칙에 맞는 기본 수를 차분히 둔다' },
  { key: 'normal', label: '보통', description: '초보 전술과 기본 수비를 읽는다' },
  { key: 'hard', label: '어려움', description: '최선 수를 깊게 읽어 빈틈을 놓치지 않는다' },
];

const colorsChoice: Array<{ key: HumanColorChoice; label: string }> = [
  { key: 'BLACK', label: '흑 · 선공' },
  { key: 'WHITE', label: '백 · 후공' },
  { key: 'random', label: '랜덤' },
];

export function SetupScreen() {
  const [difficulty, setDifficulty] = useState<AiDifficulty>('normal');
  const [color, setColor] = useState<HumanColorChoice>('BLACK');
  const openAI = useAppStore((state) => state.openAI);
  const goHome = useAppStore((state) => state.leaveGame);
  const current = difficulties.find((item) => item.key === difficulty)!;

  return (
    <Screen scroll={false}>
      <ScreenNav title="컴퓨터 대전" onBack={() => void goHome()} />
      <View style={{ flex: 1, paddingTop: 2 }}>
        <Text style={[typography.display, { color: colors.ink, fontSize: 24, marginBottom: 22 }]}>대국을 준비하세요</Text>

        <SetupField title="봇 난이도">
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {difficulties.map((item) => <Choice key={item.key} title={item.label} active={difficulty === item.key} onPress={() => setDifficulty(item.key)} />)}
          </View>
          <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 2 }}>{current.description}</Text>
        </SetupField>

        <SetupField title="내 색">
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {colorsChoice.map((item) => <Choice key={item.key} title={item.label} active={color === item.key} onPress={() => setColor(item.key)} />)}
          </View>
        </SetupField>

        <View style={{ flex: 1 }} />
        <PrimaryButton title="대국 시작" onPress={() => openAI(difficulty, color)} />
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
