/** DTOs shared by the API server and the web client. */

export type ChatType = "private" | "group";
export type DeliveryMode = "gentle" | "now";
export type BotKind = "weather" | "rates" | "wiki";

export interface QuietHoursDto {
  enabled: boolean;
  /** Minutes since local midnight, 0..1439 */
  start: number;
  end: number;
  timeZone: string;
}

export interface Me {
  id: number;
  username: string;
  displayName: string;
  bio: string;
  avatarHue: number;
  /** Shared public demo account: profile and sessions are read-only. */
  isDemo: boolean;
  quiet: QuietHoursDto;
  showLocalTime: boolean;
  /** Messages addressed to me that are being held until my quiet hours end. */
  heldCount: number;
  heldUntil: number | null;
}

export interface UserPublic {
  id: number;
  username: string;
  displayName: string;
  bio: string;
  avatarHue: number;
  isBot: boolean;
  online: boolean;
  lastSeenAt: number | null;
  /** Present only when the user allows showing their local time. */
  timeZone: string | null;
  /** Quiet-hours status relevant for a sender (null for bots / disabled). */
  quiet: PeerQuietStatus | null;
}

export interface PeerQuietStatus {
  /** Whether the person is inside their quiet hours right now. */
  active: boolean;
  /** UTC ms when the current quiet window ends (null if not active). */
  endsAt: number | null;
  /** The window itself is shared only if the person shares their local time. */
  start: number | null;
  end: number | null;
}

export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface MessageDto {
  id: number;
  chatId: number;
  senderId: number;
  senderName: string;
  senderHue: number;
  text: string;
  createdAt: number;
  editedAt: number | null;
  /** Only visible to the sender: the message is held until this UTC ms (quiet hours). */
  deliverAt: number | null;
  replyTo: { id: number; senderName: string; text: string } | null;
  reactions: Reaction[];
  /** Bot reply keyboard. */
  buttons: string[] | null;
}

export interface ChatSummary {
  id: number;
  type: ChatType;
  title: string;
  /** For private chats: the other person (or me for "Saved Messages"). */
  peer: UserPublic | null;
  isSaved: boolean;
  avatarHue: number;
  memberCount: number;
  lastMessage: MessageDto | null;
  unreadCount: number;
  pinned: boolean;
  muted: boolean;
  /** Latest moment any other member has read up to (for ✓✓). */
  peerReadAt: number;
  myReadAt: number;
}

export interface ChatDetail extends ChatSummary {
  members: UserPublic[];
}

export interface MessagesPage {
  messages: MessageDto[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface SessionDto {
  id: number;
  userAgent: string;
  createdAt: number;
  lastActiveAt: number;
  current: boolean;
}

export type ServerEvent =
  | { type: "message.new"; message: MessageDto }
  | { type: "message.updated"; message: MessageDto }
  | { type: "message.deleted"; chatId: number; messageId: number }
  | { type: "chat.read"; chatId: number; userId: number; readAt: number }
  | { type: "chat.new"; chatId: number }
  | { type: "typing"; chatId: number; userId: number; name: string }
  | { type: "presence"; userId: number; online: boolean; lastSeenAt: number | null }
  | { type: "me.updated" };
