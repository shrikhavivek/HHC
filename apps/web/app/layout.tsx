import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "High Heel Confidential — Outfit Research",
  description: "High Heel Confidential's evidence-led celebrity outfit research desk",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
