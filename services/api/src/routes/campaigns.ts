import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  campaigns,
  campaignIndustries,
  industries,
} from '@social-agent/core';

export const campaignsRoute = new Hono();

const PatchSchema = z.object({
  active: z.boolean().optional(),
  autonomyMode: z.enum(['manual', 'hitl', 'auto']).optional(),
  weeklyTestimonials: z.number().int().min(0).optional(),
  weeklyCaseStudies: z.number().int().min(0).optional(),
  weeklyExplainers: z.number().int().min(0).optional(),
  weeklyEducational: z.number().int().min(0).optional(),
  weeklyFounderMessages: z.number().int().min(0).optional(),
  weeklyIndustryInsights: z.number().int().min(0).optional(),
  postingSchedule: z.string().optional(),
  postingTimezone: z.string().optional(),
  brandVoice: z.string().nullable().optional(),
  brandDefaultCta: z.string().nullable().optional(),
});

// List
campaignsRoute.get('/', async (c) => {
  const rows = await db.select().from(campaigns);
  return c.json({ campaigns: rows });
});

// Detail with industries + counts
campaignsRoute.get('/:id', async (c) => {
  const id = c.req.param('id');

  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign) return c.json({ error: 'not found' }, 404);

  const inds = await db
    .select({
      id: industries.id,
      name: industries.name,
      slug: industries.slug,
      weight: campaignIndustries.weight,
    })
    .from(campaignIndustries)
    .innerJoin(industries, eq(industries.id, campaignIndustries.industryId))
    .where(eq(campaignIndustries.campaignId, id));

  const stateCountsRaw = await db.execute(sql`
    SELECT state, count(*)::int AS count
    FROM content_items
    WHERE campaign_id = ${id}
    GROUP BY state
  `);
  const stateCounts: Record<string, number> = {};
  for (const r of stateCountsRaw as unknown as Array<{ state: string; count: number }>) {
    stateCounts[r.state] = r.count;
  }

  return c.json({ campaign, industries: inds, stateCounts });
});

// Patch
campaignsRoute.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body: unknown = await c.req.json();
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }

  const [updated] = await db
    .update(campaigns)
    .set(parsed.data)
    .where(eq(campaigns.id, id))
    .returning();

  if (!updated) return c.json({ error: 'not found' }, 404);
  return c.json({ campaign: updated });
});
