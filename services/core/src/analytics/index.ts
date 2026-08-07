// Analytics ingestion — pulls IG Insights + TikTok Display API metrics back
// into post_metrics, then rolls them up into topic_performance which the
// planner reads to bias industry/type weights.

import { eq, and, sql, isNull, lt, gte } from 'drizzle-orm';
import { db } from '../db.js';
import {
  publications,
  publishingTargets,
  postMetrics,
  topicPerformance,
} from '../schema.js';
import { env } from '../env.js';

interface PostStats {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  reach: number;
  watchTimeSeconds: number;
  raw?: unknown;
}

// ----------------------------------------------------------------------------
// Mock + real fetchers
// ----------------------------------------------------------------------------

function mockStats(seed: string, hoursSincePost: number): PostStats {
  // Deterministic mock — same publication grows over time.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  const base = Math.abs(h) % 8000 + 1000;
  const decay = Math.max(0.3, 1 - hoursSincePost / 168); // 1w decay floor 0.3
  const growth = Math.min(8, 1 + hoursSincePost / 12);
  const views = Math.floor(base * growth * decay);
  const er = 0.02 + (h % 80) / 1000;       // 2-10%
  const likes = Math.floor(views * er * 0.7);
  const comments = Math.floor(views * er * 0.15);
  const shares = Math.floor(views * er * 0.1);
  const saves = Math.floor(views * er * 0.05);
  return {
    views,
    likes,
    comments,
    shares,
    saves,
    reach: Math.floor(views * 1.4),
    watchTimeSeconds: Math.floor(views * 8),
    raw: { source: 'mock', seed, hoursSincePost },
  };
}

