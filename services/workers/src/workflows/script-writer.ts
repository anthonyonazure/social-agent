// Script Writer — picks items in `planned`, generates topic/hook/script/CTA via LLM,
// embeds the topic, runs cosine-distance dedup against same campaign+industry+language,
// regenerates up to 3x if too similar to recent items.

import { eq, and, gte, sql, desc } from 'drizzle-orm';
import {
  db,
  campaigns,
  industries,
  contentItems,
  providers,
  type ContentItem,
} from '@social-agent/core';
import { createWorker } from '../runtime.js';

const llm = providers.createLlmProvider();

const DEDUP_THRESHOLD = 0.85; // cosine similarity above this = too close
const RECENT_WINDOW_DAYS = 90;
const MAX_REGEN_ATTEMPTS = 3;

async function recentTopicsFor(item: ContentItem): Promise<string[]> {
  if (!item.industryId) return [];
  const cutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ topic: contentItems.topic })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.campaignId, item.campaignId),
        eq(contentItems.industryId, item.industryId),
        eq(contentItems.language, item.language),
        gte(contentItems.createdAt, cutoff)
      )
    )
    .orderBy(desc(contentItems.createdAt))
    .limit(50);

  return rows.map((r) => r.topic).filter((t): t is string => Boolean(t));
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function checkDedup(
  embedding: number[],
  item: ContentItem
): Promise<{ ok: boolean; maxSim: number }> {
  if (!item.industryId) return { ok: true, maxSim: 0 };
  const cutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const recentEmbeddings = await db
    .select({ embedding: contentItems.topicEmbedding })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.campaignId, item.campaignId),
        eq(contentItems.industryId, item.industryId),
        eq(contentItems.language, item.language),
        gte(contentItems.createdAt, cutoff),
        sql`${contentItems.topicEmbedding} IS NOT NULL`
      )
    )
    .limit(50);

  let maxSim = 0;
  for (const row of recentEmbeddings) {
    if (!row.embedding) continue;
    try {
      const vec = JSON.parse(row.embedding) as number[];
      maxSim = Math.max(maxSim, cosineSim(embedding, vec));
    } catch {
      // skip malformed
    }
  }
  return { ok: maxSim < DEDUP_THRESHOLD, maxSim };
}

export const scriptWriterWorker = createWorker({
  name: 'script-writer',
  inputState: 'planned',
  process: async (item) => {
    if (!item.industryId) {
      throw new Error('content_item missing industry_id');
    }

    const [campaign, industry] = await Promise.all([
      db.query.campaigns.findFirst({ where: eq(campaigns.id, item.campaignId) }),
      db.query.industries.findFirst({ where: eq(industries.id, item.industryId) }),
    ]);
    if (!campaign) throw new Error(`campaign ${item.campaignId} not found`);
    if (!industry) throw new Error(`industry ${item.industryId} not found`);

    const recent = await recentTopicsFor(item);

    let attempt = 0;
    let lastReason: string | null = item.scriptRejectionReason ?? null;

    while (attempt < MAX_REGEN_ATTEMPTS) {
      const draft = await llm.generateScript({
        type: item.type,
        industryName: industry.name,
        industrySeeds: industry.topicSeeds ?? [],
        language: item.language,
        brandVoice: campaign.brandVoice,
        brandCta: campaign.brandDefaultCta,
        recentTopics: recent,
        rejectionReason: lastReason,
      });

      const embedding = await llm.embed(draft.topic);
      const { ok, maxSim } = await checkDedup(embedding, item);

      if (ok) {
        await db
          .update(contentItems)
          .set({
            topic: draft.topic,
            hook: draft.hook,
            script: draft.script,
            cta: draft.cta,
            durationSeconds: draft.durationSeconds,
            // Store as JSON text — pgvector column is in raw SQL, drizzle column is text
            topicEmbedding: JSON.stringify(embedding),
            scriptRejectionReason: null,
            metadata: { ...(item.metadata ?? {}), llmMode: llm.mode, dedupMaxSim: maxSim },
          })
          .where(eq(contentItems.id, item.id));

        return { nextState: 'script_drafted', payload: { topic: draft.topic, maxSim } };
      }

      lastReason = `topic too similar (cosine=${maxSim.toFixed(3)}) to a recent post`;
      attempt++;
    }

    // After max attempts, accept the last draft anyway with a flag
    throw new Error(`could not generate distinct topic after ${MAX_REGEN_ATTEMPTS} attempts`);
  },
});
