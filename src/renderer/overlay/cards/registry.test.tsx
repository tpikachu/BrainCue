import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ContributionKind } from '@shared/types';
import { makeCard, type CardModel } from './model';
import { cardDefinition, isKnownKind } from './registry';
import { ContributionCard } from './ContributionCard';

/** Every kind the engine can emit today or in the planned modes. */
const ALL_KINDS: ContributionKind[] = [
  'answer',
  'code',
  'context',
  'action_item',
  'open_question',
  'suggested_question',
  'coverage',
  'warning',
  'tutor_prompt',
  'memory_suggestion',
  'summary',
];

const noop = () => {};

function render(card: CardModel, over: Partial<Parameters<typeof ContributionCard>[0]> = {}) {
  return renderToStaticMarkup(
    <ContributionCard
      card={card}
      isCurrent
      live
      paused={false}
      copied={false}
      openCite={null}
      onToggleCite={noop}
      onToggleCollapsed={noop}
      onCopy={noop}
      onRegenerate={noop}
      onRemove={noop}
      {...over}
    />,
  );
}

describe('every contribution kind renders (smoke)', () => {
  for (const kind of ALL_KINDS) {
    it(`renders a completed '${kind}' card with its body`, () => {
      const card = {
        ...makeCard(1, 'c1', kind, `A ${kind} title`),
        body: `The ${kind} body text.`,
        streaming: false,
      };
      const html = render(card);
      expect(html).toContain(`A ${kind} title`);
      expect(html).toContain(`The ${kind} body text.`);
    });
  }

  it('answer/code cards keep the v1 "Q:" title prefix; other kinds get a chip', () => {
    expect(render({ ...makeCard(1, 'c1', 'answer', 'Why hashmaps?') })).toContain('Q: Why hashmaps?');
    expect(render({ ...makeCard(2, 'c2', 'code', 'Coding problem') })).toContain('Q: Coding problem');
    const summary = render({ ...makeCard(3, 'c3', 'summary', 'So far'), body: 'x' });
    expect(summary).toContain('Summary');
    expect(summary).not.toContain('Q: So far');
  });

  it('a collapsed card hides its body', () => {
    const html = render({
      ...makeCard(1, 'c1', 'answer', 'Q1'),
      body: 'hidden body',
      collapsed: true,
      streaming: false,
    });
    expect(html).toContain('Q1');
    expect(html).not.toContain('hidden body');
  });
});

describe('unknown future kinds fall back safely', () => {
  it('renders the fallback card (raw kind chip + plain-text body) instead of crashing', () => {
    const card = {
      ...makeCard(9, 'c9', 'galactic_forecast', 'From a newer main process'),
      body: 'Body from the future.',
      streaming: false,
    };
    const html = render(card);
    expect(html).toContain('galactic_forecast'); // the raw kind is surfaced as the chip
    expect(html).toContain('From a newer main process');
    expect(html).toContain('Body from the future.');
  });

  it('unknown kinds get no regenerate affordance', () => {
    expect(isKnownKind('galactic_forecast')).toBe(false);
    expect(cardDefinition('galactic_forecast').capabilities.regenerate).toBe(false);
  });
});

describe('capabilities are explicit per kind (no boolean soup)', () => {
  it('answer regenerates via the pipeline; code re-solves; warnings do neither', () => {
    expect(cardDefinition('answer').capabilities.regenerate).toEqual({
      tooltip: 'Regenerate this answer',
    });
    expect(cardDefinition('code').capabilities.regenerate).toEqual({
      tooltip: 'Re-solve this problem',
    });
    expect(cardDefinition('warning').capabilities.regenerate).toBe(false);
    expect(cardDefinition('warning').capabilities.copy).toBe(false);
  });

  it('the ↻ button appears only for kinds that declare it', () => {
    const answer = render({ ...makeCard(1, 'c1', 'answer', 'Q'), body: 'A', streaming: false });
    expect(answer).toContain('Regenerate this answer');
    const summary = render({ ...makeCard(2, 'c2', 'summary', 'S'), body: 'B', streaming: false });
    expect(summary).not.toContain('Regenerate');
  });
});

describe('answer-card annotations (v1 parity)', () => {
  const context = {
    questionId: 'c1',
    question: 'Tell me about the migration?',
    chunks: [
      { id: 'k1', sourceType: 'resume', content: 'Led the DB migration at Acme', score: 0.82 },
      { id: 'k2', sourceType: 'story', content: 'Migration story\nS…\nT…\nA…\nR…', score: 0.71 },
    ],
  } as CardModel['context'];

  it('renders the predicted follow-up only after streaming ends', () => {
    const base = { ...makeCard(1, 'c1', 'answer', 'Q'), body: 'A.', followup: 'And the rollback?' };
    expect(render({ ...base, streaming: true })).not.toContain('Likely follow-up:');
    const done = render({ ...base, streaming: false });
    expect(done).toContain('Likely follow-up:');
    expect(done).toContain('And the rollback?');
  });

  it('renders [n] citation chips and the story cue from retrieved context', () => {
    const html = render({
      ...makeCard(1, 'c1', 'answer', 'Q'),
      body: 'I led that migration [1].',
      context,
      streaming: false,
    });
    expect(html).toContain('📎 Sources:');
    expect(html).toContain('[1] resume');
    expect(html).toContain('📖 Story to tell:');
    expect(html).toContain('Migration story');
  });

  it('streaming cursor shows while streaming', () => {
    expect(render({ ...makeCard(1, 'c1', 'answer', 'Q'), body: 'partial' })).toContain('▋');
  });
});
