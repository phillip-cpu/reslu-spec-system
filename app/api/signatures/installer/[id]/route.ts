import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSignaturePersonById, renderInstallerScript } from "@/lib/email-signatures";

export const runtime = "nodejs";

/**
 * GET /api/signatures/installer/[id] — downloads install-signature-<id>.sh
 * for one person (BUILD-SPEC.md "Email signatures page (r22)" item 1/3).
 *
 * Nested under a literal "installer" segment deliberately: app/api/
 * signatures/[id]/route.ts already exists for the unrelated NATIVE
 * E-SIGNATURE feature (document signing on client-portal contracts —
 * see lib/email-signatures.ts's header comment for the full
 * cross-reference). "installer" as a static folder is matched before
 * the sibling [id] dynamic segment, so this route and that one don't
 * collide, but a future reader should know both live under
 * /api/signatures/ for two different reasons.
 *
 * Authenticated, all team members (no admin gate) — BUILD-SPEC.md item
 * 5: "visible to all users, no secrets". [id] is a people.json id
 * (phillip/tenille/tony/nathan/accounts), not a DB row id.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const person = getSignaturePersonById(id);
  if (!person) {
    return NextResponse.json({ error: "Unknown signature id" }, { status: 404 });
  }

  const script = renderInstallerScript(person);

  return new NextResponse(script, {
    status: 200,
    headers: {
      "Content-Type": "application/x-sh",
      "Content-Disposition": `attachment; filename="install-signature-${person.id}.sh"`,
      "Cache-Control": "no-store",
    },
  });
}