async function fetchInstagramStats(remotePostId: string): Promise<PostStats> {
  if (env.DEMO_MODE || !env.IG_PAGE_ACCESS_TOKEN) return mockStats(`ig:${remotePostId}`, 24);

  const url = new URL(`https://graph.facebook.com/v21.0/${remotePostId}/insights`);
  url.searchParams.set('metric', 'plays,likes,comments,shares,saved,reach,total_interactions,ig_reels_video_view_total_time');
  url.searchParams.set('access_token', env.IG_PAGE_ACCESS_TOKEN);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`IG insights fetch failed: ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ name: string; values: Array<{ value: number }> }> };
  const m = new Map<string, number>();
  for (const row of data.data ?? []) m.set(row.name, row.values?.[0]?.value ?? 0);
  return {
    views: m.get('plays') ?? 0,
    likes: m.get('likes') ?? 0,
    comments: m.get('comments') ?? 0,
    shares: m.get('shares') ?? 0,
    saves: m.get('saved') ?? 0,
    reach: m.get('reach') ?? 0,
    watchTimeSeconds: Math.floor((m.get('ig_reels_video_view_total_time') ?? 0) / 1000),
    raw: data,
  };
}

async function fetchTikTokStats(remotePostId: string): Promise<PostStats> {
  if (env.DEMO_MODE || !env.TIKTOK_ACCESS_TOKEN) return mockStats(`tt:${remotePostId}`, 24);

  const res = await fetch('https://open.tiktokapis.com/v2/video/query/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TIKTOK_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filters: { video_ids: [remotePostId] },
    }),
  });
  if (!res.ok) throw new Error(`TikTok stats fetch failed: ${res.status}`);
  const data = (await res.json()) as {
    data?: { videos?: Array<{ view_count?: number; like_count?: number; comment_count?: number; share_count?: number; reach?: number }> };
  };
  const v = data.data?.videos?.[0] ?? {};
  return {
    views: v.view_count ?? 0,
    likes: v.like_count ?? 0,
    comments: v.comment_count ?? 0,
    shares: v.share_count ?? 0,
    saves: 0,
    reach: v.reach ?? v.view_count ?? 0,
    watchTimeSeconds: 0,
    raw: data,
  };
}

// ----------------------------------------------------------------------------
// Ingestion
// ----------------------------------------------------------------------------

export interface IngestionResult {
  fetched: number;
  errors: number;
}

const SAMPLE_POINTS_HOURS = [1, 6, 24, 72, 168]; // 1h, 6h, 1d, 3d, 1w

/**
 * Pulls metrics for published posts that are due for a snapshot.
 * Schedules samples at +1h, +6h, +1d, +3d, +1w after posted_at.
 */
export async function ingestDueMetrics(): Promise<IngestionResult> {
  const now = Date.now();

  const published = await db
    .select({
      pub: publications,
      target: publishingTargets,
    })
    .from(publications)
    .innerJoin(publishingTargets, eq(publishingTargets.id, publications.targetId))
    .where(and(eq(publications.status, 'published'), sql`${publications.postedAt} IS NOT NULL`))
    .limit(200);

  let fetched = 0;
  let errors = 0;

  for (const { pub, target } of published) {
    if (!pub.postedAt || !pub.remotePostId) continue;
    const ageHours = Math.floor((now - pub.postedAt.getTime()) / 3600_000);

    // Find which snapshots are due that we haven't taken yet
    const existing = await db
      .select({ hoursSincePost: postMetrics.hoursSincePost })
      .from(postMetrics)
      .where(eq(postMetrics.publicationId, pub.id));
    const taken = new Set(existing.map((r) => r.hoursSincePost));

    const due = SAMPLE_POINTS_HOURS.filter((h) => h <= ageHours && !taken.has(h));
    if (due.length === 0) continue;

    for (const h of due) {
      try {
        const stats =
          target.platform === 'instagram'
            ? await fetchInstagramStats(pub.remotePostId)
            : target.platform === 'tiktok'
              ? await fetchTikTokStats(pub.remotePostId)
              : mockStats(`x:${pub.remotePostId}`, h);

        const er = stats.views > 0
          ? (stats.likes + stats.comments + stats.shares + stats.saves) / stats.views
          : 0;

        await db.insert(postMetrics).values({
          publicationId: pub.id,
          hoursSincePost: h,
          views: stats.views,
          likes: stats.likes,
          comments: stats.comments,
          shares: stats.shares,
          saves: stats.saves,
          reach: stats.reach,
          watchTimeSeconds: stats.watchTimeSeconds,
          engagementRate: er.toFixed(4),
          raw: stats.raw ?? {},
        });
        fetched++;
      } catch (err) {
        console.warn(`[analytics] fetch failed for pub ${pub.id}:`, err);
        errors++;
      }
    }
  }

  // After snapshotting, roll up into topic_performance
  await rollupTopicPerformance();

  return { fetched, errors };
}

/**
 * Aggregates the latest metric per publication into topic_performance, weighted
 * by content_type + industry + language. Sets planner_weight_modifier in
 * [0.5, 2.0] based on relative engagement.
 */
async function rollupTopicPerformance(): Promise<void> {
  // For each (campaign, industry, content_type, language), pull the latest
  // metric snapshot per publication and average.

  await db.execute(sql`
    INSERT INTO topic_performance (
      campaign_id, industry_id, content_type, language,
      posts, total_views, total_engagement, avg_engagement_rate,
      planner_weight_modifier, updated_at
    )
    SELECT
      ci.campaign_id,
      ci.industry_id,
      ci.type,
      ci.language,
      count(DISTINCT p.id)::int                                AS posts,
      coalesce(sum(latest.views), 0)::bigint                   AS total_views,
      coalesce(sum(latest.likes + latest.comments + latest.shares + latest.saves), 0)::bigint AS total_engagement,
      coalesce(avg(latest.engagement_rate), 0)                 AS avg_er,
      LEAST(2.00, GREATEST(0.50, 0.5 + 30 * coalesce(avg(latest.engagement_rate), 0))) AS modifier,
      now()
    FROM publications p
    JOIN content_items ci ON ci.id = p.content_item_id
    JOIN LATERAL (
      SELECT *
      FROM post_metrics m
      WHERE m.publication_id = p.id
      ORDER BY m.hours_since_post DESC
      LIMIT 1
    ) latest ON true
    WHERE p.status = 'published'
    GROUP BY ci.campaign_id, ci.industry_id, ci.type, ci.language
    ON CONFLICT (campaign_id, industry_id, content_type, language)
    DO UPDATE SET
      posts                   = EXCLUDED.posts,
      total_views             = EXCLUDED.total_views,
      total_engagement        = EXCLUDED.total_engagement,
      avg_engagement_rate     = EXCLUDED.avg_engagement_rate,
      planner_weight_modifier = EXCLUDED.planner_weight_modifier,
      updated_at              = now()
  `);
}

/**
 * Returns the planner weight modifier for a (campaign, industry, type, language).
 * Defaults to 1.0 if no data yet.
 */
export async function getWeightModifier(
  campaignId: string,
  industryId: string,
  type: string,
  language: string
): Promise<number> {
  const rows = await db
    .select({ modifier: topicPerformance.plannerWeightModifier })
    .from(topicPerformance)
    .where(
      and(
        eq(topicPerformance.campaignId, campaignId),
        eq(topicPerformance.industryId, industryId),
        eq(topicPerformance.contentType, type as never),
        eq(topicPerformance.language, language as never)
      )
    )
    .limit(1);
  return rows[0] ? parseFloat(rows[0].modifier) : 1.0;
}

// suppress unused for tree-shake
void isNull;
void lt;
void gte;
