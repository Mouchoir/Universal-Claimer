import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Universal Claimer",
  description: "Self-hosted automation for free-game and rewards claims.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="uc-container">{children}</div>
      </body>
    </html>
  );
}
