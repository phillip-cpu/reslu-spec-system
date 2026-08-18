export const CONVERSATION_MESSAGE_LONG_PRESS_MS = 500;
export const CONVERSATION_MESSAGE_LONG_PRESS_MOVE_PX = 10;

type ConversationTimelineRow = {
  id: string;
  created_at: string;
};

export function mergeConversationTimelineMessages<T extends ConversationTimelineRow>(
  current: readonly T[],
  incoming: readonly T[],
) {
  const merged = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) merged.set(message.id, message);
  return [...merged.values()].sort((left, right) => (
    left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
  ));
}

export function preservedConversationScrollTop(
  previousTop: number,
  previousHeight: number,
  currentHeight: number,
) {
  return Math.max(0, previousTop + currentHeight - previousHeight);
}

export function conversationDayKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function conversationDayLabel(value: string, now = new Date()) {
  const date = new Date(value);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const difference = Math.round((start - target) / 86_400_000);
  if (difference === 0) return "Today";
  if (difference === 1) return "Yesterday";
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date);
}

export function conversationLongPressMoved(startX: number, startY: number, currentX: number, currentY: number) {
  return Math.hypot(currentX - startX, currentY - startY) > CONVERSATION_MESSAGE_LONG_PRESS_MOVE_PX;
}
