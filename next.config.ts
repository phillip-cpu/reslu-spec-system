import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
  },
};

export default nextConfig;
