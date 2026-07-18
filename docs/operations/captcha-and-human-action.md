# Captcha & human action

Captcha handling is layered (Constitution Principle V). Most challenges are prevented; the
rest are solved automatically; only what remains needs you.

## The three layers

1. **Prevent** — CloakBrowser (source-patched Chromium, run headed via Xvfb) avoids
   triggering most bot challenges.
2. **Auto-solve** — if a captcha still appears and an anti-captcha.com key is configured
   (`ANTI_CAPTCHA_KEY` on the worker), the run submits it to the solving service and retries.
3. **Human action (fallback)** — if there is no key, or solving fails, the job pauses in the
   `requires_human_action` state and you are notified. **No VNC / remote desktop is used.**

## What "human action" means here

The MVP uses the **hand-back** model (FR-014): the job pauses, and you complete the challenge
in **your own browser** (sign in to the service and clear the challenge there). Then click
**"I've solved it — resume"** on the dashboard. The job resumes by re-running the claim —
which is idempotent (it reports `nothing_to_claim` if the item was already claimed), so
resuming is safe and is not a restart from scratch.

> A future enhancement can relay a screenshot + inputs through the portal instead of the
> hand-back flow; the state machine and endpoint already support pause/resume.

## Notifications

When a job needs attention (or fails, or needs re-auth), you are notified:

- **In the portal** in real time over SSE (authoritative).
- **On your webhook** (Discord / Telegram / ntfy), if you configured one at onboarding.

Webhook delivery is best-effort: if it fails, it is logged and never fails or blocks the job
(FR-014a).

## Resume flow (states)

```
running ──captcha unsolved──► requires_human_action ──resume──► running ──► terminal
```

`requires_human_action` is non-terminal; the account is not touched. Resuming re-enqueues the
same job for the worker.
