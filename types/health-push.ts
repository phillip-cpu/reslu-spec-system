// ============================================================
// RESLU Spec System — Health + web push (r26)
// TS shapes for migration 053_health_push.sql's five tables, plus the
// small request/response bodies the health/*, push/*, and
// notifications/* routes use. Kept in its own file per this codebase's
// established "new round -> its own types/round-*.ts" convention (see
// types/round-supplier-invoice-intake.ts, types/proposals.ts) rather
// than touching the protected types/index.ts.
// ============================================================

export interface HealthHeartbeat {
  id: string;
  uptime: string | null;
  disk_free_gb: number | null;
  mem_free_gb: number | null;
  openclaw_up: boolean | null;
  pending_updates: number | null;
  extra: Record<string, unknown>;
  created_at: string;
}

export type HealthChannelStatus = "ok" | "degraded" | "down";

export interface HealthChannel {
  id: string;
  channel: string;
  label: string | null;
  status: HealthChannelStatus;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  session_valid: boolean | null;
  note: string | null;
  updated_at: string;
}

export type HealthDiagnosticStatus = "pending" | "running" | "done" | "failed";

export interface HealthDiagnostic {
  id: string;
  requested_by: string | null;
  requested_at: string;
  status: HealthDiagnosticStatus;
  report: string | null;
  completed_at: string | null;
}

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

/** Shape the browser's PushSubscription.toJSON() gives us — what POST /api/push/subscribe accepts. */
export interface PushSubscriptionJsonInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface NotificationRow {
  id: string;
  user_id: string | null;
  kind: string;
  title: string;
  body: string | null;
  link_href: string | null;
  created_at: string;
  read_at: string | null;
}

/** GET /api/notifications/latest-unread response — the shape public/sw.js's push handler reads. */
export interface LatestUnreadNotificationResponse {
  notification: {
    id: string;
    title: string;
    body: string | null;
    link_href: string | null;
  } | null;
}

/** Three-colour pill status shared by every Health page pill — see lib/health-status.ts. */
export type HealthPillLevel = "green" | "amber" | "red";

/** Derived, display-ready shape for the Health page's Spec card — see lib/health.ts's computeSpecHealth(). */
export interface SpecHealthSummary {
  crons: {
    key: string;
    label: string;
    last_success_at: string | null;
    level: HealthPillLevel;
  }[];
  failed_email_sends_7d: number;
  aria_queue_stuck: number;
  needs_aria_backlog: number;
}

export interface CreateDiagnosticResponse {
  diagnostic: HealthDiagnostic;
}

export interface PendingDiagnosticsResponse {
  diagnostics: HealthDiagnostic[];
}

export interface CompleteDiagnosticInput {
  status: "done" | "failed";
  report: string;
}
