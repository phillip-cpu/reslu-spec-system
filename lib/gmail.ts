/**
 * @deprecated This flat module has been superseded by lib/gmail/send.ts
 * (transport) + lib/gmail/digest.ts (queue + flush) — see lib/gmail/digest.ts
 * header for the Week 4 redesign rationale (queue-and-flush instead of
 * a synchronous send on every portal action). It could not be deleted
 * from this working copy (filesystem denied removal), so it is kept
 * as a thin re-export shim for any stale import path. New code should
 * import from "@/lib/gmail/send" / "@/lib/gmail/digest" directly.
 */
export { sendTeamEmail, isGmailConfigured } from "./gmail/send";
export type { SendResult } from "./gmail/send";
