import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Parcel Atlas — Australian Property Intelligence",
  description: "Search Australian properties and assemble Cotality property, market, advertisement and valuation evidence.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
