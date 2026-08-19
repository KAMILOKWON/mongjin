import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Screen, ScreenNav, SecondaryButton } from '../components';
import { colors, spacing, typography } from '../theme';
import { selectVisibleProfile, useAppStore } from '../store';

export function ProfileScreen() {
  const profile = useAppStore((state) => state.profile);
  const onlineProfile = useAppStore((state) => state.onlineProfile);
  const saveName = useAppStore((state) => state.saveName);
  const goHome = useAppStore((state) => state.leaveGame);
  const [name, setName] = useState(onlineProfile?.name ?? profile.name);
  const visible = selectVisibleProfile(profile, onlineProfile);
  return (
    <Screen>
      <ScreenNav title="내 프로필" onBack={() => void goHome()} />
      <View style={{ alignItems: 'center', backgroundColor: colors.blue + '12', borderRadius: 20, padding: 22, marginBottom: spacing.lg }}>
        <Text style={{ color: colors.inkSoft, fontSize: 13 }}>내 전적</Text>
        <Text style={[typography.display, { color: colors.ink, marginTop: 4 }]}>Elo {visible.rating}</Text>
        <Text style={{ color: colors.inkSoft, fontSize: 14, marginTop: 4 }}>{visible.wins}승 {visible.losses}패 · 승률 {visible.winRate}%</Text>
        {onlineProfile ? <Text style={{ color: colors.inkSoft, fontSize: 12, marginTop: 8 }}>온라인 순위 #{onlineProfile.rank} / {onlineProfile.totalPlayers}명</Text> : null}
      </View>
      <Text style={{ color: colors.inkSoft, fontSize: 13, fontWeight: '700', marginBottom: 8 }}>닉네임</Text>
      <TextInput value={name} onChangeText={setName} placeholder="2~12자" autoCapitalize="none" style={{ color: colors.ink, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, marginBottom: 12 }} />
      <SecondaryButton title="닉네임 저장" onPress={() => void saveName(name)} />
    </Screen>
  );
}
