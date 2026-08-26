import { useState } from 'react';
import { Share, Text, TextInput, View } from 'react-native';
import { PrimaryButton, Screen, ScreenNav, SecondaryButton } from '../components';
import { colors, spacing, typography } from '../theme';
import { format } from '../i18n';
import { useT } from '../useT';
import { useAppStore } from '../store';
import { inviteUrl } from '../links';

export function FriendScreen() {
  const t = useT();
  const friendRoomId = useAppStore((state) => state.friendRoomId);
  const friendStatus = useAppStore((state) => state.friendStatus);
  const createFriendRoom = useAppStore((state) => state.createFriendRoom);
  const joinFriendRoom = useAppStore((state) => state.joinFriendRoom);
  const cancelFriend = useAppStore((state) => state.cancelFriend);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const share = () => {
    if (!friendRoomId) return;
    void Share.share({ message: format(t.inviteShareMessage, { code: friendRoomId, link: inviteUrl(friendRoomId) }) }).catch(() => undefined);
  };

  const create = async () => {
    setBusy(true);
    try { await createFriendRoom(); } finally { setBusy(false); }
  };

  const join = async () => {
    setBusy(true);
    try { await joinFriendRoom(code); } finally { setBusy(false); }
  };

  return (
    <Screen>
      <ScreenNav title={t.friendMatch} onBack={cancelFriend} />

      {friendRoomId ? (
        <View style={{ alignItems: 'center', backgroundColor: colors.blue + '12', borderRadius: 20, padding: 22, marginBottom: spacing.lg }}>
          <Text style={{ color: colors.inkSoft, fontSize: 13 }}>{t.entryCode}</Text>
          <Text style={[typography.display, { color: colors.ink, marginTop: 4, letterSpacing: 8 }]}>{friendRoomId}</Text>
          <Text style={{ color: colors.inkSoft, fontSize: 14, marginTop: 8 }}>{friendStatus || t.friendWaiting}</Text>
          <View style={{ alignSelf: 'stretch', marginTop: 16 }}>
            <SecondaryButton title={t.codeShareBtn} onPress={share} />
          </View>
        </View>
      ) : (
        <View>
          <Text style={{ color: colors.inkSoft, fontSize: 14, lineHeight: 20, marginBottom: spacing.lg }}>
            {t.friendIntro}
          </Text>
          <PrimaryButton title={t.createCode} onPress={() => void create()} disabled={busy} />

          <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: spacing.lg }}>
            <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
            <Text style={{ color: colors.inkSoft, fontSize: 12, marginHorizontal: 10 }}>{t.or}</Text>
            <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
          </View>

          <Text style={{ color: colors.inkSoft, fontSize: 13, fontWeight: '700', marginBottom: 8 }}>{t.entryCode}</Text>
          <TextInput
            value={code}
            onChangeText={(text) => setCode(text.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            placeholder={t.codePlaceholder}
            placeholderTextColor={colors.inkSoft}
            maxLength={6}
            autoCapitalize="characters"
            autoCorrect={false}
            style={{ color: colors.ink, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 12, fontSize: 18, fontWeight: '700', letterSpacing: 4, textAlign: 'center', marginBottom: 12 }}
          />
          <SecondaryButton title={t.joinWithCode} onPress={() => void join()} disabled={busy || code.trim().length !== 6} />
          {friendStatus ? <Text style={{ color: colors.inkSoft, fontSize: 13, textAlign: 'center', marginTop: spacing.md }}>{friendStatus}</Text> : null}
        </View>
      )}
    </Screen>
  );
}
