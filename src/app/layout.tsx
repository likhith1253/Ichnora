import type { Metadata, Viewport } from "next";
import "./globals.css";

const DESCRIPTION =
  "Ichnora connects your conversations, memories, decisions and live web research into one searchable personal knowledge system.";

export const metadata: Metadata = {
  applicationName: "Ichnora",
  title: {
    default: "Ichnora — Remember the past. Discover the present.",
    template: "%s · Ichnora",
  },
  description: DESCRIPTION,
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "32x32" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    siteName: "Ichnora",
    title: "Ichnora — Personal Memory & Knowledge Assistant",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary",
    title: "Ichnora — Personal Memory & Knowledge Assistant",
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f5f0" },
    { media: "(prefers-color-scheme: dark)", color: "#141412" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
