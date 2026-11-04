export type InlineNode =
	| { type: "text"; text: string }
	| { type: "strong"; children: InlineNode[] }
	| { type: "em"; children: InlineNode[] }
	| { type: "code"; text: string }
	| { type: "link"; href: string; children: InlineNode[] };

export type BlockNode =
	| { type: "heading"; level: 1 | 2 | 3; children: InlineNode[] }
	| { type: "paragraph"; children: InlineNode[] }
	| { type: "list"; ordered: boolean; items: InlineNode[][] }
	| { type: "blockquote"; children: InlineNode[] }
	| { type: "code"; lang: string; text: string };

function safeHref(href: string): string | undefined {
	const trimmed = href.trim();
	if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
	if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
	return undefined;
}

export function parseInline(text: string): InlineNode[] {
	const nodes: InlineNode[] = [];
	const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[([^\]]+)\]\(([^)]+)\))/g;
	let last = 0;
	let match = regex.exec(text);
	while (match !== null) {
		if (match.index > last) {
			nodes.push({ type: "text", text: text.slice(last, match.index) });
		}
		const token = match[0];
		if (token.startsWith("`")) {
			nodes.push({ type: "code", text: token.slice(1, -1) });
		} else if (token.startsWith("**")) {
			nodes.push({
				type: "strong",
				children: parseInline(token.slice(2, -2)),
			});
		} else if (token.startsWith("*")) {
			nodes.push({ type: "em", children: parseInline(token.slice(1, -1)) });
		} else if (match[2] !== undefined && match[3] !== undefined) {
			const href = safeHref(match[3]);
			if (href) {
				nodes.push({
					type: "link",
					href,
					children: parseInline(match[2]),
				});
			} else {
				nodes.push({ type: "text", text: match[2] });
			}
		}
		last = regex.lastIndex;
		match = regex.exec(text);
	}
	if (last < text.length) {
		nodes.push({ type: "text", text: text.slice(last) });
	}
	return nodes;
}

function headingLevel(line: string): 1 | 2 | 3 | undefined {
	if (line.startsWith("### ")) return 3;
	if (line.startsWith("## ")) return 2;
	if (line.startsWith("# ")) return 1;
	return undefined;
}

export function parseMarkdown(source: string): BlockNode[] {
	const blocks: BlockNode[] = [];
	const lines = source.replaceAll("\r\n", "\n").split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (line.startsWith("```")) {
			const lang = line.slice(3).trim();
			const body: string[] = [];
			i += 1;
			while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
				body.push(lines[i] ?? "");
				i += 1;
			}
			if (i < lines.length) i += 1;
			blocks.push({ type: "code", lang, text: body.join("\n") });
			continue;
		}
		const level = headingLevel(line);
		if (level) {
			const text = line.slice(level + 1);
			blocks.push({
				type: "heading",
				level,
				children: parseInline(text),
			});
			i += 1;
			continue;
		}
		if (line.startsWith("> ")) {
			const quoted: string[] = [];
			while (i < lines.length && (lines[i] ?? "").startsWith("> ")) {
				quoted.push((lines[i] ?? "").slice(2));
				i += 1;
			}
			blocks.push({
				type: "blockquote",
				children: parseInline(quoted.join(" ")),
			});
			continue;
		}
		const unordered = /^\s*[-*]\s+/.test(line);
		const ordered = /^\s*\d+\.\s+/.test(line);
		if (unordered || ordered) {
			const items: InlineNode[][] = [];
			const itemRe = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
			while (i < lines.length && itemRe.test(lines[i] ?? "")) {
				items.push(parseInline((lines[i] ?? "").replace(itemRe, "")));
				i += 1;
			}
			blocks.push({ type: "list", ordered, items });
			continue;
		}
		if (line.trim() === "") {
			i += 1;
			continue;
		}
		const para: string[] = [];
		while (
			i < lines.length &&
			(lines[i] ?? "").trim() !== "" &&
			!headingLevel(lines[i] ?? "") &&
			!(lines[i] ?? "").startsWith("```") &&
			!(lines[i] ?? "").startsWith("> ") &&
			!/^\s*[-*]\s+/.test(lines[i] ?? "") &&
			!/^\s*\d+\.\s+/.test(lines[i] ?? "")
		) {
			para.push(lines[i] ?? "");
			i += 1;
		}
		blocks.push({ type: "paragraph", children: parseInline(para.join(" ")) });
	}
	return blocks;
}
