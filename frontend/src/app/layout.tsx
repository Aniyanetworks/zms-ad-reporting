import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

// Render every page per request so the HTML goes out as `no-store`. Prerendered pages were
// served with `s-maxage=31536000`; a browser that kept one after a redeploy loaded chunk
// hashes that no longer exist and showed an unstyled, empty page (2026-09-28). The
// hashed /_next/static assets stay immutable and cached.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "ZMS Ads Intelligence",
  description: "Multi-client paid ads reporting for Zeal Media Solutions",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
