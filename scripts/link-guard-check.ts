// Regression check for lib/linkGuard — run with: npx tsx scripts/link-guard-check.ts
// Keeps the LINK_RE behavior locked in (both this package and the client's
// ForumPostDetail.jsx copy use the same pattern).
import { containsLink, stripLinks } from '../src/lib/linkGuard';

const cases: [string, boolean][] = [
  // Link formats that must match
  ['check https://www.google.com/', true],
  ['http://example.com', true],
  ['visit www.example.com/page?q=1', true],
  ['go to example.co.in', true],
  ['https://sub.domain.co.uk/path/to/page', true],
  ['www.example.com', true],
  // Things that must NOT match
  ['hello world', false],
  ['no links in here', false],
  ['see my file.txt', false], // dot+3 letters but single label, not a domain
];

for (const [text, expected] of cases) {
  const got = containsLink(text);
  if (got !== expected) {
    console.error(`FAIL ${JSON.stringify(text)}: expected ${expected}, got ${got}`);
    process.exit(1);
  }
}

const stripChecks: [string, string][] = [
  ['check https://www.google.com/ now', 'check [link removed] now'],
  ['see www.example.com and example.co.in', 'see [link removed] and [link removed]'],
  ['no links in here', 'no links in here'], // untouched when not a match
];

for (const [input, expected] of stripChecks) {
  const got = stripLinks(input);
  if (got !== expected) {
    console.error(`FAIL strip ${JSON.stringify(input)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    process.exit(1);
  }
}

console.log('link-guard-check OK');
