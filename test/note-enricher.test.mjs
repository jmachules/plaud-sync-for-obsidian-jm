import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

const root = process.cwd();
const moduleUrl = pathToFileURL(path.join(root, 'src/note-enricher.ts')).href;
const {enrichMarkdown, parseEnrichSpec} = await import(moduleUrl);

// Generic screening-call template spec (placeholder names only).
const SPEC = {
  markers: ['Contact Profile', '## Engagement Details', 'decision_status', 'Call conducted by'],
  noteKind: 'screening-call',
  nonNoteKind: 'non-screening',
  gapToken: 'NOT CAPTURED',
  gapPhrases: ['NOT CAPTURED / cannot determine from transcript.', 'NOT CAPTURED / cannot determine from transcript', 'NOT CAPTURED'],
  fields: [
    {key: 'contact-name', label: 'Name'},
    {key: 'contact-email', label: 'Email'},
    {key: 'contact-phone', label: 'Phone'},
    {key: 'call-date', label: 'Call date', date: true},
    {key: 'conducted-by', label: 'Call conducted by', link: 'recruiters'},
    {key: 'referred-from', label: 'Referred from'},
    {key: 'target-account', label: 'Target account', link: 'clients'}
  ],
  staticKeys: [{key: 'decision', value: 'NOT SET'}],
  recruiters: {alex: 'alex-doe', sam: 'sam-lee'},
  clients: [{slug: 'acme-corp', match: ['acme', 'akme', 'ACM']}],
  linkLabels: ['Referred by', 'Call conducted by'],
  highlightPhrases: ['Checklist item not restated — §4 process gap', 'No. This is a process gap.'],
  highlightValueLabels: ['Minimum rate'],
  routingToken: 'decision_status: NOT SET',
  contextLinkSlug: 'decision-criteria',
  contextLinkText: 'Provisional decision context',
  gapListLabels: [
    {label: 'Email', describe: 'contact email (unique key)'},
    {label: 'Phone', describe: 'phone'},
    {label: 'Call conducted by', describe: 'call conductor'},
    {label: 'Call date', describe: 'call date'},
    {label: 'Target account', describe: 'target account'},
    {label: 'Referred from', describe: 'referral channel'},
    {label: 'Current rate', describe: 'current rate'},
    {label: 'Minimum rate', describe: 'minimum rate'}
  ],
  processGapPhrase: 'This is a process gap',
  processGapDescribe: '§4 restatement(s)',
  footerTitle: 'Note connections (added automatically at sync — not call content)',
  footerNote: 'automatic deterministic pass at sync'
};

function doc(summary, title = 'Screening call with Jordan') {
  return `---
source: plaud
type: recording
file_id: abc123
title: "${title}"
date: 2026-07-28
duration: 17 min
---

# ${title}

## Summary
${summary}

## Highlights
- No highlights extracted.

## Transcript
Alex: Hello NOT CAPTURED should never be highlighted here.
`;
}

const FULL_SUMMARY = `## Contact Profile
- Name: Jordan Reyes
- Email: NOT CAPTURED (email is the unique key)
- Phone: NOT CAPTURED
## Engagement Details
- Referred by: Alex
- Referred from: NOT CAPTURED
- Call date: 2026-07-28
- Call conducted by: Alex
- Target account: Akme Group, Springfield office.
- Checklist restated?: No
 - If no: flag "Checklist item not restated — §4 process gap"
## Rates
- Current rate (if stated): NOT CAPTURED
- Minimum rate (if stated): "Nothing under one hundred and sixty."
## Decision
- decision_status: NOT SET. The decision is a human call. Do not suggest one here under any circumstance.
## Compliance
- Was the checklist restated at the end of the call? No. This is a process gap.
- Were any live markers flagged? NOT CAPTURED / cannot determine from transcript`;

test('enriches a well-formed note: frontmatter, links, highlights, footer', () => {
  const out = enrichMarkdown(doc(FULL_SUMMARY), SPEC);

  assert.match(out, /^note-kind: screening-call$/m);
  assert.match(out, /^contact-name: "Jordan Reyes"$/m);
  assert.match(out, /^contact-email: NOT CAPTURED$/m);
  assert.match(out, /^contact-phone: NOT CAPTURED$/m);
  assert.match(out, /^call-date: 2026-07-28$/m);
  assert.match(out, /^conducted-by: "\[\[alex-doe\]\]"$/m);
  assert.match(out, /^target-account: "\[\[acme-corp\]\]"$/m);
  assert.match(out, /^decision: NOT SET$/m);
  assert.match(out, /^enriched: \d{4}-\d{2}-\d{2}$/m);
  assert.ok(out.includes('file_id: abc123'));
  assert.ok(out.includes('- Referred by: [[alex-doe|Alex]]'));
  assert.ok(out.includes('- Call conducted by: [[alex-doe|Alex]]'));
  assert.ok(out.includes('- Email: ==NOT CAPTURED== (email is the unique key)'));
  assert.ok(out.includes('=="Checklist item not restated — §4 process gap"=='));
  assert.ok(out.includes('==No. This is a process gap.=='));
  assert.ok(out.includes('==decision_status: NOT SET.== (Provisional decision context: [[decision-criteria]].)'));
  assert.ok(out.includes('- Minimum rate (if stated): =="Nothing under one hundred and sixty."=='));
  assert.ok(out.includes('==NOT CAPTURED / cannot determine from transcript=='));
  assert.ok(out.includes('## Note connections (added automatically at sync — not call content)'));
  assert.match(out, /Gaps flagged: contact email \(unique key\), phone, referral channel, current rate, §4 restatement\(s\)/);
  assert.ok(!out.includes('===='));
  assert.ok(out.includes('Alex: Hello NOT CAPTURED should never be highlighted here.'));
});

