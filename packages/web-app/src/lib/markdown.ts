const SAFE_HREF = /^(https?:|mailto:)/i;

export function safeHref(href: string | undefined): string | undefined {
	if (!href) return undefined;
	const trimmed = href.trim();
	if (SAFE_HREF.test(trimmed)) return trimmed;
	if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
	return undefined;
}

export function closeUnclosedFences(source: string): string {
	const lines = source.replaceAll("\r\n", "\n").split("\n");
	let open = false;
	for (const line of lines) {
		if (line.startsWith("```")) open = !open;
	}
	if (!open) return source;
	return source.endsWith("\n") ? `${source}\`\`\`\n` : `${source}\n\`\`\`\n`;
}

export function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
