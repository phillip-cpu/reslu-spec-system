export const CONVERSATION_SWIPE_BACK_EDGE_PX = 28;
export const CONVERSATION_SWIPE_BACK_COMMIT_PX = 72;
export const CONVERSATION_SWIPE_BACK_MAX_PREVIEW_PX = 112;

export function canStartConversationSwipeBack(clientX: number, pointerType: string, enabled: boolean) {
  return enabled && pointerType === "touch" && clientX >= 0 && clientX <= CONVERSATION_SWIPE_BACK_EDGE_PX;
}

export function conversationSwipeBackProgress(startX: number, startY: number, currentX: number, currentY: number) {
  const horizontal = Math.max(0, currentX - startX);
  const vertical = Math.abs(currentY - startY);
  const cancelled = vertical > 18 && vertical > horizontal * 0.8;
  return {
    cancelled,
    offset: cancelled ? 0 : Math.min(CONVERSATION_SWIPE_BACK_MAX_PREVIEW_PX, horizontal),
    committed: !cancelled && horizontal >= CONVERSATION_SWIPE_BACK_COMMIT_PX && horizontal > vertical * 1.25,
  };
}
