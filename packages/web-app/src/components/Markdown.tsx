import { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlightCode, highlightSync } from "@/lib/highlight";
import { closeUnclosedFences, escapeHtml, safeHref } from "@/lib/markdown";
import { cn } from "@/lib/utils";

function HighlightedCode({
	lang,
	code,
}: {
	lang: string | undefined;
	code: string;
}) {
	const sync = highlightSync(lang, code);
	const [asyncHtml, setAsyncHtml] = useState<{
		lang: string | undefined;
		code: string;
		html: string;
	} | null>(null);

	useEffect(() => {
		if (highlightSync(lang, code) !== null) return;
		let cancelled = false;
		highlightCode(lang, code)
			.then((next) => {
				if (!cancelled) setAsyncHtml({ lang, code, html: next });
			})
			.catch(() => {
				if (!cancelled) setAsyncHtml({ lang, code, html: escapeHtml(code) });
			});
		return () => {
			cancelled = true;
		};
	}, [code, lang]);

	const cached = asyncHtml;
	const matchedAsync =
		cached !== null && cached.lang === lang && cached.code === code
			? cached.html
			: null;
	const html = sync ?? matchedAsync ?? escapeHtml(code);

	return (
		<code
			className="hljs font-mono text-[length:var(--fs-sm)]"
			// highlight.js emits escaped text plus token spans
			// biome-ignore lint/security/noDangerouslySetInnerHtml: highlighter output is escaped
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

const components: Components = {
	h1: ({ children }) => <h1 className="cadmus-md-h1">{children}</h1>,
	h2: ({ children }) => <h2 className="cadmus-md-h2">{children}</h2>,
	h3: ({ children }) => <h3 className="cadmus-md-h3">{children}</h3>,
	h4: ({ children }) => <h4 className="cadmus-md-h3">{children}</h4>,
	p: ({ children }) => <p className="cadmus-md-p">{children}</p>,
	blockquote: ({ children }) => (
		<blockquote className="cadmus-md-quote">{children}</blockquote>
	),
	ul: ({ children }) => <ul className="cadmus-md-ul">{children}</ul>,
	ol: ({ children }) => <ol className="cadmus-md-ol">{children}</ol>,
	li: ({ children }) => <li className="cadmus-md-li">{children}</li>,
	table: ({ children }) => (
		<div className="cadmus-md-table-wrap">
			<table className="cadmus-md-table">{children}</table>
		</div>
	),
	a: ({ href, children }) => {
		const safe = safeHref(href);
		if (!safe) return <span>{children}</span>;
		return (
			<a href={safe} target="_blank" rel="noopener noreferrer">
				{children}
			</a>
		);
	},
	pre: ({ children }) => <pre className="cadmus-md-pre">{children}</pre>,
	code: ({ className, children }) => {
		const raw = String(children);
		const isBlock = Boolean(className) || raw.endsWith("\n");
		const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
		const text = raw.replace(/\n$/, "");
		if (isBlock) {
			return <HighlightedCode lang={lang} code={text} />;
		}
		return <code className="cadmus-md-inline-code">{text}</code>;
	},
};

export function Markdown({
	source,
	variant = "default",
	className,
}: {
	source: string;
	variant?: "default" | "onAccent";
	className?: string;
}) {
	const markdown = closeUnclosedFences(source);
	return (
		<div
			className={cn(
				"cadmus-md text-[length:var(--fs-md)]",
				variant === "onAccent" && "cadmus-md--on-accent",
				className,
			)}
		>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				skipHtml
				urlTransform={(url) => safeHref(url) ?? ""}
				components={components}
			>
				{markdown}
			</ReactMarkdown>
		</div>
	);
}
