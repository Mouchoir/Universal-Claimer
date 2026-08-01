"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

/**
 * Persistent navigation for the signed-in pages.
 *
 * Every page used to be a dead end unless it happened to carry its own link: the connect and
 * login-session pages had none at all, so an operator who opened one had no way back short of
 * editing the URL. A header in the layout means "somewhere to go" is a property of the app
 * rather than something each page has to remember. It also gives sign-out its first entry
 * point — the API route existed but nothing ever called it.
 */

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/activity", label: "Activity" },
];

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // The cookie may already be gone; either way the operator asked to leave.
    }
    // refresh() as well as push(): the layout is a server component that reads the session
    // cookie, so without it the header would still render as signed in.
    router.refresh();
    router.push("/login");
  }

  return (
    <header className="uc-header">
      <Link href="/dashboard" className="uc-brand">
        Universal Claimer
      </Link>
      <nav className="uc-nav">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            // Exact match: on a task page such as /connect/epic neither tab is the current
            // page, and marking one anyway would misdescribe where the operator is.
            aria-current={pathname === link.href ? "page" : undefined}
            className={pathname === link.href ? "uc-nav-current" : undefined}
          >
            {link.label}
          </Link>
        ))}
      </nav>
      <button type="button" className="uc-quiet" onClick={signOut} disabled={signingOut}>
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </header>
  );
}
