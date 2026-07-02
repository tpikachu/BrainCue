// Pure markdown→HTML for the tailored-resume PDF. DELIBERATELY minimal — the
// simplicity IS the ATS feature: single column, standard headings, plain bullets,
// no tables/images/links/scripts. Kept dependency-free and separate from the
// Electron glue (resumePdf.ts) so it's unit-testable.

/** Escape text for safe embedding in HTML (the LLM output is untrusted text). */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `**bold**` → <strong> (applied AFTER escaping; no other inline markup). */
function inline(s: string): string {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** Convert the tailored resume's markdown subset to clean, linear HTML:
 *  # / ## / ### headings, - or * bullets, blank-line paragraphs, **bold**. */
export function resumeMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let list: string[] = [];
  let para: string[] = [];

  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${li}</li>`).join('')}</ul>`);
    list = [];
  };
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
    para = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!line) {
      flushList();
      flushPara();
    } else if (heading) {
      flushList();
      flushPara();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (bullet) {
      flushPara();
      list.push(inline(bullet[1]));
    } else {
      flushList();
      para.push(inline(line));
    }
  }
  flushList();
  flushPara();
  return out.join('\n');
}

/** Wrap the converted body in a self-contained, ATS-friendly print document:
 *  standard fonts, black on white, single column, one inline <style>, no scripts. */
export function resumePrintDocument(markdown: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.35;
         color: #000; background: #fff; max-width: 7.5in; margin: 0 auto; }
  h1 { font-size: 18pt; margin: 0 0 2pt; }
  h2 { font-size: 13pt; margin: 14pt 0 4pt; border-bottom: 1px solid #000; padding-bottom: 2pt; }
  h3 { font-size: 11.5pt; margin: 10pt 0 2pt; }
  p  { margin: 0 0 6pt; }
  ul { margin: 0 0 8pt 18pt; padding: 0; }
  li { margin: 0 0 3pt; }
</style>
</head>
<body>
${resumeMarkdownToHtml(markdown)}
</body>
</html>`;
}
