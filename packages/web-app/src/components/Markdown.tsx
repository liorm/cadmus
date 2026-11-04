import {
	type BlockNode,
	type InlineNode,
	parseMarkdown,
} from "@/lib/parse-markdown";

function InlineView({ nodes }: { nodes: InlineNode[] }) {
	return (
		<>
			{nodes.map((node, i) => {
				const key = `${node.type}-${i}`;
				if (node.type === "text") return <span key={key}>{node.text}</span>;
				if (node.type === "code") return <code key={key}>{node.text}</code>;
				if (node.type === "strong") {
					return (
						<strong key={key}>
							<InlineView nodes={node.children} />
						</strong>
					);
				}
				if (node.type === "em") {
					return (
						<em key={key}>
							<InlineView nodes={node.children} />
						</em>
					);
				}
				return (
					<a key={key} href={node.href}>
						<InlineView nodes={node.children} />
					</a>
				);
			})}
		</>
	);
}

function BlockView({ block }: { block: BlockNode }) {
	if (block.type === "heading") {
		const children = <InlineView nodes={block.children} />;
		if (block.level === 1) return <h1>{children}</h1>;
		if (block.level === 2) return <h2>{children}</h2>;
		return <h3>{children}</h3>;
	}
	if (block.type === "paragraph") {
		return (
			<p>
				<InlineView nodes={block.children} />
			</p>
		);
	}
	if (block.type === "blockquote") {
		return (
			<blockquote>
				<InlineView nodes={block.children} />
			</blockquote>
		);
	}
	if (block.type === "code") {
		return (
			<pre>
				<code>{block.text}</code>
			</pre>
		);
	}
	const List = block.ordered ? "ol" : "ul";
	return (
		<List>
			{block.items.map((item, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: parsed markdown AST is read-only and lacks unique IDs
				<li key={i}>
					<InlineView nodes={item} />
				</li>
			))}
		</List>
	);
}

export function Markdown({ source }: { source: string }) {
	const blocks = parseMarkdown(source);
	return (
		<div className="flex flex-col gap-2 text-[length:var(--fs-md)]">
			{blocks.map((block, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: parsed markdown AST is read-only and lacks unique IDs
				<BlockView key={i} block={block} />
			))}
		</div>
	);
}
