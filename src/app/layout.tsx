import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lifecycle — AI email marketing for Shopify",
  description: "Approval-controlled AI lifecycle email marketing for Shopify stores.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" suppressHydrationWarning>
        <body className="min-h-dvh antialiased">{children}</body>
      </html>
    </ClerkProvider>
  );
}
