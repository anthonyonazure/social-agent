// Approval inbox — items waiting for human script review.

import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  contentItems,
  campaigns,
  industries,
  personas,
} from '@social-agent/core';

export const approvalsRoute = new Hono();

approvalsRoute.get('/', async (c) => {
  const campaignId = c.req.query('campaignId');

  const conditions = [eq(contentItems.state, 'script_drafted')];
  if (campaignId) conditions.push(eq(contentItems.campaignId, campaignId));

  const rows = await db
    .select({
      item: contentItems,
      industryName: industries.name,
      personaName: personas.name,
      campaignName: campaigns.name,
      autonomyMode: campaigns.autonomyMode,
    })
    .from(contentItems)
    .leftJoin(industries, eq(industries.id, contentItems.industryId))
    .leftJoin(personas, eq(personas.id, contentItems.personaId))
    .leftJoin(campaigns, eq(campaigns.id, contentItems.campaignId))
    .where(and(...conditions))
    .orderBy(desc(contentItems.createdAt))
    .limit(100);

  // Filter to items whose campaign requires human approval
  const filtered = rows.filter((r) => r.autonomyMode !== 'auto');

  return c.json({ items: filtered });
});

const ApproveSchema = z.object({ approvedBy: z.string().default('dashboard-user') });
const RejectSchema = z.object({
  reason: z.string().min(2),
  rejectedBy: z.string().default('dashboard-user'),
});

approvalsRoute.post('/:id/approve', async (c) => {
  const id = c.req.param('id');
  const body: unknown = await c.req.json().catch(() => ({}));
  const parsed = ApproveSchema.safeParse(body);
  const approvedBy = parsed.success ? parsed.data.approvedBy : 'dashboard-user';

  const [updated] = await db
    .update(contentItems)
    .set({
      state: 'script_approved',
      scriptApprovedAt: new Date(),
      scriptApprovedBy: approvedBy,
      scriptRejectionReason: null,
    })
    .where(and(eq(contentItems.id, id), eq(contentItems.state, 'script_drafted')))
    .returning();

  if (!updated) return c.json({ error: 'not found or not in script_drafted' }, 404);
  return c.json({ item: updated });
});

approvalsRoute.post('/:id/reject', async (c) => {
  const id = c.req.param('id');
  const body: unknown = await c.req.json().catch(() => ({}));
  const parsed = RejectSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);

  const [updated] = await db
    .update(contentItems)
    .set({
      state: 'planned', // re-enter pipeline; script-writer regenerates
      script: null,
      hook: null,
      cta: null,
      topic: '',
      topicEmbedding: null,
      scriptRejectionReason: parsed.data.reason,
    })
    .where(and(eq(contentItems.id, id), eq(contentItems.state, 'script_drafted')))
    .returning();

  if (!updated) return c.json({ error: 'not found or not in script_drafted' }, 404);
  return c.json({ item: updated });
});
