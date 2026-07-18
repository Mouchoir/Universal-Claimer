import { listJobs } from "@uc/db";
import { JOB_EVENTS_CHANNEL } from "@uc/db";
import { getDb } from "@/server/context";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream of job updates (SC-005). Subscribes to Postgres LISTEN and
 * relays a fresh jobs snapshot on every notification; also sends an initial snapshot so a
 * freshly opened dashboard is immediately consistent.
 */
export async function GET(): Promise<Response> {
  if (!isAuthenticated()) {
    return new Response("unauthorized", { status: 401 });
  }

  const { db, pool } = getDb();
  const client = await pool.connect();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = async () => {
        const jobs = await listJobs(db, 20);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "jobs", jobs })}\n\n`));
      };
      client.on("notification", () => {
        void send();
      });
      await client.query(`LISTEN ${JOB_EVENTS_CHANNEL}`);
      await send();
    },
    cancel() {
      client.removeAllListeners("notification");
      client.release();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
