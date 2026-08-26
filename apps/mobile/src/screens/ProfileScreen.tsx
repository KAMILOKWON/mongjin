import { useState } from 'react';
import { Linking, Pressable, Text, TextInput, View } from 'react-native';
import { Screen, ScreenNav, SecondaryButton } from '../components';
import { colors, spacing, typography } from '../theme';
import { format, LANG_OPTIONS, type Lang } from '../i18n';
import { useT } from '../useT';
import { selectVisibleProfile, useAppStore } from '../store';
import { DISCORD_URL } from '../links';

export function ProfileScreen() {
  const t = useT();
  const lang = useAppStore((state) => state.lang);
  const setLang = useAppStore((state) => state.setLang);
  const profile = useAppStore((state) => state.profile);
  const onlineProfile = useAppStore((state) => state.onlineProfile);
  const saveName = useAppStore((state) => state.saveName);
  const goHome = useAppStore((state) => state.leaveGame);
  const [name, setName] = useState(onlineProfile?.name ?? profile.name);
  const visible = selectVisibleProfile(profile, onlineProfile);
  return (
    <Screen>
      <ScreenNav title={t.myProfile} onBack={() => void goHome()} />
      <View style={{ alignItems: 'center', backgroundColor: colors.blue + '12', borderRadius: 20, padding: 22, marginBottom: spacing.lg }}>
        <Text style={{ color: colors.inkSoft, fontSize: 13 }}>{t.myRecord}</Text>
        <Text style={[typography.display, { color: colors.ink, marginTop: 4 }]}>Elo {visible.rating}</Text>
        <Text style={{ color: colors.inkSoft, fontSize: 14, marginTop: 4 }}>{format(t.recordLine, { wins: visible.wins, losses: visible.losses, rate: visible.winRate })}</Text>
        {onlineProfile ? <Text style={{ color: colors.inkSoft, fontSize: 12, marginTop: 8 }}>{format(t.onlineRankLine, { rank: onlineProfile.rank, total: onlineProfile.totalPlayers })}</Text> : null}
      </View>
      <Text style={{ color: colors.inkSoft, fontSize: 13, fontWeight: '700', marginBottom: 8 }}>{t.nickname}</Text>
      <TextInput value={name} onChangeText={setName} placeholder={t.nicknamePlaceholder} autoCapitalize="none" style={{ color: colors.ink, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, marginBottom: 12 }} />
      <SecondaryButton title={t.saveNickname} onPress={() => void saveName(name)} />

      <Text style={{ color: colors.inkSoft, fontSize: 13, fontWeight: '700', marginTop: spacing.lg, marginBottom: 10 }}>{t.language}</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {LANG_OPTIONS.map((option) => (
          <Pressable
            key={option.value}
            onPress={() => setLang(option.value as Lang)}
            style={({ pressed }) => [{ flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 22, borderWidth: 1, borderColor: lang === option.value ? colors.blue : colors.line, backgroundColor: lang === option.value ? colors.blue : colors.surface }, pressed && { opacity: 0.78 }]}
          >
            <Text style={{ color: lang === option.value ? colors.panel : colors.ink, fontSize: 13, fontWeight: '700' }}>{option.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={{ marginTop: spacing.lg }}>
        <SecondaryButton title={t.discordCommunity} onPress={() => { void Linking.openURL(DISCORD_URL).catch(() => undefined); }} />
      </View>
    </Screen>
  );
}
