// Regression check for lib/phoneGuard — run with: npx tsx scripts/phone-guard-check.ts
// Keeps the PHONE_RE behavior locked in (both this package and the client's
// ForumPostDetail.jsx copy use the same pattern).
import { containsPhoneNumber, stripPhoneNumbers } from '../src/lib/phoneGuard';

const cases: [string, boolean][] = [
  // Indian mobile formats that must match
  ['call me 9876543210', true],
  ['+919876543210', true],
  ['09876543210', true],
  ['98765 43210', true],
  ['987-654-3210', true],
  ['91234 56789', true],
  ['987 654 3210', true],
  ['number at line end\n9876543210', true],
  // Things that must NOT match
  ['hello world', false],
  ['1234567890', false], // starts with 1
  ['12345678901', false], // 11 digits
  ['98765\n43210', false], // split across a line break — separators are space/tab/dash only
  ['9 8 7 6 5 4 3 2 1 0', false], // fully spaced out — first 3 digits must be consecutive (same on client)
];

for (const [text, expected] of cases) {
  const got = containsPhoneNumber(text);
  if (got !== expected) {
    console.error(`FAIL ${JSON.stringify(text)}: expected ${expected}, got ${got}`);
    process.exit(1);
  }
}

const stripChecks: [string, string][] = [
  ['call me 9876543210 thanks', 'call me [phone number removed] thanks'],
  ['a 9876543210 b 98765 43210 c', 'a [phone number removed] b [phone number removed] c'],
  ['call me 98765\n43210 thanks', 'call me 98765\n43210 thanks'], // untouched when not a match
];

for (const [input, expected] of stripChecks) {
  const got = stripPhoneNumbers(input);
  if (got !== expected) {
    console.error(`FAIL strip ${JSON.stringify(input)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    process.exit(1);
  }
}

console.log('phone-guard-check OK');
