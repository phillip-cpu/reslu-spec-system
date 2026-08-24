export type ReplyRoutingEmail = {
  id: string;
  from_addr: string;
  subject: string | null;
  received_at?: string | null;
};

export type LeadIntroductionEmail = ReplyRoutingEmail & {
  clean_text?: string | null;
};

export function buildEmailReplyQueueItem(
  email: ReplyRoutingEmail,
  replyRequested: boolean
) {
  if (!replyRequested) return null;

  return {
    kind: "email_reply_requested" as const,
    dedupe_key: `email_reply_requested:${email.id}`,
    source: "second-brain-triage",
    payload: {
      source_email_id: email.id,
      from_addr: email.from_addr,
      subject: email.subject,
      received_at: email.received_at ?? null,
    },
  };
}

export function buildLeadIntroductionQueueItem(
  email: LeadIntroductionEmail,
  leadIntroduction: boolean
) {
  if (!leadIntroduction) return null;

  return {
    kind: "lead_introduction" as const,
    dedupe_key: `lead_introduction:${email.id}`,
    source: "second-brain-triage",
    payload: {
      source_email_id: email.id,
      from_addr: email.from_addr,
      subject: email.subject,
      received_at: email.received_at ?? null,
    },
  };
}
