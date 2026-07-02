import { describe, it, expect } from 'vitest';
import { resumeMarkdownToHtml, resumePrintDocument } from './resumeHtml';

describe('resumeMarkdownToHtml', () => {
  it('converts headings, bullets, bold, and paragraphs', () => {
    const md = [
      '# Jane Doe',
      'jane@doe.dev | 555-0100',
      '',
      '## Experience',
      '**Senior Engineer — Acme**',
      '2021 - Present',
      '- Cut p99 latency **40%**',
      '* Led a team of 4',
      '',
      'Plain closing paragraph.',
    ].join('\n');
    const html = resumeMarkdownToHtml(md);
    expect(html).toContain('<h1>Jane Doe</h1>');
    expect(html).toContain('<h2>Experience</h2>');
    expect(html).toContain('<strong>Senior Engineer — Acme</strong>');
    expect(html).toContain('<ul><li>Cut p99 latency <strong>40%</strong></li><li>Led a team of 4</li></ul>');
    expect(html).toContain('<p>Plain closing paragraph.</p>');
    // Adjacent non-blank lines join into ONE paragraph with a line break.
    expect(html).toContain('<p><strong>Senior Engineer — Acme</strong><br>2021 - Present</p>');
  });

  it('escapes HTML in the (untrusted) resume text BEFORE formatting', () => {
    const html = resumeMarkdownToHtml('# A <script>alert(1)</script>\n- 5 < 10 & **x > y**');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<li>5 &lt; 10 &amp; <strong>x &gt; y</strong></li>');
  });

  it('handles CRLF input and blank-line separation', () => {
    const html = resumeMarkdownToHtml('para one\r\n\r\npara two');
    expect(html).toContain('<p>para one</p>');
    expect(html).toContain('<p>para two</p>');
  });

  it('returns empty output for empty input', () => {
    expect(resumeMarkdownToHtml('')).toBe('');
  });
});

describe('resumePrintDocument', () => {
  it('wraps the body in a self-contained, script-free, single-style document', () => {
    const doc = resumePrintDocument('# Jane');
    expect(doc).toContain('<!DOCTYPE html>');
    expect(doc).toContain('<h1>Jane</h1>');
    expect(doc).toContain('font-family: Arial');
    expect(doc).not.toContain('<script'); // ATS + CSP: never any script
    expect((doc.match(/<style>/g) ?? []).length).toBe(1);
  });
});
