import { Hono } from 'hono';
import { eq, and, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  contentItems,
  industries,
  personas,
  publications,
  publishingTargets,
  type ContentState,
} from '@social-agent/core';

export const contentRoute = new Hono();

const ListQuery = z.object({
  campaignId: z.string().uuid().optional(),
  state: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const STATE_VALUES: ContentState[] = [
  'planned',
  'script_drafted',
  'script_approved',
  'script_rejected',
  'assets_ready',
  'video_generating',
  'video_ready',
  'post_production',
  'ready_to_publish',
  'scheduled',
  'published',
  'failed',
  'cancelled',
];

contentRoute.get('/', async (c) => {
  const parsed = ListQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: 'invalid query', issues: parsed.error.issues }, 400);
  const { campaignId, state, limit } = parsed.data;

  const conditions = [];
  if (campaignId) conditions.push(eq(contentItems.campaignId, campaignId));
  if (state && (STATE_VALUES as string[]).includes(state)) {
    conditions.push(eq(contentItems.state, state as ContentState));
  }

  const rows = await db
    .select({
      item: contentItems,
      industryName: industries.name,
      personaName: personas.name,
    })
    .from(contentItems)
    .leftJoin(industries, eq(industries.id, contentItems.industryId))
    .leftJoin(personas, eq(personas.id, contentItems.personaId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(contentItems.createdAt))
    .limit(limit);

  return c.json({ items: rows });
});

contentRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, id));
  if (!item) return c.json({ error: 'not found' }, 404);

  const pubRows = await db
    .select({
      pub: publications,
      target: publishingTargets,
    })
    .from(publications)
    .innerJoin(publishingTargets, eq(publishingTargets.id, publications.targetId))
    .where(eq(publications.contentItemId, id));

  return c.json({ item, publications: pubRows });
});

// Manual state override (used by retry / cancel buttons in dashboard)
const TransitionSchema = z.object({
  state: z.enum(STATE_VALUES as [ContentState, ...ContentState[]]),
  reason: z.string().optional(),
});

contentRoute.post('/:id/transition', async (c) => {
  const id = c.req.param('id');
  const body: unknown = await c.req.json();
  const parsed = TransitionSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);

  const [updated] = await db
    .update(contentItems)
    .set({
      state: parsed.data.state,
      lastError: parsed.data.reason ?? null,
      retryCount: 0,
    })
    .where(eq(contentItems.id, id))
    .returning();

  if (!updated) return c.json({ error: 'not found' }, 404);
  return c.json({ item: updated });
});

// Counts grouped by state for dashboard sidebar
contentRoute.get('/_meta/counts', async (c) => {
  const campaignId = c.req.query('campaignId');
  const where = campaignId ? sql`WHERE campaign_id = ${campaignId}` : sql``;
  const rows = await db.execute(sql`
    SELECT state, count(*)::int AS count
    FROM content_items
    ${where}
    GROUP BY state
    ORDER BY count DESC
  `);
  return c.json({ counts: rows });
});
