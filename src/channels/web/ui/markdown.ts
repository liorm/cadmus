/** Escape, then `**bold**`, `` `code` ``, and newlines. */
export function renderMarkdown(text: string): string {
	const escaped = text.replace(/[&<>]/g, (char) =>
		char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;",
	);
	return escaped
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/\n/g, "<br>");
}
