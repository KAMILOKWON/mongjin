import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { PreviewBoard, PrimaryButton, Screen, styles } from '../components';
import { colors, spacing, typography } from '../theme';
import { selectVisibleProfile, useAppStore } from '../store';
import { format } from '../i18n';
import { useT } from '../useT';
import { HomeBannerAd } from '../ads';

type HomeTab = 'quick' | 'friend' | 'ai' | 'local';

export function HomeScreen() {
  const [tab, setTab] = useState<HomeTab>('quick');
  const t = useT();
  const profile = useAppStore((state) => state.profile);
  const onlineProfile = useAppStore((state) => state.onlineProfile);
  const openProfile = useAppStore((state) => state.openProfile);
  const openAISetup = useAppStore((state) => state.openAISetup);
  const openLocal = useAppStore((state) => state.openLocal);
  const openTutorial = useAppStore((state) => state.openTutorial);
  const openFriend = useAppStore((state) => state.openFriend);
  const startQuickMatch = useAppStore((state) => state.startQuickMatch);

  const tabs: Array<{ key: HomeTab; label: string; blurb: string; cta: string }> = [
    { key: 'quick', label: t.homeTabQuick, blurb: t.homeQuickBlurb, cta: t.homeQuickCta },
    { key: 'friend', label: t.homeTabFriend, blurb: t.homeFriendBlurb, cta: t.homeFriendCta },
    { key: 'ai', label: t.homeTabAI, blurb: t.homeAIBlurb, cta: t.homeAICta },
    { key: 'local', label: t.homeTabLocal, blurb: t.homeLocalBlurb, cta: t.homeLocalCta },
  ];
  const current = tabs.find((item) => item.key === tab)!;
  const visibleProfile = selectVisibleProfile(profile, onlineProfile);

  const onSelectTab = (key: HomeTab) => setTab(key);

  const onPressCta = () => {
    if (tab === 'quick') void startQuickMatch();
    else if (tab === 'friend') openFriend();
    else if (tab === 'ai') openAISetup();
    else openLocal();
  };

  return (
    <View style={styles.screen}>
      <Screen>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm, paddingTop: 4 }}>
          <Text style={[typography.display, { color: colors.ink }]}>{t.appTitle}</Text>
          <Pressable onPress={openProfile} style={{ marginLeft: 'auto', alignItems: 'flex-end', backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 6 }}>
            <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '800' }}>{visibleProfile.name}</Text>
            <Text style={{ color: colors.inkSoft, fontSize: 11, marginTop: 2 }}>{format(t.eloWinsShort, { rating: visibleProfile.rating, wins: visibleProfile.wins })}</Text>
          </Pressable>
        </View>

        <View style={{ marginHorizontal: 6, marginTop: 0, marginBottom: 10 }}>
          <PreviewBoard />
        </View>

        <View style={{ flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 24, borderWidth: 1, borderColor: colors.line, padding: 4, marginBottom: 8 }}>
          {tabs.map((item) => <Pressable key={item.key} onPress={() => onSelectTab(item.key)} style={{ flex: 1, paddingVertical: 8, borderRadius: 20, alignItems: 'center', backgroundColor: tab === item.key ? colors.blue : 'transparent' }}><Text style={{ color: tab === item.key ? colors.panel : colors.inkSoft, fontSize: 13, fontWeight: '700' }}>{item.label}</Text></Pressable>)}
        </View>
        <Text style={{ color: colors.inkSoft, textAlign: 'center', fontSize: 13, marginBottom: 8 }}>{current.blurb}</Text>
        <PrimaryButton title={current.cta} onPress={onPressCta} />
        <Pressable onPress={openTutorial} style={{ alignItems: 'center', paddingVertical: 10 }}><Text style={{ color: colors.blue, fontSize: 15, fontWeight: '700' }}>{t.tutorial}</Text></Pressable>
      </Screen>
      <HomeBannerAd />
    </View>
  );
}
