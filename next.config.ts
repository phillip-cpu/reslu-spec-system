import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @huggingface/transformers (lib/second-brain/embeddings.ts, migration 045
  // gte-small switch) pulls in onnxruntime-node, a native addon — keep it out
  // of the Turbopack/webpack bundle so its .node binding loads from
  // node_modules at runtime like any other native module, rather than having
  // the bundler rewrite its own internal dynamic require() paths (which
  // breaks the addon's ability to find its .so file at all). Paired with the
  // outputFileTracingIncludes entries below, which get that .so file
  // actually shipped into each function's deployment bundle in the first
  // place — the two problems are independent and both are required.
  serverExternalPackages: ["onnxruntime-node", "@huggingface/transformers"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.supabase.co",
      },
      // Imported/scraped item image URLs come from arbitrary supplier CDNs,
      // so any https host is allowed for the image optimiser (internal tool,
      // authed users, product photos — same trust model as the scraper).
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
  // Ensure the PDF route's font + logo files are bundled into the
  // serverless function on Vercel (they're read from disk at render time).
  outputFileTracingIncludes: {
    "/api/projects/[id]/pdf": [
      "./public/fonts/**",
      "./public/reslu-logo.png",
      "./public/reslu-logo-white.png",
    ],
    // Site-visit lifecycle emails (docs/RESLU-Spec-Visit-Emails-Brief.md):
    // lib/visit-emails.ts's loadTemplate() reads emails/*.html off disk
    // at runtime via a dynamically-built path (not a static import), so
    // Next's default file tracing can't discover the dependency on its
    // own — without this entry the folder works locally (cwd is the
    // repo root either way) but 404s on Vercel once deployed, since
    // only statically-traceable files get bundled into each serverless
    // function by default. Listed against every route that (directly or
    // via lib/visit-emails.ts's sendOrQueue/flushPendingSends) can reach
    // loadTemplate() at send time — the two lead-write routes, the
    // client-events create route, and the reminder/flush cron route.
    // (GET /api/visit-emails and DELETE /api/client-events/[id] only
    // read email_sends / call cancelPendingSends — neither ever loads a
    // template — so neither needs an entry here.)
    "/api/leads/[id]": ["./emails/**"],
    "/api/leads": ["./emails/**"],
    "/api/projects/[id]/client-events": ["./emails/**"],
    "/api/visit-emails/run": ["./emails/**"],
    // Lead flow round (048): GET /brief/[token] reads emails/brief/
    // project-brief.html off disk at runtime via lib/brief-page.ts's
    // loadBriefPageHtml() (same dynamically-built-path tracing gap as
    // lib/visit-emails.ts's loadTemplate(), documented above). POST
    // /api/brief-submit/[token] does NOT need an entry — it only reads/
    // writes leads/daily_brief_items, never touches disk.
    "/brief/[token]": ["./emails/**"],
    // Grouped trade booking round (r20): these three routes call
    // lib/visit-emails.ts's sendOrQueue() (trade-booking-request.html /
    // trade-booking-reply.html) — same dynamically-built-path tracing
    // gap as every other loadTemplate() call site above.
    "/api/projects/[id]/trade-requests": ["./emails/**"],
    "/api/trade-requests/[id]/resend": ["./emails/**"],
    "/api/trade-requests/[id]/lines/[visitId]/resolve": ["./emails/**"],
    // gte-small embeddings (migration 045): onnxruntime-node's native
    // addon dynamically loads libonnxruntime.so.1 (Linux) at runtime via
    // a path Next's static file tracer can't follow — without this entry
    // the function builds fine locally (README/Vercel don't complain at
    // build time) but 500s in production the moment embedTexts() actually
    // runs, since the .so file was never copied into the deployed bundle.
    // Only the routes that reach embedTexts() need this — see lib/second-
    // brain/embeddings.ts for the wrapper, and grep embedTexts for the
    // exhaustive caller list if this ever needs updating.
    "/api/second-brain/reindex": ["./node_modules/onnxruntime-node/bin/**"],
    "/api/second-brain/search": ["./node_modules/onnxruntime-node/bin/**"],
    "/api/second-brain/match": ["./node_modules/onnxruntime-node/bin/**"],
    // Fee proposal phase round (r23): POST /api/proposals/[id]/send and
    // .../resend both call lib/proposal-emails.ts's own
    // loadProposalSentTemplate(), which reads emails/proposal-sent.html
    // off disk at runtime via a dynamically-built path — same tracing
    // gap as every other loadTemplate()-style call site above. POST
    // /api/proposal/[token]/accept never reads emails/** (its
    // confirmation email is built inline, no template file — see that
    // route's own doc comment) but DOES render components/pdf/ProposalPdf.tsx
    // via @react-pdf at runtime, which reads the Cormorant font + the
    // actual logo file off disk exactly like /api/projects/[id]/pdf
    // above — same entry shape as that route's own line.
    "/api/proposals/[id]/send": ["./emails/**"],
    "/api/proposals/[id]/resend": ["./emails/**"],
    "/api/proposal/[token]/accept": [
      "./public/fonts/**",
      "./public/reslu-logo.png",
    ],
  },
};

export default nextConfig;
