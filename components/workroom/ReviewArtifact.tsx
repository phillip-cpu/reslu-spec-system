"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import clsx from "clsx";
import type { AgentTaskArtifact } from "@/types/conversations";
import type { WorkroomApprovalPolicy } from "@/types/workroom";
import {
  approvalBoundary,
  authorityRequest,
  isWebAsset,
  reviewKind,
  socialReviewPosts,
} from "@/lib/workroom-review";

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortFile(value: string) {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

function ReadableValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value == null || value === "") return <span className="text-charcoal/45">Not supplied</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value);
    if (/^https?:\/\//i.test(text)) return <a href={text} target="_blank" rel="noreferrer" className="break-all underline decoration-sand underline-offset-4 hover:decoration-nearblack">{text}</a>;
    return <span className="whitespace-pre-wrap break-words">{text}</span>;
  }
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-charcoal/45">None</span>;
    return <ul className="space-y-2">{value.map((item, index) => <li key={index} className="grid grid-cols-[12px_minmax(0,1fr)] gap-2"><span aria-hidden className="text-sand">·</span><ReadableValue value={item} depth={depth + 1} /></li>)}</ul>;
  }
  if (typeof value === "object") {
    return <dl className={clsx("divide-y divide-[#e6dfcf]", depth === 0 && "border-y border-[#e6dfcf]")}>{Object.entries(value as Record<string, unknown>).map(([key, item]) => (
      <div key={key} className="grid gap-1 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-5">
        <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#76634f]">{label(key)}</dt>
        <dd className="min-w-0 text-[14px] leading-6 text-charcoal"><ReadableValue value={item} depth={depth + 1} /></dd>
      </div>
    ))}</dl>;
  }
  return null;
}

function AssetPreview({ value, alt }: { value: string; alt: string }) {
  if (!isWebAsset(value)) {
    return <div className="flex aspect-[4/3] flex-col justify-end bg-[#e9e1d3] p-4">
      <span aria-hidden className="mb-auto font-display text-[38px] text-[#a08c72]/55">□</span>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#76634f]">Preview unavailable</p>
      <p className="mt-1 truncate text-[12px] text-charcoal/65">{shortFile(value)}</p>
    </div>;
  }
  return <a href={value} target="_blank" rel="noreferrer" className="group relative block aspect-[4/3] overflow-hidden bg-[#e9e1d3]" aria-label={`Open ${alt}`}><Image src={value} alt={alt} fill sizes="(max-width: 768px) 88vw, 520px" unoptimized className="object-cover transition-transform duration-300 group-hover:scale-[1.015]" /><span className="absolute bottom-3 right-3 bg-nearblack/85 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-white">Open image</span></a>;
}

