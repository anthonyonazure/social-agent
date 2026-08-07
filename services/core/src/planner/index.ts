import { eq, and, gte, sql } from 'drizzle-orm';
import { db } from '../db.js';
import {
  campaigns,
  campaignIndustries,
  industries,
  contentItems,
  topicPerformance,
  type Industry,
  type ContentType,
  type Language,
  type NewContentItem,
} from '../schema.js';

// ============================================================================
// PLANNER — turn campaign config into planned content_items for the next week
// ============================================================================

interface PlannerResult {
  campaignId: string;
  itemsCreated: number;
  byType: Record<ContentType, number>;
  byIndustry: Record<string, number>;
  byLanguage: Record<Language, number>;
}

interface IndustryWithWeight extends Industry {
  weight: number;
}

const PLANNED_TYPES: ContentType[] = [
  'testimonial',
  'case_study',
  'explainer',
  'educational',
  'founder_message',
  'industry_insight',
];

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  const day = out.getUTCDay() || 7;
  if (day !== 1) out.setUTCDate(out.getUTCDate() - (day - 1));
  return out;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Weighted round-robin industry picker — keeps state across a planning run
class WeightedRotator {
  private cursor = 0;
  private deck: IndustryWithWeight[];

  constructor(industriesIn: IndustryWithWeight[]) {
    // Expand by weight: industry with weight=3 appears 3x in the deck
    this.deck = [];
    for (const ind of industriesIn) {
      for (let i = 0; i < ind.weight; i++) this.deck.push(ind);
    }
    // Shuffle deterministically by id to avoid biasing toward insertion order
    this.deck.sort((a, b) => a.id.localeCompare(b.id));
  }

  next(): IndustryWithWeight {
    if (this.deck.length === 0) throw new Error('no industries to rotate');
    const idx = this.cursor % this.deck.length;
    this.cursor++;
    return this.deck[idx]!;
  }
}

export async function planUpcomingWeek(campaignId: string): Promise<PlannerResult> {
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, campaignId),
  });
  if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
  if (!campaign.active) {
    return {
      campaignId,
      itemsCreated: 0,
      byType: {} as Record<ContentType, number>,
      byIndustry: {},
      byLanguage: {} as Record<Language, number>,
    };
  }

  // Resolve campaign industries with weights
  const industryRows = await db
    .select({
      id: industries.id,
      slug: industries.slug,
      name: industries.name,
      description: industries.description,
      visualStyle: industries.visualStyle,
      topicSeeds: industries.topicSeeds,
      createdAt: industries.createdAt,
      weight: campaignIndustries.weight,
    })
    .from(campaignIndustries)
    .innerJoin(industries, eq(industries.id, campaignIndustries.industryId))
    .where(eq(campaignIndustries.campaignId, campaignId));

  if (industryRows.length === 0) {
    throw new Error(`campaign ${campaignId} has no industries assigned`);
  }

  // Apply planner_weight_modifier from analytics feedback loop, if any rows exist.
  // Modifier is a multiplier in [0.5, 2.0] tracked per (industry, content_type, language).
  // We average the modifiers across types for industry-level rotation; the type
  // distribution itself comes from quotas, not weights.
  const modifierRows = await db
    .select({
      industryId: topicPerformance.industryId,
      modifier: topicPerformance.plannerWeightModifier,
    })
    .from(topicPerformance)
    .where(eq(topicPerformance.campaignId, campaignId));

  const industryModifier = new Map<string, number>();
  for (const row of modifierRows) {
    if (!row.industryId) continue;
    const cur = industryModifier.get(row.industryId) ?? { sum: 0, count: 0 };
    if (typeof cur === 'number') continue; // unreachable but TS-narrows
    industryModifier.set(row.industryId, parseFloat(row.modifier) /* upserted later via avg */);
  }

  // Apply modifier to weights — clamp to integers ≥1 for the rotator.
  const weightedIndustries: IndustryWithWeight[] = industryRows.map((ind) => ({
    ...(ind as Industry),
    weight: Math.max(
      1,
      Math.round(ind.weight * (industryModifier.get(ind.id) ?? 1.0))
    ),
  }));

  const rotator = new WeightedRotator(weightedIndustries);

  // Compute existing items already planned for this week — idempotency
  const weekStart = startOfWeek(new Date());
  const existing = await db
    .select({ id: contentItems.id })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.campaignId, campaignId),
        gte(contentItems.plannedForDate, isoDate(weekStart))
      )
    );

  // Compute remaining quota per type
  const targets: Record<ContentType, number> = {
    testimonial: campaign.weeklyTestimonials,
    case_study: campaign.weeklyCaseStudies,
    success_story: 0,
    explainer: campaign.weeklyExplainers,
    educational: campaign.weeklyEducational,
    transformation: 0,
    founder_message: campaign.weeklyFounderMessages,
    industry_insight: campaign.weeklyIndustryInsights,
  };

  // Reduce targets by what's already planned
  if (existing.length > 0) {
    const existingByType = await db
      .select({
        type: contentItems.type,
        count: sql<number>`count(*)::int`,
      })
      .from(contentItems)
      .where(
        and(
          eq(contentItems.campaignId, campaignId),
          gte(contentItems.plannedForDate, isoDate(weekStart))
        )
      )
      .groupBy(contentItems.type);

    for (const row of existingByType) {
      targets[row.type] = Math.max(0, (targets[row.type] ?? 0) - row.count);
    }
  }

  const result: PlannerResult = {
    campaignId,
    itemsCreated: 0,
    byType: {} as Record<ContentType, number>,
    byIndustry: {},
    byLanguage: {} as Record<Language, number>,
  };

  const newItems: NewContentItem[] = [];
  const languages = campaign.languages.length > 0 ? campaign.languages : ['en'];

  // Distribute slots across the 7-day week. Day spread is even-ish.
  let dayOffset = 0;

  for (const type of PLANNED_TYPES) {
    const need = targets[type] ?? 0;
    for (let i = 0; i < need; i++) {
      const industry = rotator.next();
      const language = languages[i % languages.length] as Language;
      const date = new Date(weekStart);
      date.setUTCDate(date.getUTCDate() + (dayOffset % 7));
      dayOffset++;

      newItems.push({
        campaignId,
        industryId: industry.id,
        type,
        language,
        state: 'planned',
        topic: '', // filled by script writer
        plannedForDate: isoDate(date),
        metadata: { plannedBy: 'planner-v1', industrySlug: industry.slug },
      });

      result.byType[type] = (result.byType[type] ?? 0) + 1;
      result.byIndustry[industry.slug] = (result.byIndustry[industry.slug] ?? 0) + 1;
      result.byLanguage[language] = (result.byLanguage[language] ?? 0) + 1;
    }
  }

  if (newItems.length > 0) {
    await db.insert(contentItems).values(newItems);
  }

  result.itemsCreated = newItems.length;
  return result;
}

export async function planAllActiveCampaigns(): Promise<PlannerResult[]> {
  const active = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.active, true));

  const results: PlannerResult[] = [];
  for (const c of active) {
    try {
      results.push(await planUpcomingWeek(c.id));
    } catch (err) {
      results.push({
        campaignId: c.id,
        itemsCreated: 0,
        byType: {} as Record<ContentType, number>,
        byIndustry: { __error: -1 },
        byLanguage: {} as Record<Language, number>,
      });
      console.error(`planner failed for ${c.id}:`, err);
    }
  }
  return results;
}
