import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Screen, ScreenNav } from '../components';
import { colors, typography } from '../theme';
import { useT } from '../useT';
import { useAppStore } from '../store';

export function MatchScreen() {
  const t = useT();
  const status = useAppStore((state) => state.matchStatus);
  const name = useAppStore((state) => state.matchFoundName);
  const cancel = useAppStore((state) => state.cancelMatch);

  return (
    <Screen scroll={false}>
      <ScreenNav title={t.quickMatch} onBack={cancel} />
      <View pointerEvents="box-none" style={styles.centerOverlay}>
        <MatchPulse label={t.searchingShort} />
        <Text style={[typography.display, { color: colors.ink, fontSize: 27, textAlign: 'center', marginTop: 18 }]}>{name ? t.matched : t.searchingShort}</Text>
        {status ? <Text accessibilityLiveRegion="polite" style={{ color: colors.inkSoft, fontSize: 13, textAlign: 'center', marginTop: 8 }}>{status}</Text> : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centerOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
});

function MatchPulse({ label }: { label: string }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setPhase((value) => (value + 1) % 3), 360);
    return () => clearInterval(timer);
  }, []);

  return (
    <View accessibilityLabel={label} style={{ flexDirection: 'row', gap: 8 }}>
      {[0, 1, 2].map((index) => <View key={index} style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: colors.blue, opacity: phase === index ? 1 : 0.25, transform: [{ scale: phase === index ? 1 : 0.85 }] }} />)}
    </View>
  );
}
