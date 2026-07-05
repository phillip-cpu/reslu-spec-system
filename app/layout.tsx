import type { Metadata, Viewport } from "next";
import "./globals.css";

/**
 * Home-screen app polish (BUILD-SPEC.md §"Phase 11 addition — mobile
 * pass": "Home-screen app polish: apple-touch-icon + manifest +
 * viewport/safe-area handling"). manifest.json + icon-192/512.png +
 * apple-touch-icon.png live in public/ (generated from
 * public/reslu-logo.png onto the brand cream background — see this
 * task's final report for the generation script). themeColor here
 * matches manifest.json's theme_color/background_color (#EDE8DE cream)
 * so the browser chrome/splash screen never flashes a mismatched
 * colour on load.
 */
export const metadata: Metadata = {
  title: "RESLU Spec System",
  description: "Project specification and procurement platform for RESLU.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "RESLU",
  },
};

// Separate `viewport` export (Next.js 13.4+ convention — viewport-
// affecting metadata no longer belongs in the `metadata` object).
// viewportFit: "cover" + the safe-area-inset padding on <body> below
// are the mobile pass's "safe-area handling": on notched/rounded-corner
// phones (the gallery/diary composer's primary devices per BUILD-SPEC's
// "on site it will be mainly phones"), content otherwise sits flush
// under the notch/home-indicator without this.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#EDE8DE",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className="bg-cream text-charcoal antialiased"
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          paddingLeft: "env(safe-area-inset-left)",
          paddingRight: "env(safe-area-inset-right)",
        }}
      >
        {children}
      </body>
    </html>
  );
}
