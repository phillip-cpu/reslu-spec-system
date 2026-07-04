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
  },
};

export default nextConfig;
