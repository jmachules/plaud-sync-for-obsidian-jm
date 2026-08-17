/**
 * Optional post-render enrichment for synced recordings.
 *
 * When a vault note (settings: "Enrichment config path") provides an EnrichSpec,
 * rendered markdown that matches a configured note template gets deterministic
 * enrichment at sync time: labeled fields extracted into frontmatter, configured
 * names turned into wikilinks, configured phrases highlighted, and a footer
 * summarizing flagged gaps. Everything is pattern matching against the spec —
 * nothing is inferred, and any unexpected input leaves the markdown untouched.
 *
 * With no config path set (the default) this module does nothing.
 */

export interface EnrichFieldSpec {
	/** Frontmatter key to write. */
	key: string;
	/** Field label as it appears in the summary ("- <label>...: value"). */
	label: string;
	/** Resolve the value to a wikilink via the recruiters map or clients list. */
	link?: 'recruiters' | 'clients';
	/** Emit the value unquoted when it is an ISO date (YYYY-MM-DD). */
	date?: boolean;
}

export interface EnrichClientSpec {
	slug: string;
	match: string[];
}

export interface EnrichSpec {
	/** Substrings identifying the template. >=2 present: enrich; exactly 1: leave untouched (malformed); 0: stamp nonNoteKind. */
	markers: string[];
	noteKind: string;
	nonNoteKind: string;
	/** Token marking an unanswered field (e.g. "NOT CAPTURED"). Matching is case-insensitive. */
	gapToken: string;
	/** Phrases highlighted as gaps, matched longest-listed-first (should include gapToken itself). */
	gapPhrases: string[];
	fields: EnrichFieldSpec[];
	/** Extra frontmatter keys always written verbatim. */
	staticKeys: Array<{key: string; value: string}>;
	/** Match word (case-insensitive, word-bounded) -> note slug. */
	recruiters: Record<string, string>;
	clients: EnrichClientSpec[];
	/** Labels whose body line value is wrapped as [[slug|value]] when a recruiter matches. */
	linkLabels: string[];
	/** Literal phrases to highlight. Straight/curly quotes around them are tolerated; "-" and em-dash are interchangeable. */
	highlightPhrases: string[];
	/** Labels whose whole value is highlighted when it is not a gap. */
	highlightValueLabels: string[];
	/** Token (plus optional trailing period) highlighted and used to anchor the context link. */
	routingToken?: string;
	contextLinkSlug?: string;
	contextLinkText?: string;
	/** Fields reported in the footer gap list when unanswered. */
	gapListLabels: Array<{label: string; describe: string}>;
	/** When this phrase appears in the summary, add processGapDescribe to the gap list. */
	processGapPhrase?: string;
	processGapDescribe?: string;
	footerTitle: string;
	footerNote?: string;
}

const MAX_CONFIG_BYTES = 65536;
const MAX_LIST_ITEMS = 100;
const SLUG_PATTERN = /^[a-z0-9-]+$/;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function asCleanString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown, maxItems: number): string[] | null {
	if (!Array.isArray(value) || value.length > maxItems) {
		return null;
	}

	const items = value.map((item) => asCleanString(item)).filter((item) => item.length > 0);
	return items.length === value.length ? items : null;
}

function readSlug(value: unknown): string {
	const slug = asCleanString(value);
	return SLUG_PATTERN.test(slug) ? slug : '';
}

/**
 * Parse an EnrichSpec from a config note (the first ```json fenced block, or the
 * whole content). Returns null — enrichment disabled — on any validation failure.
 */