function SocialReview({ artifact }: { artifact: AgentTaskArtifact }) {
  const posts = useMemo(() => socialReviewPosts(artifact), [artifact]);
  const [active, setActive] = useState(0);
  const post = posts[Math.min(active, Math.max(0, posts.length - 1))];
  if (!post) return <p className="text-[14px] text-charcoal/65">No posts were supplied in this review pack.</p>;
  return <div>
    <div className="flex gap-1 overflow-x-auto border-b border-[#d8d2c6] pb-3" role="tablist" aria-label="Posts in this approval pack">
      {posts.map((item, index) => <button key={item.id} type="button" role="tab" aria-selected={active === index} onClick={() => setActive(index)} className={clsx("min-h-11 shrink-0 border-b-2 px-3 text-[12px] font-semibold transition-colors", active === index ? "border-nearblack text-nearblack" : "border-transparent text-charcoal/55 hover:text-nearblack")}>{String(index + 1).padStart(2, "0")}</button>)}
    </div>
    <article className="pt-5">
      <div className="flex items-start justify-between gap-5"><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#76634f]">{post.title}</p>{post.schedule && <p className="mt-2 text-[13px] text-charcoal/60">Planned for {post.schedule}</p>}</div>{post.crop && <span className="border border-[#cbbda7] px-2 py-1 text-[10px] uppercase tracking-wider text-charcoal/60">Crop {post.crop}</span>}</div>
      {post.assets.length > 0 ? <div className="mt-5 grid gap-2 sm:grid-cols-2">{post.assets.map((asset, index) => <AssetPreview key={`${asset}-${index}`} value={asset} alt={post.altText ?? `${post.title} image ${index + 1}`} />)}</div> : <div className="mt-5 border border-amber-300 bg-amber-50 px-4 py-4 text-[13px] text-amber-950">No image has been attached to this post.</div>}
      <section className="mt-6"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#76634f]">Caption</p><p className="mt-3 whitespace-pre-wrap text-[16px] leading-7 text-nearblack">{post.caption}</p></section>
      {post.altText && <section className="mt-5 border-l border-[#a08c72] pl-4"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#76634f]">Alt text</p><p className="mt-2 text-[13px] leading-6 text-charcoal/70">{post.altText}</p></section>}
      {post.credit && <p className="mt-5 text-[12px] text-charcoal/60">Credit · {post.credit}</p>}
    </article>
  </div>;
}

function EmailReview({ artifact }: { artifact: AgentTaskArtifact }) {
  const content = artifact.content ?? {};
  const request = authorityRequest(artifact);
  const args = request?.tool_args ?? {};
  const field = (key: string) => content[key] ?? args[key];
  return <div>
    <dl className="border-y border-[#d8d2c6] text-[13px]">
      {["from", "to", "cc", "subject"].map((key) => <div key={key} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 border-b border-[#e6dfcf] py-3 last:border-b-0"><dt className="font-semibold uppercase tracking-[0.12em] text-[#76634f]">{key}</dt><dd className="min-w-0 break-words text-nearblack"><ReadableValue value={field(key) ?? (key === "from" ? "RESLU <aria@reslu.com.au>" : null)} /></dd></div>)}
    </dl>
    <section className="mt-6"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#76634f]">Message</p><div className="mt-3 whitespace-pre-wrap text-[16px] leading-7 text-nearblack"><ReadableValue value={field("body") ?? field("message") ?? field("text")} /></div></section>
  </div>;
}

function GeneralReview({ artifact }: { artifact: AgentTaskArtifact }) {
  const entries = Object.fromEntries(Object.entries(artifact.content ?? {}).filter(([key]) => key !== "authority_request"));
  return <ReadableValue value={entries} />;
}

export function ReviewArtifact({ artifact, policy }: { artifact: AgentTaskArtifact; policy: WorkroomApprovalPolicy | null }) {
  const kind = reviewKind(artifact);
  const request = authorityRequest(artifact);
  return <section className="workroom-paper overflow-hidden border border-[#d8d2c6] bg-[#faf6ec]">
    <header className="relative border-b border-[#d8d2c6] px-5 py-5 sm:px-7">
      <div className="flex items-start justify-between gap-5"><div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#76634f]">Review pack</p><h3 className="mt-2 font-display text-[26px] font-light leading-tight text-nearblack">{artifact.title}</h3></div><span className="shrink-0 bg-[#e7dfd1] px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-charcoal/65">{kind}</span></div>
    </header>
    <div className="relative px-5 py-6 sm:px-7 sm:py-7">
      {kind === "social" ? <SocialReview artifact={artifact} /> : kind === "email" ? <EmailReview artifact={artifact} /> : <GeneralReview artifact={artifact} />}
    </div>
    <footer className={clsx("relative border-t px-5 py-4 sm:px-7", request && !policy ? "border-red-200 bg-red-50" : "border-[#d8d2c6] bg-[#f3ecdf]")}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#76634f]">Approval boundary</p>
      <p className="mt-2 text-[13px] leading-6 text-charcoal/75">{approvalBoundary(artifact, policy)}</p>
      {request && <details open className="mt-4 border-t border-[#d8d2c6] pt-4"><summary className="min-h-11 cursor-pointer text-[11px] font-semibold uppercase tracking-[0.13em] text-[#76634f]">Exact action and inputs</summary><dl className="grid gap-3 text-[12px] sm:grid-cols-2"><div><dt className="font-semibold text-charcoal/55">Action</dt><dd className="mt-1 break-words text-nearblack">{request.tool_name}</dd></div><div><dt className="font-semibold text-charcoal/55">Target</dt><dd className="mt-1 break-words text-nearblack">{[request.target_type, request.target_id].filter(Boolean).join(" · ") || "Supplied in action inputs"}</dd></div>{request.expected_version && <div><dt className="font-semibold text-charcoal/55">Expected version</dt><dd className="mt-1 text-nearblack">{request.expected_version}</dd></div>}{request.expires_at && <div><dt className="font-semibold text-charcoal/55">Expires</dt><dd className="mt-1 text-nearblack">{new Date(request.expires_at).toLocaleString("en-AU")}</dd></div>}</dl><div className="mt-4"><p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[#76634f]">Inputs bound to this approval</p><div className="mt-2 border border-[#d8d2c6] bg-[#faf6ec] px-4 py-1"><ReadableValue value={request.tool_args} /></div></div></details>}
    </footer>
  </section>;
}
