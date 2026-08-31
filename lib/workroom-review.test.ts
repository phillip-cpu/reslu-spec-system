import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTaskArtifact } from "../types/conversations.ts";
import { approvalActionLabel, authorityRequest, authorityTimingIssue, inaccessibleAssets, reviewKind, reviewMediaIssue, reviewMediaPreviews, socialReviewPosts } from "./workroom-review.ts";

function artifact(content: Record<string, unknown>, kind: AgentTaskArtifact["kind"] = "report"): AgentTaskArtifact {
  return { id: "a", task_id: "t", artifact_key: "review", kind, title: "Review", content, status: "draft", created_at: "", updated_at: "" };
}

test("normalises the different live social pack shapes", () => {
  const value = artifact({ posts: [{ post_id: "p1", caption: "The caption", asset: { path: "/Users/marco/photo.jpg", crop: "4:5" }, alt_text: "Kitchen" }] });
  assert.equal(reviewKind(value), "social");
  assert.deepEqual(socialReviewPosts(value)[0], {
    id: "p1", title: "Post 01", caption: "The caption", altText: "Kitchen", schedule: null,
    assets: ["/Users/marco/photo.jpg"], crop: "4:5", credit: null,
  });
  assert.deepEqual(inaccessibleAssets(value), ["/Users/marco/photo.jpg"]);
});

test("separates content approval from exact execution authority", () => {
  const contentOnly = artifact({ posts: [{ caption: "Draft" }] });
  assert.equal(authorityRequest(contentOnly), null);
  assert.equal(approvalActionLabel(contentOnly, null), "Approve content pack");

  const execution = artifact({ authority_request: { tool_name: "send_aria_email", tool_args: { to: "client@example.com" } }, subject: "Hello" }, "email_draft");
  assert.equal(authorityRequest(execution)?.tool_name, "send_aria_email");
  assert.equal(approvalActionLabel(execution, {
    tool_name: "send_aria_email", owner: "Aria", purpose: "Send email", risk_tier: "R2",
    approval_rule: "exact-owner", verification_kind: "provider_readback", rollback_kind: "manual-recovery",
  }), "Send email");
});

test("blocks stale or over-broad execution windows before a decision", () => {
  const now = Date.parse("2026-08-31T10:00:00Z");
  const withExpiry = (expires_at: string) => artifact({
    subject: "Hello",
    authority_request: { tool_name: "send_aria_email", tool_args: { to: "client@example.com" }, expires_at },
  }, "email_draft");

  assert.match(authorityTimingIssue(withExpiry("2026-08-31T09:59:00Z"), now) ?? "", /expired/);
  assert.match(authorityTimingIssue(withExpiry("2026-09-02T10:00:00Z"), now) ?? "", /24-hour/);
  assert.equal(authorityTimingIssue(withExpiry("2026-08-31T10:30:00Z"), now), null);
});

test("hash-bound review media resolves local asset names to authenticated previews", () => {
  const value = artifact({
    posts: [{ assets: ["VDK_0063.jpg"], caption: "Caption" }],
    asset_manifest: [{ file: "VDK_0063.jpg", sha256: "a".repeat(64) }],
    workroom_review_media: [{
      asset_key: "VDK_0063.jpg",
      source_sha256: "a".repeat(64),
      url: "/api/workroom/media/media-1",
    }],
  });
  assert.deepEqual(socialReviewPosts(value)[0]?.assets, ["/api/workroom/media/media-1"]);
  assert.deepEqual(inaccessibleAssets(value), []);
});

test("review media with a different source hash stays blocked", () => {
  const value = artifact({
    posts: [{ assets: ["VDK_0063.jpg"], caption: "Caption" }],
    asset_manifest: [{ file: "VDK_0063.jpg", sha256: "a".repeat(64) }],
    workroom_review_media: [{
      asset_key: "VDK_0063.jpg",
      source_sha256: "b".repeat(64),
      url: "/api/workroom/media/media-1",
    }],
  });
  assert.deepEqual(inaccessibleAssets(value), ["VDK_0063.jpg"]);
});

test("automatic review media sources bind private previews to the declared hash", () => {
  const value = artifact({
    posts: [{ assets: ["Kitchen hero"], caption: "Caption" }],
    review_media_sources: [{ asset_key: "Kitchen hero", path: "/Users/marco/kitchen.jpg", sha256: "c".repeat(64) }],
    workroom_review_media: [{
      asset_key: "Kitchen hero",
      source_sha256: "c".repeat(64),
      url: "/api/workroom/media/media-2",
    }],
  });
  assert.deepEqual(socialReviewPosts(value)[0]?.assets, ["/api/workroom/media/media-2"]);
  assert.deepEqual(inaccessibleAssets(value), []);
});

test("automatic ingestion faults remain visible to the decision surface", () => {
  const value = artifact({ review_media_error: "Review image hash changed: kitchen.jpg" });
  assert.equal(reviewMediaIssue(value), "Review image hash changed: kitchen.jpg");
});

test("non-social review packs expose their verified preview gallery", () => {
  const value = artifact({
    review_media_sources: [{ asset_key: "Marked-up plan", path: "/Users/aria/plan.png", sha256: "d".repeat(64) }],
    workroom_review_media: [{ asset_key: "Marked-up plan", source_sha256: "d".repeat(64), url: "/api/workroom/media/media-3" }],
  }, "file");
  assert.deepEqual(reviewMediaPreviews(value), [{ assetKey: "Marked-up plan", url: "/api/workroom/media/media-3" }]);
});
