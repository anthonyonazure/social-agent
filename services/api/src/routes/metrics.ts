// Aggregate metrics for dashboard tiles.

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '@social-agent/core';

export const metricsRoute = new Hono();

metricsRoute.get('/overview', async (c) => {
  const campaignId = c.req.query('campaignId');
  const filter = campaignId ? sql`WHERE campaign_id = ${campaignId}` : sql``;

  const stateCountsRaw = await db.execute(sql`
    SELECT state, count(*)::int AS count
    FROM content_items
    ${filter}
    GROUP BY state
  `);

  const last7dRaw = await db.execute(sql`
    SELECT
      date_trunc('day', created_at) AS day,
      count(*)::int AS planned,
      count(*) FILTER (WHERE state = 'published')::int AS published
    FROM content_items
    WHERE created_at >= now() - interval '7 days'
      ${campaignId ? sql`AND campaign_id = ${campaignId}` : sql``}
    GROUP BY 1
    ORDER BY 1
  `);

  const platformCountsRaw = await db.execute(sql`
    SELECT pt.platform, count(p.id)::int AS published
    FROM publications p
    JOIN publishing_targets pt ON pt.id = p.target_id
    JOIN content_items ci ON ci.id = p.content_item_id
    WHERE p.status = 'published'
      ${campaignId ? sql`AND ci.campaign_id = ${campaignId}` : sql``}
    GROUP BY pt.platform
  `);

  return c.json({
    states: stateCountsRaw,
    last7d: last7dRaw,
    platforms: platformCountsRaw,
  });
});
