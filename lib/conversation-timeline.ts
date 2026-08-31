export const CONVERSATION_MESSAGE_LONG_PRESS_MS = 500;
export const CONVERSATION_MESSAGE_LONG_PRESS_MOVE_PX = 10;

type ConversationTimelineRow = {
  id: string;
  created_at: string;
};

function sameConversationValue<T>(left: T, right: T) {
  if (Object.is(left, right)) return true;
  // Conversation API payloads are bounded JSON snapshots with deterministic
  // field ordering. Comparing only the incoming page is substantially cheaper
  // than forcing React to reconcile an accumulated multi-thousand-row thread
  // every time an unchanged polling response arrives.
  return JSON.stringify(left) === JSON.stringify(right);
}

export function preserveEqualConversationCollection<T>(
  current: T[],
  incoming: readonly T[],
) {
  if (current.length !== incoming.length) return [...incoming];
  for (let index = 0; index < current.length; index += 1) {
    if (!sameConversationValue(current[index], incoming[index])) return [...incoming];
  }
  return current;
}

export function mergeConversationTimelineMessages<T extends ConversationTimelineRow>(
  current: T[],
  incoming: readonly T[],
) {
  const merged = new Map(current.map((message) => [message.id, message]));
  let changed = false;
  for (const message of incoming) {
    const existing = merged.get(message.id);
    if (!existing) {
      changed = true;
      merged.set(message.id, message);
    } else if (!sameConversationValue(existing, message)) {
      changed = true;
      merged.set(message.id, message);
    }
  }
  if (!changed) return current;
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
