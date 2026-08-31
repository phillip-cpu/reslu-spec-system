import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

assert.equal(
  process.env.RESLU_RUN_PRODUCTION_SESSION_ACCEPTANCE,
  "true",
  "Set RESLU_RUN_PRODUCTION_SESSION_ACCEPTANCE=true to run this production acceptance drill",
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(url && anonKey && serviceKey, "Required Supabase environment is missing");

const runId = randomUUID();
const email = `session-acceptance-${runId}@example.invalid`;
const password = `Acceptance-${randomUUID()}-9!`;
const currentEndpoint = `https://push.invalid/reslu-current-${runId}`;
const otherEndpoint = `https://push.invalid/reslu-other-${runId}`;
const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
let userId;

try {
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(createError);
  userId = created.user?.id;
  assert(userId, "Synthetic user was not created");

  const { error: profileError } = await admin.from("profiles").insert({
    id: userId,
    full_name: "Session acceptance",
    email,
    role: "viewer",
  });
  assert.ifError(profileError);

  const makeClient = () => createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const deviceA = makeClient();
  const deviceB = makeClient();
  const [{ data: a, error: aError }, { data: b, error: bError }] = await Promise.all([
    deviceA.auth.signInWithPassword({ email, password }),
    deviceB.auth.signInWithPassword({ email, password }),
  ]);
  assert.ifError(aError);
  assert.ifError(bError);
  assert(a.session && b.session, "Both device sessions must exist");

  const { error: insertError } = await admin.from("push_subscriptions").insert([
    {
      user_id: userId,
      endpoint: currentEndpoint,
      p256dh: "acceptance-current",
      auth: "acceptance-current",
    },
    {
      user_id: userId,
      endpoint: otherEndpoint,
      p256dh: "acceptance-other",
      auth: "acceptance-other",
    },
  ]);
  assert.ifError(insertError);

  const cookieJar = new Map();
  const serverClient = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const cookie of cookies) cookieJar.set(cookie.name, cookie.value);
      },
    },
  });
  const { error: setError } = await serverClient.auth.setSession(a.session);
  assert.ifError(setError);
  const cookie = [...cookieJar].map(([name, value]) => `${name}=${value}`).join("; ");
  assert(cookie, "Authenticated cookie was not produced");

  const response = await fetch("https://spec.reslu.com.au/api/me/sessions/revoke-others", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ current_push_endpoint: currentEndpoint }),
  });
  const responseBody = await response.json();
  assert.equal(response.status, 200, JSON.stringify(responseBody));
  assert.deepEqual(responseBody, {
    ok: true,
    current_session_retained: true,
    other_push_routes_removed: true,
  });

  const { error: refreshError } = await deviceB.auth.refreshSession(b.session);
  assert(refreshError, "Revoked device unexpectedly refreshed its session");
  const { data: routes, error: routesError } = await admin
    .from("push_subscriptions")
    .select("endpoint")
    .eq("user_id", userId)
    .order("endpoint");
  assert.ifError(routesError);
  assert.deepEqual(routes, [{ endpoint: currentEndpoint }]);

  console.log("PASS — another session cannot refresh and its push route is removed");
} finally {
  if (userId) {
    const { error: routeCleanupError } = await admin
      .from("push_subscriptions")
      .delete()
      .eq("user_id", userId);
    const { error: userCleanupError } = await admin.auth.admin.deleteUser(userId);
    assert.ifError(routeCleanupError);
    assert.ifError(userCleanupError);
  }
}
