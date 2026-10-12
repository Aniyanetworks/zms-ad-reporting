import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:8000";

// Supabase origin for the CSP connect-src (Auth REST + Realtime websocket).
// Resolved at build time from the public env; wildcard fallback when unset.
function supabaseOrigins(): string[] {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return ["https://*.supabase.co", "wss://*.supabase.co"];
  try {
    const u = new URL(raw);
    return [u.origin, `wss://${u.host}`];
  } catch {
    return ["https://*.supabase.co", "wss://*.supabase.co"];
  }
}

// 'unsafe-inline' for scripts is required by the Next App Router's inline
// hydration payloads without a per-request nonce; styles need it for
// Tailwind/shadcn inline style attributes and Recharts.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${supabaseOrigins().join(" ")}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy", value: CSP },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "ads.contractorscalingblueprint.com",
    "setter.contractorscalingblueprint.com",
    "adbuildout.contractorscalingblueprint.com",
    "staging-adbuildout.contractorscalingblueprint.com",
  ],
  async headers() {
    return [{ source: "/(.*)", headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    // API proxied at /api via Next.js so the browser never crosses origins (no CORS)
    return [
      {
        source: "/api/:path*",
        destination: `${API_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
