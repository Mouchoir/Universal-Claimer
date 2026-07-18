# @uc/notifications

Best-effort outbound webhook delivery for operator notifications (US4).

`deliver(target, message)` posts to a Discord / Telegram / ntfy webhook. It **never throws**
and returns `false` on failure, so a broken webhook can never fail or block a job
(FR-014a). The in-portal SSE channel is authoritative; the webhook is an optional extra.

```ts
import { deliver } from "@uc/notifications";
await deliver({ kind: "discord", url }, "Universal Claimer: a claim needs your attention");
```

The webhook config is stored encrypted (`notification_target`) and set during onboarding.
