# Scheduling (automatic recurring claims)

Set a connected account to claim automatically on a recurring schedule instead of clicking
"Run claim" each time. Works for every connector (Epic today, others later).

## Set a schedule

On the dashboard, each connected account has a schedule editor:

- **Run automatically** — enable/disable.
- **Daily** at a time (HH:MM), or **Weekly** on a chosen day at a time.
- Times are in the deployment's **local timezone**.
- **Next** shows the computed next run.

Changes take effect immediately — no worker restart needed.

## How it runs

- A scheduler tick fires every minute (a pg-boss cron).
- On each tick, due schedules (enabled, `nextRunAt <= now`) enqueue a claim for their account,
  exactly like clicking "Run claim", then advance to the next occurrence.
- Each automatic enqueue gets a small random delay (jitter, up to ~45s) so multiple accounts
  don't all run at the same instant (Constitution Principle VII).
- If a claim is already running for an account when its schedule is due, that occurrence is
  **skipped** (no double claim).
- If the worker was offline when a run was due, the schedule fires **once** on recovery, then
  advances to the next future slot — no backlog of missed runs.

## Notes

- One schedule per account. Disconnecting an account removes its schedule.
- Scheduling is connector-agnostic: adding a new connector needs no scheduler changes.
- Presets are daily/weekly only; arbitrary cron expressions are out of scope.