test('blank field does not capture the next line and stays a flagged gap', () => {
  const out = enrichMarkdown(doc(FULL_SUMMARY.replace('- Email: NOT CAPTURED (email is the unique key)', '- Email:')), SPEC);

  assert.match(out, /^contact-email: NOT CAPTURED$/m);
  assert.ok(!out.includes('contact-email: "- Phone'));
  assert.match(out, /Gaps flagged: contact email/);
});

test('partial template match (one marker) is left untouched and unstamped', () => {
  const input = doc('## Contact Profile\n- Name: Someone');
  assert.equal(enrichMarkdown(input, SPEC), input);
});

test('marker variations still enrich when two or more match', () => {
  const out = enrichMarkdown(doc(FULL_SUMMARY.replace('## Contact Profile', '## Contact - Profile (mangled)')), SPEC);
  assert.match(out, /^note-kind: screening-call$/m);
});

test('unrelated recording is stamped as non-note-kind only', () => {
  const out = enrichMarkdown(doc('A generic welcome recording about the product.', 'Welcome'), SPEC);

  assert.match(out, /^note-kind: non-screening$/m);
  assert.match(out, /^enriched: \d{4}-\d{2}-\d{2}$/m);
  assert.ok(!out.includes('Note connections'));
  assert.ok(out.includes('A generic welcome recording about the product.'));
});

test('gap-token values never resolve to links and flag their gaps', () => {
  const out = enrichMarkdown(doc(FULL_SUMMARY
    .replace('- Call conducted by: Alex', '- Call conducted by: NOT CAPTURED (probably Alex)')
    .replace('- Target account: Akme Group, Springfield office.', '- Target account: NOT CAPTURED')
    .replace('- Call date: 2026-07-28', '- Call date: NOT CAPTURED')), SPEC);

  assert.match(out, /^conducted-by: NOT CAPTURED$/m);
  assert.ok(!out.includes('conducted-by: "[[alex-doe]]"'));
  assert.match(out, /^target-account: NOT CAPTURED$/m);
  assert.match(out, /^call-date: NOT CAPTURED$/m);
  assert.match(out, /call conductor/);
  assert.match(out, /target account/);
  assert.match(out, /call date/);
});

test('unrecognized account name is kept raw, never fuzzy-mapped', () => {
  const out = enrichMarkdown(doc(FULL_SUMMARY.replace('Akme Group, Springfield office.', 'Trebbin & Associates, Chicago.')), SPEC);
  assert.match(out, /^target-account: "Trebbin & Associates, Chicago\."$/m);
  assert.ok(!out.includes('acme-corp'));
});

test('short all-caps tokens require a standalone capitalized word', () => {
  const hit = enrichMarkdown(doc(FULL_SUMMARY.replace('Akme Group, Springfield office.', 'the ACM account downtown.')), SPEC);
  assert.match(hit, /^target-account: "\[\[acme-corp\]\]"$/m);

  const miss = enrichMarkdown(doc(FULL_SUMMARY.replace('Akme Group, Springfield office.', 'the acm account downtown.')), SPEC);
  assert.match(miss, /^target-account: "the acm account downtown\."$/m);
});

test('curly quotes and ascii dash are tolerated in highlight phrases', () => {
  const out = enrichMarkdown(doc(FULL_SUMMARY.replace(
    '"Checklist item not restated — §4 process gap"',
    '“Checklist item not restated - §4 process gap”'
  )), SPEC);
  assert.ok(/==“Checklist item not restated - §4 process gap”==/.test(out));
});

test('gap token mid-value: no nested highlights, gap still flagged', () => {
  const out = enrichMarkdown(doc(FULL_SUMMARY.replace(
    '- Minimum rate (if stated): "Nothing under one hundred and sixty."',
    '- Minimum rate (if stated): Declined to state — NOT CAPTURED'
  )), SPEC);
  assert.ok(!out.includes('===='));
  assert.match(out, /minimum rate/);
});

