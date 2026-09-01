import { useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from './store';
import { colors } from './theme';
import { parseInviteUrl } from './links';
import { FriendScreen } from './screens/FriendScreen';
import { GameScreen } from './screens/GameScreen';
import { HomeScreen } from './screens/HomeScreen';
import { MatchScreen } from './screens/MatchScreen';
import { ProfileScreen } from './screens/ProfileScreen';
import { SetupScreen } from './screens/SetupScreen';
import { TutorialScreen } from './screens/TutorialScreen';
import { initializeAds } from './ads';

export default function AppShell() {
  return (
    <SafeAreaProvider>
      <AppShellBody />
    </SafeAreaProvider>
  );
}

function AppShellBody() {
  const [isReady, setIsReady] = useState(false);
  const route = useAppStore((state) => state.route);
  const toast = useAppStore((state) => state.toast);
  const hydrate = useAppStore((state) => state.hydrate);
  const insets = useSafeAreaInsets();
  const openInvite = useAppStore((state) => state.openInvite);
  const lastInvite = useRef<{ code: string; at: number } | null>(null);

  useEffect(() => {
    let mounted = true;

    void (async () => {
      try {
        await hydrate();
      } catch {
        // The store keeps its defaults when local storage is unavailable.
      } finally {
        if (mounted) setIsReady(true);
      }
    })();

    return () => { mounted = false; };
  }, [hydrate]);

  useEffect(() => {
    if (!isReady) return;
    let disposed = false;
    // A cold start can deliver the URL twice (initial URL + event); ignore
    // duplicates of the same code arriving within a few seconds.
    const handleUrl = (url: string | null) => {
      const code = parseInviteUrl(url);
      if (!code) return;
      const now = Date.now();
      if (lastInvite.current && lastInvite.current.code === code && now - lastInvite.current.at < 5000) return;
      lastInvite.current = { code, at: now };
      openInvite(code);
    };
    void Linking.getInitialURL()
      .then((url) => { if (!disposed) handleUrl(url); })
      .catch(() => undefined);
    const subscription = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => {
      disposed = true;
      subscription.remove();
    };
  }, [isReady, openInvite]);

  useEffect(() => {
    if (isReady) void initializeAds();
  }, [isReady]);

  if (!isReady) return <View style={styles.loadingRoot} />;

  return (
    <SafeAreaView style={[styles.root, { paddingBottom: insets.bottom }]} edges={['top', 'left', 'right']}>
      <StatusBar style="dark" />
      {route === 'home' ? <HomeScreen /> : null}
      {route === 'setup' ? <SetupScreen /> : null}
      {route === 'match' ? <MatchScreen /> : null}
      {route === 'friend' ? <FriendScreen /> : null}
      {route === 'profile' ? <ProfileScreen /> : null}
      {route === 'tutorial' ? <TutorialScreen /> : null}
      {route === 'game' ? <GameScreen /> : null}
      {toast ? <View pointerEvents="none" style={[styles.toast, { top: insets.top + 12 }]}><Text style={styles.toastText}>{toast}</Text></View> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loadingRoot: { flex: 1, backgroundColor: colors.panel },
  root: { flex: 1, backgroundColor: colors.panel },
  toast: { position: 'absolute', left: 24, right: 24, alignItems: 'center' },
  toastText: { color: colors.panel, backgroundColor: colors.ink, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10, fontSize: 14, fontWeight: '700' },
});
