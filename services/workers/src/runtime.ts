// Worker runtime — generic state-machine pump.
// Each worker advertises its input state, claims items in batches with FOR
// UPDATE SKIP LOCKED, processes them, advances state.

import { eq } from 'drizzle-orm';
import {
  db,
  contentItems,
  workflowRuns,
  type ContentItem,
  type ContentState,
  type NewWorkflowRun,
  env,
} from '@social-agent/core';

export interface WorkerHandler {
  name: string;
  inputState: ContentState;
  // Process a single content item; return the new state.
  // Throw to mark the item failed (with retry).
  process: (item: ContentItem) => Promise<{ nextState: ContentState; payload?: unknown }>;
  batchSize?: number;
  pollIntervalMs?: number;
}

const MAX_RETRY = 5;

export function createWorker(handler: WorkerHandler) {
  const batchSize = handler.batchSize ?? env.WORKER_BATCH_SIZE;
  const pollMs = handler.pollIntervalMs ?? env.WORKER_POLL_INTERVAL_MS;

  let stopped = false;

  async function tick(): Promise<number> {
    // Claim items via SELECT ... FOR UPDATE SKIP LOCKED in a transaction,
    // then read full rows through the typed query API so columns come back
    // as the camelCase shape our handlers expect.
    const claimed = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(contentItems)
        .where(eq(contentItems.state, handler.inputState))
        .orderBy(contentItems.createdAt)
        .limit(batchSize)
        .for('update', { skipLocked: true });
      return rows;
    });

    for (const item of claimed) {
      const start = Date.now();
      const runRow: NewWorkflowRun = {
        contentItemId: item.id,
        workflowName: handler.name,
        stateFrom: handler.inputState,
        startedAt: new Date(),
        status: 'running',
      };
      const [run] = await db.insert(workflowRuns).values(runRow).returning({ id: workflowRuns.id });

      try {
        const { nextState, payload } = await handler.process(item);

        await db
          .update(contentItems)
          .set({
            state: nextState,
            lastError: null,
            retryCount: 0,
          })
          .where(eq(contentItems.id, item.id));

        await db
          .update(workflowRuns)
          .set({
            stateTo: nextState,
            finishedAt: new Date(),
            durationMs: Date.now() - start,
            status: 'success',
            payload: payload ?? null,
          })
          .where(eq(workflowRuns.id, run!.id));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retryCount = (item.retryCount ?? 0) + 1;
        const nextState: ContentState =
          retryCount >= MAX_RETRY ? 'failed' : handler.inputState;

        await db
          .update(contentItems)
          .set({
            state: nextState,
            retryCount,
            lastError: message,
          })
          .where(eq(contentItems.id, item.id));

        await db
          .update(workflowRuns)
          .set({
            stateTo: nextState,
            finishedAt: new Date(),
            durationMs: Date.now() - start,
            status: 'failed',
            error: message,
          })
          .where(eq(workflowRuns.id, run!.id));
      }
    }

    return claimed.length;
  }

  async function loop() {
    while (!stopped) {
      try {
        const processed = await tick();
        if (processed === 0) {
          await new Promise((r) => setTimeout(r, pollMs));
        }
      } catch (err) {
        console.error(`[${handler.name}] loop error:`, err);
        await new Promise((r) => setTimeout(r, pollMs * 2));
      }
    }
  }

  return {
    name: handler.name,
    start: () => {
      console.log(`[worker] ${handler.name} listening on state=${handler.inputState}`);
      void loop();
    },
    stop: () => {
      stopped = true;
    },
  };
}

// ============================================================================
// CRON-STYLE worker (no input state — fires on interval)
// ============================================================================

export function createCronWorker(opts: {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}) {
  let stopped = false;

  async function loop() {
    while (!stopped) {
      try {
        await opts.run();
      } catch (err) {
        console.error(`[${opts.name}] cron error:`, err);
      }
      await new Promise((r) => setTimeout(r, opts.intervalMs));
    }
  }

  return {
    name: opts.name,
    start: () => {
      console.log(`[worker] ${opts.name} cron every ${opts.intervalMs}ms`);
      void loop();
    },
    stop: () => {
      stopped = true;
    },
  };
}

