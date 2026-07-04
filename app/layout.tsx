import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RESLU Spec System",
  description: "Project specification and procurement platform for RESLU.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-cream text-charcoal antialiased">{children}</body>
    </html>
  );
}
