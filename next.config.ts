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
  },
};

export default nextConfig;
