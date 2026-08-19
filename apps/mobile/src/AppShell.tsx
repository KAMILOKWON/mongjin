import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from './store';
import { colors } from './theme';
import { FriendScreen } from './screens/FriendScreen';
import { GameScreen } from './screens/GameScreen';
import { HomeScreen } from './screens/HomeScreen';
import { MatchScreen } from './screens/MatchScreen';
import { ProfileScreen } from './screens/ProfileScreen';
import { SetupScreen } from './screens/SetupScreen';
import { TutorialScreen } from './screens/TutorialScreen';

export default function AppShell() {
  return (
    <SafeAreaProvider>
      <AppShellBody />
    </SafeAreaProvider>
  );
}

function AppShellBody() {
  const route = useAppStore((state) => state.route);
  const toast = useAppStore((state) => state.toast);
  const hydrate = useAppStore((state) => state.hydrate);
  const insets = useSafeAreaInsets();
  useEffect(() => { void hydrate(); }, [hydrate]);

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
      {toast ? <View pointerEvents="none" style={styles.toast}><Text style={styles.toastText}>{toast}</Text></View> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.panel },
  toast: { position: 'absolute', top: 12, left: 24, right: 24, alignItems: 'center' },
  toastText: { color: colors.panel, backgroundColor: colors.ink, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10, fontSize: 14, fontWeight: '700' },
});
