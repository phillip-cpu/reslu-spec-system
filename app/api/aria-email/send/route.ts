import { NextRequest, NextResponse } from "next/server";
import { validateAriaEmailInput } from "@/lib/aria-email";
import { getUserRole } from "@/lib/auth";
import { sendTeamEmail } from "@/lib/gmail/send";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const actor = await getUserRole(supabase);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (actor.email !== "aria@reslu.com.au" && actor.role !== "admin") {
    return NextResponse.json({ error: "Only Aria or an admin may use the Aria mailbox" }, { status: 403 });
  }

  let email;
  try {
    email = validateAriaEmailInput(await request.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid email" }, { status: 400 });
  }

  try {
    const result = await sendTeamEmail({ to: [email.to], cc: email.cc, subject: email.subject, body: email.body });
    if (result.skipped || !result.provider_message_id) {
      return NextResponse.json({ error: result.reason ?? "Email transport unavailable" }, { status: 503 });
    }
    return NextResponse.json({
      status: "sent",
      sender: "aria@reslu.com.au",
      to: email.to,
      cc: email.cc,
      subject: email.subject,
      provider_id: result.provider_message_id,
      provider_message_id: result.provider_message_id,
      provider_thread_id: result.provider_thread_id ?? null,
      sent_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Email send failed" }, { status: 502 });
  }
}