export function parseEnrichSpec(content: string): EnrichSpec | null {
	if (typeof content !== 'string' || content.length === 0 || content.length > MAX_CONFIG_BYTES) {
		return null;
	}

	let parsed: unknown;
	try {
		const fenced = content.match(/```json\s*([\s\S]*?)```/);
		parsed = JSON.parse(fenced?.[1] ?? content);
	} catch {
		return null;
	}

	if (!isRecord(parsed)) {
		return null;
	}

	const markers = readStringArray(parsed.markers, MAX_LIST_ITEMS);
	const gapToken = asCleanString(parsed.gapToken);
	const noteKind = readSlug(parsed.noteKind);
	const nonNoteKind = readSlug(parsed.nonNoteKind);
	const footerTitle = asCleanString(parsed.footerTitle);
	if (!markers || markers.length === 0 || !gapToken || !noteKind || !nonNoteKind || !footerTitle) {
		return null;
	}

	const gapPhrases = readStringArray(parsed.gapPhrases, MAX_LIST_ITEMS) ?? [gapToken];

	if (!Array.isArray(parsed.fields) || parsed.fields.length === 0 || parsed.fields.length > MAX_LIST_ITEMS) {
		return null;
	}
	const fields: EnrichFieldSpec[] = [];
	for (const item of parsed.fields) {
		if (!isRecord(item)) {
			return null;
		}
		const key = readSlug(item.key);
		const label = asCleanString(item.label);
		if (!key || !label) {
			return null;
		}
		const link = item.link === 'recruiters' || item.link === 'clients' ? item.link : undefined;
		fields.push({key, label, link, date: item.date === true});
	}

	const staticKeys: Array<{key: string; value: string}> = [];
	if (parsed.staticKeys !== undefined) {
		if (!Array.isArray(parsed.staticKeys) || parsed.staticKeys.length > MAX_LIST_ITEMS) {
			return null;
		}
		for (const item of parsed.staticKeys) {
			if (!isRecord(item)) {
				return null;
			}
			const key = readSlug(item.key);
			const value = asCleanString(item.value);
			if (!key || !value) {
				return null;
			}
			staticKeys.push({key, value});
		}
	}

	const recruiters: Record<string, string> = {};
	if (parsed.recruiters !== undefined) {
		if (!isRecord(parsed.recruiters) || Object.keys(parsed.recruiters).length > MAX_LIST_ITEMS) {
			return null;
		}
		for (const [word, slugValue] of Object.entries(parsed.recruiters)) {
			const slug = readSlug(slugValue);
			if (!word.trim() || !slug) {
				return null;
			}
			recruiters[word.trim()] = slug;
		}
	}

	const clients: EnrichClientSpec[] = [];
	if (parsed.clients !== undefined) {
		if (!Array.isArray(parsed.clients) || parsed.clients.length > MAX_LIST_ITEMS) {
			return null;
		}
		for (const item of parsed.clients) {
			if (!isRecord(item)) {
				return null;
			}
			const slug = readSlug(item.slug);
			const match = readStringArray(item.match, MAX_LIST_ITEMS);
			if (!slug || !match || match.length === 0) {
				return null;
			}
			clients.push({slug, match});
		}
	}

	const gapListLabels: Array<{label: string; describe: string}> = [];
	if (parsed.gapListLabels !== undefined) {
		if (!Array.isArray(parsed.gapListLabels) || parsed.gapListLabels.length > MAX_LIST_ITEMS) {
			return null;
		}
		for (const item of parsed.gapListLabels) {
			if (!isRecord(item)) {
				return null;
			}
			const label = asCleanString(item.label);
			const describe = asCleanString(item.describe);
			if (!label || !describe) {
				return null;
			}
			gapListLabels.push({label, describe});
		}
	}

	const contextLinkSlug = parsed.contextLinkSlug === undefined ? '' : readSlug(parsed.contextLinkSlug);
	if (parsed.contextLinkSlug !== undefined && !contextLinkSlug) {
		return null;
	}

	return {
		markers,
		noteKind,
		nonNoteKind,
		gapToken,
		gapPhrases,
		fields,
		staticKeys,
		recruiters,
		clients,
		linkLabels: readStringArray(parsed.linkLabels, MAX_LIST_ITEMS) ?? [],
		highlightPhrases: readStringArray(parsed.highlightPhrases, MAX_LIST_ITEMS) ?? [],
		highlightValueLabels: readStringArray(parsed.highlightValueLabels, MAX_LIST_ITEMS) ?? [],
		routingToken: asCleanString(parsed.routingToken) || undefined,
		contextLinkSlug: contextLinkSlug || undefined,
		contextLinkText: asCleanString(parsed.contextLinkText) || undefined,
		gapListLabels,
		processGapPhrase: asCleanString(parsed.processGapPhrase) || undefined,
		processGapDescribe: asCleanString(parsed.processGapDescribe) || undefined,
		footerTitle,
		footerNote: asCleanString(parsed.footerNote) || undefined
	};
}

