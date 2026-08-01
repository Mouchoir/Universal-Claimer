import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/AppHeader";
import { isAuthenticated } from "@/server/session-cookie";
import "./globals.css";

export const metadata: Metadata = {
  title: "Universal Claimer",
  description: "Self-hosted automation for free-game and rewards claims.",
};

// Reading the session cookie here makes every route dynamic. That is what this app already is —
// every page renders live state — and it is the price of a header that knows whether there is
// anywhere to navigate to.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  // Hidden before sign-in: the login, setup and recovery pages have nowhere to go, and a
  // Dashboard link that only bounces back to the login form is worse than no link at all.
  const signedIn = isAuthenticated();
  return (
    <html lang="en">
      <body>
        <div className="uc-container">
          {signedIn && <AppHeader />}
          {children}
        </div>
      </body>
    </html>
  );
}
