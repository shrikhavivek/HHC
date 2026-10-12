import type { Metadata } from "next";
import "./globals.css";
import "./editorial.css";
import "./studio-design.css";
import "./collage-usability.css";
import "./studio-theme.css";
import "./studio-readability.css";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "High Heel Confidential — Editorial Studio",
  description: "High Heel Confidential's evidence-led celebrity outfit research desk",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><head><link rel="preload" href="/fonts/manrope-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous"/><link rel="preload" href="/fonts/cormorant-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous"/></head><body><a className="skip-link" href="#main-content">Skip to content</a>{children}</body></html>;
}