test('full-value body link wraps composite names', () => {
  const out = enrichMarkdown(doc(FULL_SUMMARY.replace('- Call conducted by: Alex', '- Call conducted by: Doe, Alex')), SPEC);
  assert.ok(out.includes('- Call conducted by: [[alex-doe|Doe, Alex]]'));
  assert.match(out, /^conducted-by: "\[\[alex-doe\]\]"$/m);
});

test('values containing wikilink syntax are never wrapped in body links', () => {
  const out = enrichMarkdown(doc(FULL_SUMMARY.replace('- Call conducted by: Alex', '- Call conducted by: Alex [[x]]')), SPEC);
  assert.ok(!out.includes('- Call conducted by: [[alex-doe|Alex [[x]]]]'));
});

test('missing Highlights section is a strict no-op', () => {
  const input = doc(FULL_SUMMARY).replace('\n## Highlights\n- No highlights extracted.', '');
  assert.equal(enrichMarkdown(input, SPEC), input);
});

test('duplicated Highlights heading (anchor ambiguity) is a strict no-op', () => {
  const input = doc(FULL_SUMMARY.replace('## Rates', '## Highlights\n## Rates'));
  assert.equal(enrichMarkdown(input, SPEC), input);
});

test('input without frontmatter passes through unchanged', () => {
  assert.equal(enrichMarkdown('hello world', SPEC), 'hello world');
});

// ---- parseEnrichSpec ----

const VALID_CONFIG = `---
name: enrichment-config
---
# Config

\`\`\`json
${JSON.stringify({
  markers: SPEC.markers,
  noteKind: SPEC.noteKind,
  nonNoteKind: SPEC.nonNoteKind,
  gapToken: SPEC.gapToken,
  gapPhrases: SPEC.gapPhrases,
  fields: SPEC.fields,
  staticKeys: SPEC.staticKeys,
  recruiters: SPEC.recruiters,
  clients: SPEC.clients,
  linkLabels: SPEC.linkLabels,
  highlightPhrases: SPEC.highlightPhrases,
  highlightValueLabels: SPEC.highlightValueLabels,
  routingToken: SPEC.routingToken,
  contextLinkSlug: SPEC.contextLinkSlug,
  contextLinkText: SPEC.contextLinkText,
  gapListLabels: SPEC.gapListLabels,
  processGapPhrase: SPEC.processGapPhrase,
  processGapDescribe: SPEC.processGapDescribe,
  footerTitle: SPEC.footerTitle,
  footerNote: SPEC.footerNote
}, null, 2)}
\`\`\`
`;

test('parseEnrichSpec reads a fenced json block and round-trips through enrichMarkdown', () => {
  const spec = parseEnrichSpec(VALID_CONFIG);
  assert.ok(spec);
  assert.equal(spec.recruiters.alex, 'alex-doe');
  assert.equal(spec.clients.length, 1);

  const out = enrichMarkdown(doc(FULL_SUMMARY), spec);
  assert.match(out, /^conducted-by: "\[\[alex-doe\]\]"$/m);
});

test('parseEnrichSpec rejects malformed json, wrong shapes, and oversized configs', () => {
  assert.equal(parseEnrichSpec('```json\n{ broken\n```'), null);
  assert.equal(parseEnrichSpec('```json\n{"recruiters": "nope"}\n```'), null);
  assert.equal(parseEnrichSpec('```json\n[]\n```'), null);
  assert.equal(parseEnrichSpec(''), null);
  assert.equal(parseEnrichSpec('x'.repeat(70000)), null);
});

test('parseEnrichSpec requires the core template contract', () => {
  const withoutFields = VALID_CONFIG.replace('"fields"', '"fields_gone"');
  assert.equal(parseEnrichSpec(withoutFields), null);
  const withoutMarkers = VALID_CONFIG.replace('"markers"', '"markers_gone"');
  assert.equal(parseEnrichSpec(withoutMarkers), null);
});

test('parseEnrichSpec enforces the slug allowlist on links', () => {
  const badRecruiter = VALID_CONFIG.replace('"alex-doe"', '"x]] injected [[y"');
  assert.equal(parseEnrichSpec(badRecruiter), null);
  const badClient = VALID_CONFIG.replace('"acme-corp"', '"Acme Corp!"');
  assert.equal(parseEnrichSpec(badClient), null);
});

test('enrichment output preserves the file_id contract used for upsert matching', () => {
  const out = enrichMarkdown(doc(FULL_SUMMARY), SPEC);
  assert.ok(out.startsWith('---\n'));
  const closing = out.indexOf('\n---\n', 4);
  const frontmatter = out.slice(4, closing);
  assert.match(frontmatter, /^file_id: abc123$/m);
});
