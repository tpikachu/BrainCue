import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOUR_STEPS } from './Tour';

/**
 * The tour points at things. This checks the things still exist.
 *
 * A step whose `data-tour` anchor has been renamed or deleted does not throw —
 * it silently falls back to a centered card, so the tour keeps "working" while
 * quietly describing a nav item that spotlights nothing. That is the same rot
 * that broke the screenshot capture, which went on clicking "Interview" /
 * "Mock" / "Reports" long after those entries were removed.
 *
 * Renderer components have no test harness here (no jsdom), so this reads the
 * source for anchors rather than rendering. It is a rot guard, not a unit test.
 */

const RENDERER = join(process.cwd(), 'src', 'renderer');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return walk(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

/** Every anchor the renderer defines, in either shape it is written in:
 *  `data-tour="x"` directly, or `tour: 'x'` / `tour="x"` on a nav/card item
 *  that renders one. */
const anchors = new Set<string>();
for (const file of walk(RENDERER)) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/data-tour=["'{`]*([a-z0-9-]+)/gi)) anchors.add(m[1]);
  for (const m of src.matchAll(/\btour[:=]\s*["'{`]+([a-z0-9-]+)/gi)) anchors.add(m[1]);
}

describe('the guided tour', () => {
  it('only spotlights anchors that exist in the app', () => {
    const targets = TOUR_STEPS.map((s) => s.target).filter((t): t is string => !!t);
    expect(targets.length, 'a tour of only centered cards is a slideshow').toBeGreaterThan(4);
    const missing = [...new Set(targets)].filter((t) => !anchors.has(t));
    expect(
      missing,
      'these steps point at a data-tour anchor no component renders any more',
    ).toEqual([]);
  });

  it('would notice an anchor that was renamed away', () => {
    // Guards the guard: if the scan above ever matched nothing, `missing` would
    // still be empty and the suite would pass while checking nothing at all.
    expect(anchors.size).toBeGreaterThan(5);
    expect(anchors.has('nav-home')).toBe(true);
    expect(anchors.has('not-a-real-anchor')).toBe(false);
  });

  it('only navigates to routes the app registers', () => {
    // A step now takes you to the page before ringing the card on it, so a
    // typo'd or retired route lands the user on a blank screen mid-tour with
    // the spotlight fixed to nothing.
    const app = readFileSync(join(RENDERER, 'dashboard', 'App.tsx'), 'utf8');
    const routes = new Set([...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]));
    const used = [...new Set(TOUR_STEPS.map((s) => s.route).filter((r): r is string => !!r))];
    expect(used.length, 'no step navigates — the tour is spotlighting nav items again').toBeGreaterThan(3);
    expect(used.filter((r) => !routes.has(r))).toEqual([]);
  });

  it('points at components, not just at the sidebar', () => {
    // The whole upgrade: highlighting "Library" in the nav says where to click
    // and nothing about what is there. A tour whose targets are all nav-* has
    // silently regressed to that.
    const targets = TOUR_STEPS.map((s) => s.target).filter((t): t is string => !!t);
    const navOnly = targets.filter((t) => t.startsWith('nav-'));
    expect(navOnly.length).toBeLessThan(targets.length / 2);
  });

  it('reads as chapters, and every step carries real copy', () => {
    const chapters = [...new Set(TOUR_STEPS.map((s) => s.chapter))];
    expect(chapters.length).toBeGreaterThanOrEqual(3);
    // Chapters must be contiguous: the progress ticks assume a step's chapter
    // never reappears after a later one has started.
    const order = TOUR_STEPS.map((s) => chapters.indexOf(s.chapter));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const s of TOUR_STEPS) {
      expect(s.title.length, s.title).toBeGreaterThan(8);
      expect(s.body.length, s.title).toBeGreaterThan(80); // a step worth a click
    }
  });

  it('tells the user the two things that surprise them', () => {
    // Both are consequences rather than features, and both read as bugs when
    // discovered later: a conversation kept with no Space keeps nothing, and
    // long-term memory does nothing until it is switched on.
    const body = TOUR_STEPS.map((s) => s.body).join(' ').toLowerCase();
    expect(body).toMatch(/no space and nothing is summarised|without a space/);
    expect(body).toMatch(/off until you turn it on|off until/);
    // …and where to go when the tour is over.
    expect(body).toMatch(/“\?” in the title bar/);
  });
});
