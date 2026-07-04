import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.supabase.co",
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
