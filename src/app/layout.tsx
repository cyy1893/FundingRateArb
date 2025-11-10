import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hyperliquid Perpetuals Dashboard",
  description:
    "Minimalist monitoring panel for Hyperliquid perpetual markets built with Next.js.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