function quoteYaml(value: string): string {
	return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Literal phrase -> regex tolerating straight/curly quotes around it and "-"/em-dash interchange. */
function phrasePattern(phrase: string): RegExp {
	const escaped = escapeRegExp(phrase).replace(/\\?[—-]/g, '[—-]');
	return new RegExp('["“]?' + escaped + '["”]?', 'g');
}

export function enrichMarkdown(markdown: string, spec: EnrichSpec): string {
	try {
		const today = new Date().toISOString().slice(0, 10);
		const frontmatterEnd = markdown.indexOf('\n---\n');
		if (frontmatterEnd < 0) {
			return markdown;
		}

		const markerCount = spec.markers.filter((marker) => markdown.includes(marker)).length;
		if (markerCount === 0) {
			return (
				markdown.slice(0, frontmatterEnd)
				+ `\nnote-kind: ${spec.nonNoteKind}\nenriched: ${today}`
				+ markdown.slice(frontmatterEnd)
			);
		}
		if (markerCount < 2) {
			// Partial template match: likely a malformed note. Leave it untouched (and
			// unstamped) so it stays visible as unprocessed instead of being hidden.
			return markdown;
		}

		const summaryIdx = markdown.indexOf('\n## Summary\n');
		if (summaryIdx < 0) {
			return markdown;
		}
		const highlightsIdx = markdown.indexOf('\n## Highlights\n');
		if (highlightsIdx < summaryIdx) {
			return markdown;
		}
		if (markdown.indexOf('\n## Highlights\n', highlightsIdx + 1) >= 0) {
			// Ambiguous section anchor (a summary imitating the section layout) — bail
			// rather than risk applying replacements to the wrong slice.
			return markdown;
		}

		let summary = markdown.slice(summaryIdx, highlightsIdx);
		const tail = markdown.slice(highlightsIdx);

		const isGap = (value: string): boolean =>
			!value || new RegExp(escapeRegExp(spec.gapToken), 'i').test(value);

		const recruiterFor = (value: string): string => {
			for (const [word, slug] of Object.entries(spec.recruiters)) {
				if (new RegExp('\\b' + escapeRegExp(word) + '\\b', 'i').test(value)) {
					return slug;
				}
			}
			return '';
		};

		const clientFor = (value: string): string => {
			for (const client of spec.clients) {
				for (const token of client.match) {
					const hit = /^[A-Z0-9]{1,4}$/.test(token)
						? new RegExp('\\b' + escapeRegExp(token) + '\\b').test(value)
						: new RegExp(escapeRegExp(token), 'i').test(value);
					if (hit) {
						return client.slug;
					}
				}
			}
			return '';
		};

		const fieldValue = (label: string): string => {
			const match = summary.match(new RegExp('^- ' + escapeRegExp(label) + '[^:\\n]*:[ \\t]*(.+)$', 'm'));
			return match?.[1]?.trim() ?? '';
		};

		const extracted = new Map<string, string>();
		for (const field of spec.fields) {
			extracted.set(field.label, fieldValue(field.label));
		}
		const gapValues = new Map<string, string>();
		for (const gap of spec.gapListLabels) {
			gapValues.set(gap.label, extracted.has(gap.label) ? (extracted.get(gap.label) ?? '') : fieldValue(gap.label));
		}

		// Body links on configured labeled lines: wrap the whole value when a recruiter matches.
		if (spec.linkLabels.length > 0) {
			const labelAlternation = spec.linkLabels.map((label) => escapeRegExp(label)).join('|');
			summary = summary.replace(
				new RegExp('^(- (?:' + labelAlternation + ')[^:\\n]*:[ \\t]*)(.+)$', 'gm'),
				(line: string, prefix: string, value: string) => {
					const trimmed = value.trim();
					if (isGap(trimmed) || /[[\]|]/.test(trimmed)) {
						return line;
					}
					const slug = recruiterFor(trimmed);
					return slug ? `${prefix}[[${slug}|${trimmed}]]` : line;
				}
			);
		}

		if (spec.routingToken) {
			summary = summary.replace(
				new RegExp(escapeRegExp(spec.routingToken) + '\\.?'),
				(token: string) => `==${token}==`
			);
			if (spec.contextLinkSlug && !summary.includes(`[[${spec.contextLinkSlug}]]`)) {
				summary = summary.replace(
					new RegExp('==' + escapeRegExp(spec.routingToken) + '\\.?=='),
					(token: string) => `${token} (${spec.contextLinkText ?? 'Context'}: [[${spec.contextLinkSlug}]].)`
				);
			}
		}

		for (const phrase of spec.highlightPhrases) {
			summary = summary.replace(phrasePattern(phrase), (match: string) => `==${match}==`);
		}

		if (spec.gapPhrases.length > 0) {
			const alternation = spec.gapPhrases.map((phrase) => escapeRegExp(phrase)).join('|');
			summary = summary.replace(new RegExp(alternation, 'g'), (match: string) => `==${match}==`);
		}

		for (const label of spec.highlightValueLabels) {
			const value = gapValues.get(label) ?? extracted.get(label) ?? fieldValue(label);
			if (value && !isGap(value)) {
				summary = summary.replace(
					new RegExp('^(- ' + escapeRegExp(label) + '[^:\\n]*:[ \\t]*)(.+)$', 'm'),
					(_line: string, prefix: string, rest: string) => `${prefix}==${rest}==`
				);
			}
		}

		let frontmatter = `\nnote-kind: ${spec.noteKind}`;
		for (const field of spec.fields) {
			const value = extracted.get(field.label) ?? '';
			if (isGap(value)) {
				frontmatter += `\n${field.key}: ${spec.gapToken}`;
			} else if (field.date && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
				frontmatter += `\n${field.key}: ${value}`;
			} else if (field.link === 'recruiters' && recruiterFor(value)) {
				frontmatter += `\n${field.key}: ${quoteYaml(`[[${recruiterFor(value)}]]`)}`;
			} else if (field.link === 'clients' && clientFor(value)) {
				frontmatter += `\n${field.key}: ${quoteYaml(`[[${clientFor(value)}]]`)}`;
			} else {
				frontmatter += `\n${field.key}: ${quoteYaml(value)}`;
			}
		}
		for (const staticKey of spec.staticKeys) {
			frontmatter += `\n${staticKey.key}: ${staticKey.value}`;
		}
		frontmatter += `\nenriched: ${today}`;

		const gaps: string[] = [];
		for (const gap of spec.gapListLabels) {
			if (isGap(gapValues.get(gap.label) ?? '')) {
				gaps.push(gap.describe);
			}
		}
		if (spec.processGapPhrase && spec.processGapDescribe && summary.includes(spec.processGapPhrase)) {
			gaps.push(spec.processGapDescribe);
		}

		const footer =
			`\n---\n## ${spec.footerTitle}\n`
			+ `- Gaps flagged: ${gaps.length > 0 ? gaps.join(', ') : 'none'}\n`
			+ `- Enriched: ${today}${spec.footerNote ? ` (${spec.footerNote})` : ''}\n`;

		return (
			markdown.slice(0, frontmatterEnd)
			+ frontmatter
			+ markdown.slice(frontmatterEnd, summaryIdx)
			+ summary
			+ tail
			+ footer
		);
	} catch {
		return markdown;
	}
}
