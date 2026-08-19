import { useState } from 'react';
import { Share, Text, TextInput, View } from 'react-native';
import { PrimaryButton, Screen, ScreenNav, SecondaryButton } from '../components';
import { colors, spacing, typography } from '../theme';
import { useAppStore } from '../store';

export function FriendScreen() {
  const friendRoomId = useAppStore((state) => state.friendRoomId);
  const friendStatus = useAppStore((state) => state.friendStatus);
  const createFriendRoom = useAppStore((state) => state.createFriendRoom);
  const joinFriendRoom = useAppStore((state) => state.joinFriendRoom);
  const cancelFriend = useAppStore((state) => state.cancelFriend);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const share = () => {
    if (!friendRoomId) return;
    void Share.share({ message: `몽진 친구 대전 초대! 입장코드: ${friendRoomId}` }).catch(() => undefined);
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
      <ScreenNav title="친구 대전" onBack={cancelFriend} />

      {friendRoomId ? (
        <View style={{ alignItems: 'center', backgroundColor: colors.blue + '12', borderRadius: 20, padding: 22, marginBottom: spacing.lg }}>
          <Text style={{ color: colors.inkSoft, fontSize: 13 }}>입장코드</Text>
          <Text style={[typography.display, { color: colors.ink, marginTop: 4, letterSpacing: 8 }]}>{friendRoomId}</Text>
          <Text style={{ color: colors.inkSoft, fontSize: 14, marginTop: 8 }}>{friendStatus || '상대를 기다리는 중'}</Text>
          <View style={{ alignSelf: 'stretch', marginTop: 16 }}>
            <SecondaryButton title="코드 공유" onPress={share} />
          </View>
        </View>
      ) : (
        <View>
          <Text style={{ color: colors.inkSoft, fontSize: 14, lineHeight: 20, marginBottom: spacing.lg }}>
            친구에게 입장코드를 보내거나, 받은 코드로 입장하세요.
          </Text>
          <PrimaryButton title="입장코드 생성" onPress={() => void create()} disabled={busy} />

          <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: spacing.lg }}>
            <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
            <Text style={{ color: colors.inkSoft, fontSize: 12, marginHorizontal: 10 }}>또는</Text>
            <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
          </View>

          <Text style={{ color: colors.inkSoft, fontSize: 13, fontWeight: '700', marginBottom: 8 }}>입장코드</Text>
          <TextInput
            value={code}
            onChangeText={(text) => setCode(text.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            placeholder="6자리 코드"
            placeholderTextColor={colors.inkSoft}
            maxLength={6}
            autoCapitalize="characters"
            autoCorrect={false}
            style={{ color: colors.ink, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 12, fontSize: 18, fontWeight: '700', letterSpacing: 4, textAlign: 'center', marginBottom: 12 }}
          />
          <SecondaryButton title="코드로 참가" onPress={() => void join()} disabled={busy || code.trim().length !== 6} />
          {friendStatus ? <Text style={{ color: colors.inkSoft, fontSize: 13, textAlign: 'center', marginTop: spacing.md }}>{friendStatus}</Text> : null}
        </View>
      )}
    </Screen>
  );
}
