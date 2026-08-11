import { NextRequest, NextResponse } from "next/server";
import { sendPushToSubscription } from "@/lib/push";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PushJob = {
  id: string;
  message_id: string;
  recipient_profile_id: string;
  subscription_id: string;
  notification_id: string;
  status: "pending" | "processing" | "sent" | "skipped" | "failed";
  attempts: number;
};

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  const deliveryToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const body = await request.json().catch(() => null) as { job_id?: unknown } | null;
  if (!uuid(deliveryToken) || !uuid(body?.job_id)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const { data: rawJob, error: jobError } = await service
    .from("conversation_push_jobs")
    .select("id,message_id,recipient_profile_id,subscription_id,notification_id,status,attempts")
    .eq("id", body.job_id)
    .eq("delivery_token", deliveryToken)
    .maybeSingle();
  if (jobError) return NextResponse.json({ error: "Could not read push job" }, { status: 503 });
  const job = rawJob as PushJob | null;
  if (!job) return NextResponse.json({ error: "Push job not found" }, { status: 404 });
  if (job.status === "sent" || job.status === "skipped") {
    return NextResponse.json({ ok: true, status: job.status, idempotent: true });
  }
  if (job.status !== "processing") {
    return NextResponse.json({ error: "Push job is not claimed" }, { status: 409 });
  }

  const { data: message, error: messageError } = await service
    .from("conversation_messages")
    .select("conversation_id")
    .eq("id", job.message_id)
    .maybeSingle();
  if (messageError) return NextResponse.json({ error: "Could not verify push message" }, { status: 503 });
  const { data: participant, error: participantError } = message ? await service
    .from("conversation_participants")
    .select("conversation_id")
    .eq("conversation_id", message.conversation_id)
    .eq("profile_id", job.recipient_profile_id)
    .maybeSingle() : { data: null, error: null };
  if (participantError) return NextResponse.json({ error: "Could not verify push recipient" }, { status: 503 });
  if (!participant) {
    const completedAt = new Date().toISOString();
    const { error: notificationSkipError } = await service.from("notifications")
      .update({ read_at: completedAt })
      .eq("id", job.notification_id)
      .eq("user_id", job.recipient_profile_id);
    if (notificationSkipError) {
      return NextResponse.json({ error: "Could not retire removed recipient notification" }, { status: 503 });
    }
    const { error: jobSkipError } = await service.from("conversation_push_jobs").update({
      status: "skipped",
      completed_at: completedAt,
      last_error: "Recipient is no longer a conversation member",
    }).eq("id", job.id).eq("delivery_token", deliveryToken).eq("status", "processing");
    if (jobSkipError) return NextResponse.json({ error: "Could not skip push job" }, { status: 503 });
    return NextResponse.json({ ok: true, status: "skipped" });
  }

  const { data: notification, error: notificationError } = await service
    .from("notifications")
    .select("read_at")
    .eq("id", job.notification_id)
    .eq("user_id", job.recipient_profile_id)
    .maybeSingle();
  if (notificationError) return NextResponse.json({ error: "Could not verify push notification" }, { status: 503 });
  if (!notification || notification.read_at) {
    const { error: skippedReadError } = await service.from("conversation_push_jobs").update({
      status: "skipped",
      completed_at: new Date().toISOString(),
      last_error: notification ? "Notification was already read" : "Notification no longer exists",
    }).eq("id", job.id).eq("delivery_token", deliveryToken).eq("status", "processing");
    if (skippedReadError) return NextResponse.json({ error: "Could not skip push job" }, { status: 503 });
    return NextResponse.json({ ok: true, status: "skipped" });
  }

  const delivery = await sendPushToSubscription(
    job.recipient_profile_id,
    job.subscription_id,
    job.notification_id
  );
  if (!delivery.configured || delivery.failed > 0) {
    const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
    const lastError = !delivery.configured
      ? "Web push is not configured"
      : `All ${delivery.failed} push attempts failed`;
    const { error: failureUpdateError } = await service.from("conversation_push_jobs").update({
      status: "failed",
      next_attempt_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      last_error: lastError,
    }).eq("id", job.id).eq("delivery_token", deliveryToken).eq("status", "processing");
    if (failureUpdateError) return NextResponse.json({ error: "Could not reschedule push job" }, { status: 503 });
    return NextResponse.json({ error: lastError, delivery }, { status: 503 });
  }

  const status = delivery.delivered > 0 ? "sent" : "skipped";
  const { error: completionError } = await service.from("conversation_push_jobs").update({
    status,
    completed_at: new Date().toISOString(),
    last_error: delivery.attempted === 0 ? "No active push subscription" : null,
  }).eq("id", job.id).eq("delivery_token", deliveryToken).eq("status", "processing");
  if (completionError) return NextResponse.json({ error: "Could not complete push job" }, { status: 503 });
  return NextResponse.json({ ok: true, status, delivery });
}
