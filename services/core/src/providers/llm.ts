import OpenAI from 'openai';
import type {
  CaptionInput,
  CaptionOutput,
  LlmProvider,
  ScriptInput,
  ScriptOutput,
} from './types.js';
import { env } from '../env.js';

// ============================================================================
// MOCK
// ============================================================================

const HOOK_TEMPLATES = [
  'You won\'t believe what happened when {role} tried this',
  'Most {industry} owners get this completely wrong',
  'The #1 mistake {industry} make every single week',
  'Here\'s what nobody tells you about running a {industry}',
  'I helped a {industry} double their revenue in 90 days',
];

const TOPIC_TEMPLATES: Record<string, string[]> = {
  testimonial: [
    'How {seed} transformed {industry}',
    '{industry} owner shares the unexpected win from {seed}',
    'From skeptical to obsessed: a {industry} story about {seed}',
  ],
  case_study: [
    'How a {industry} doubled {seed} in 90 days',
    'The {seed} playbook that fixed a struggling {industry}',
    'Behind the numbers: {industry} {seed} breakthrough',
  ],
  success_story: [
    'The {industry} {seed} comeback nobody saw coming',
    'From burnout to breakthrough: {industry} fixes {seed}',
  ],
  explainer: [
    'Why {seed} matters for every {industry}',
    '{seed} explained in 30 seconds for {industry}',
  ],
  educational: [
    '3 things every {industry} should know about {seed}',
    'The {seed} fundamentals most {industry} skip',
  ],
  transformation: [
    'Before / after: {industry} fixes {seed}',
    'The {seed} transformation that changed everything for this {industry}',
  ],
  founder_message: [
    'Why I built this for {industry} struggling with {seed}',
    'A note to every {industry} stuck on {seed}',
  ],
  industry_insight: [
    'What 100 {industry} taught me about {seed}',
    'The {seed} trend reshaping {industry} this year',
  ],
};

function pick<T>(arr: T[], seed: number): T {
  if (arr.length === 0) throw new Error('cannot pick from empty array');
  return arr[seed % arr.length] as T;
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class MockLlm implements LlmProvider {
  readonly mode = 'mock' as const;

  async generateScript(input: ScriptInput): Promise<ScriptOutput> {
    await delay(150 + Math.random() * 250);

    const seed = djb2(
      input.type +
        input.industryName +
        input.language +
        Date.now().toString().slice(-4) +
        (input.rejectionReason ?? '')
    );

    const seedTopics = input.industrySeeds.length
      ? input.industrySeeds
      : ['growth', 'retention', 'lead generation'];
    const seedTopic = pick(seedTopics, seed);

    let attempt = 0;
    let topic: string;
    do {
      const template = pick(TOPIC_TEMPLATES[input.type] ?? TOPIC_TEMPLATES.explainer!, seed + attempt);
      topic = template
        .replaceAll('{industry}', input.industryName.toLowerCase())
        .replaceAll('{seed}', seedTopic);
      attempt++;
    } while (input.recentTopics.includes(topic) && attempt < 5);

    const hookTemplate = pick(HOOK_TEMPLATES, seed);
    const hook = hookTemplate
      .replaceAll('{industry}', input.industryName.toLowerCase())
      .replaceAll('{role}', input.industryName.toLowerCase());

    const cta = input.brandCta ?? 'Follow for more.';

    const script = [
      hook,
      '',
      `Here's what most ${input.industryName.toLowerCase()} get wrong about ${seedTopic}:`,
      `they treat it as a one-time fix instead of a system.`,
      ``,
      `In 90 days we rebuilt this around three moves: identify the leak, plug it with a process, then automate.`,
      ``,
      `The result — measurable lift in week three.`,
      ``,
      cta,
    ].join('\n');

    return {
      topic,
      hook,
      script,
      cta,
      durationSeconds: 30 + (seed % 16),
    };
  }

  async generateCaptions(input: CaptionInput): Promise<CaptionOutput> {
    await delay(100);
    const baseTags = ['smallbusiness', 'growth', 'marketing', 'entrepreneur'];
    const industryTag = input.industry.toLowerCase().replace(/[^a-z]/g, '');
    const tags = [industryTag, ...baseTags].slice(0, 6);

    const igCaption = `${input.hook}\n\n${input.script.split('\n').slice(2, 4).join(' ')}\n\n${input.brandCta ?? 'Follow for more →'}`;
    const ttCaption = `${input.hook} ${input.brandCta ?? '👇'}`;

    return {
      instagram: { caption: igCaption, hashtags: tags },
      tiktok: { caption: ttCaption, hashtags: tags.slice(0, 4) },
    };
  }

  async embed(text: string): Promise<number[]> {
    await delay(20);
    // Deterministic pseudo-embedding for dedup demo. Real LLM uses 1536 dims.
    const seed = djb2(text);
    const v = new Array(1536);
    let s = seed;
    for (let i = 0; i < 1536; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      v[i] = (s / 0x7fffffff) * 2 - 1;
    }
    // Normalize for cosine
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    return v.map((x) => x / norm);
  }
}

// ============================================================================
// REAL — OpenAI
// ============================================================================

export class OpenAiLlm implements LlmProvider {
  readonly mode = 'real' as const;
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async generateScript(input: ScriptInput): Promise<ScriptOutput> {
    const systemPrompt = `You write short-form vertical video scripts for ${input.industryName}.
Brand voice: ${input.brandVoice ?? 'direct, conversational, useful'}.
Output strict JSON: { "topic": string, "hook": string, "script": string, "cta": string, "durationSeconds": number (15-45) }.
The script must read aloud in the durationSeconds at normal pace (~150 wpm).
Avoid topics already covered: ${input.recentTopics.slice(0, 10).join(' | ') || '(none)'}.
${input.rejectionReason ? `Previous attempt was rejected because: ${input.rejectionReason}. Try a different angle.` : ''}`;

    const userPrompt = `Type: ${input.type}
Language: ${input.language}
Industry seeds: ${input.industrySeeds.join(', ')}
CTA: ${input.brandCta ?? 'follow for more'}`;

    const response = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned empty response');
    return JSON.parse(content) as ScriptOutput;
  }

  async generateCaptions(input: CaptionInput): Promise<CaptionOutput> {
    const prompt = `Generate platform-optimized captions for this ${input.type} video about ${input.industry}.
Hook: ${input.hook}
Script summary: ${input.script.slice(0, 300)}
CTA: ${input.brandCta ?? 'follow for more'}
Language: ${input.language}

Output strict JSON:
{ "instagram": { "caption": string (max 220 chars, with line breaks), "hashtags": string[] (5-7 tags, no #) },
  "tiktok": { "caption": string (max 150 chars), "hashtags": string[] (3-4 tags, no #) } }`;

    const response = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned empty response');
    return JSON.parse(content) as CaptionOutput;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return response.data[0]!.embedding;
  }
}

// ============================================================================
// SELECTOR
// ============================================================================

export function createLlmProvider(): LlmProvider {
  if (env.DEMO_MODE || !env.OPENAI_API_KEY) return new MockLlm();
  return new OpenAiLlm(env.OPENAI_API_KEY);
}
