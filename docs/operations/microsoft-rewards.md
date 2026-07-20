# Microsoft Rewards

Automatically run your daily Microsoft Rewards search tasks to earn points.

## Connect

1. On the dashboard, connect **Microsoft Rewards**, accept the TOS warning. No extra config
   is required (unlike Twitch).
2. Log in via **assisted login** (recommended — official Microsoft login inside the
   instance-controlled browser; only the session is captured, encrypted) or paste a Microsoft
   `cookies.txt`.

## How a run works

A claim:

1. Checks how many desktop searches are still outstanding today.
2. If none → **nothing_to_claim**.
3. Otherwise performs the searches with **varied queries** and **humanized delays**
   (~1.5–4.5s apart, jittered), capped at a daily maximum (default 30).
4. Reports **claimed** with a count (e.g. "Completed 30 Rewards searches"). Partial progress
   before an error/verification is still reported as claimed with the count done.
5. Expired session → **reauth_needed**. A verification/captcha → auto-solve, else human
   action (same layered strategy as the other connectors).

## Schedule it

Set the account to **Daily** at a chosen time in the schedule editor — MS Rewards resets
daily, so a daily schedule keeps the points flowing automatically.

## Notes

- Modern Bing Rewards dashboard only (legacy not supported). Selectors are best-effort and
  validated live.
- Desktop searches only for v1 (mobile set / daily-set / quizzes are out of scope).
- Adding MS Rewards required **no** changes to the scheduler, pipeline, SSE, or UI
  (Constitution Principle I).
