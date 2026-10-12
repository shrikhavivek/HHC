import type { Metadata } from "next";
import "./globals.css";
import "./editorial.css";
import "./atelier.css";
import "./collage-usability.css";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "High Heel Confidential — Outfit Research",
  description: "High Heel Confidential's evidence-led celebrity outfit research desk",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
