/** App-owned inbox; provider inboxes and outbound customer support are separate. */
export interface InboxMessage {
  id: string;
  kind: 'notice' | 'tournament' | 'achievement';
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  tournamentId: string | null;
}
export interface InboxResponse {
  messages: InboxMessage[];
  unreadCount: number;
}
export interface PlayerAchievement {
  id: string;
  title: string;
  tournamentId: string;
  earnedAt: string;
}
export interface NotificationPreferences {
  tournamentReminders: boolean;
}
export interface PracticeReceipt {
  saved: true;
  completed: boolean;
  completedCount: number;
}
