import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// The privacy policy exists twice: public/privacy.html is what /privacy
// serves, and docs/privacy.md is what the iOS app and the README have linked
// to for a long time. The two once drifted a month apart without anyone
// noticing, and the markdown copy's own header says the only rule that keeps
// them honest: change both, and keep the dates equal. Nothing checked it.
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

describe('the two copies of the privacy policy', () => {
  const md = read('docs/privacy.md');
  const html = read('public/privacy.html');
  const copies = [['docs/privacy.md', md], ['public/privacy.html', html]] as const;

  it('carry the same "Last updated" date', () => {
    const DATE = '([A-Z][a-z]+ \\d{1,2}, \\d{4})';
    const mdDate = new RegExp(`^_Last updated: ${DATE}_$`, 'm').exec(md)?.[1];
    const htmlDate = new RegExp(`<p class="updated">Last updated: ${DATE}</p>`).exec(html)?.[1];
    expect(mdDate, 'docs/privacy.md has no "Last updated" line').toBeTruthy();
    expect(Number.isNaN(Date.parse(mdDate!)), `${mdDate} is not a date`).toBe(false);
    expect(htmlDate).toBe(mdDate);
  });

  // 1.7.0 sends what each subagent was asked to do, and the server can put
  // that label in the card's line, the timeline and a push. A policy that
  // stopped saying so — in either copy — would understate what leaves the
  // machine.
  it('both say what is sent about subagents, and what minimal mode sends instead', () => {
    for (const [name, text] of copies) {
      expect(text, `${name} does not mention subagents`).toMatch(/\bsubagents?\b/);
      expect(text, `${name} does not say a subagent's task description is sent`).toContain('task description');
      expect(text, `${name} does not say a label can reach the card's line and a push`).toContain('"Needs approval:');
      expect(text, `${name} does not say minimal mode numbers subagents`).toContain('"Subagent 1"');
    }
  });
});
