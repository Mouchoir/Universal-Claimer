/**
 * Outbound webhook delivery for operator notifications (US4). Best-effort by contract:
 * failures are reported as `false` and never throw, so a broken webhook can never fail or
 * block a job (FR-014a). The in-portal SSE channel remains authoritative.
 */

export type NotificationKind = "discord" | "telegram" | "ntfy";

export interface WebhookTarget {
  kind: NotificationKind;
  url: string;
}

export interface DeliverOptions {
  fetchImpl?: typeof fetch;
}

function buildRequest(target: WebhookTarget, message: string): { url: string; init: RequestInit } {
  switch (target.kind) {
    case "discord":
      return {
        url: target.url,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: message }),
        },
      };
    case "telegram":
      // The URL is expected to be a preconfigured endpoint that accepts { text }.
      return {
        url: target.url,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: message }),
        },
      };
    case "ntfy":
      return { url: target.url, init: { method: "POST", body: message } };
  }
}

/** Deliver a message to the configured webhook. Returns true on success, false otherwise. */
export async function deliver(
  target: WebhookTarget,
  message: string,
  opts: DeliverOptions = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const { url, init } = buildRequest(target, message);
    const res = await fetchImpl(url, init);
    return res.ok;
  } catch {
    return false;
  }
}
