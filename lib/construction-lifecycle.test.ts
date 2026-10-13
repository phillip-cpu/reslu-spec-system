import test from "node:test";
import assert from "node:assert/strict";
import { localConstructionLifecycleEnabled } from "./construction-lifecycle.ts";
test("local lifecycle requires explicit flag, non-production build and loopback Supabase endpoint",()=>{
  const e={NODE_ENV:"test",RESLU_CONSTRUCTION_LOCAL_TEST:"1",NEXT_PUBLIC_SUPABASE_URL:"http://127.0.0.1:54321"};
  assert.equal(localConstructionLifecycleEnabled(e),true);
  for(const patch of [{NODE_ENV:"production"},{RESLU_CONSTRUCTION_LOCAL_TEST:"0"},{NEXT_PUBLIC_SUPABASE_URL:"https://example.supabase.co"},{NEXT_PUBLIC_SUPABASE_URL:"http://localhost.attacker.test"},{NEXT_PUBLIC_SUPABASE_URL:""}])assert.equal(localConstructionLifecycleEnabled({...e,...patch}),false);
});
