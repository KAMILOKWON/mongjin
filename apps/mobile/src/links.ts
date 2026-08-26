export const DISCORD_URL = 'https://discord.gg/Et9ntxdgA';

const INVITE_PATTERN = /^mongjin:\/\/join\/([A-Z0-9]{6})\b/i;

export function inviteUrl(code: string): string {
  return `mongjin://join/${code.toUpperCase()}`;
}

export function parseInviteUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = INVITE_PATTERN.exec(url.trim());
  return match ? match[1]!.toUpperCase() : null;
}
