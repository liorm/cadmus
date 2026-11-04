import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { SegmentedControl } from "@/components/SegmentedControl";
import { getTheme, setTheme, THEMES, type ThemeName } from "@/theme/theme";

export function SettingsPage() {
	const [theme, setThemeState] = useState<ThemeName>(() => getTheme());
	return (
		<AppShell title="Settings" backTo="/">
			<div className="flex flex-col gap-4 p-4">
				<section aria-labelledby="appearance-heading">
					<h2
						id="appearance-heading"
						className="mb-2 text-[length:var(--fs-md)]"
					>
						Appearance
					</h2>
					<SegmentedControl
						ariaLabel="Theme"
						value={theme}
						onValueChange={(value) => {
							const next = value as ThemeName;
							if (!THEMES.includes(next)) return;
							setTheme(next);
							setThemeState(next);
						}}
						options={THEMES.map((name) => ({
							value: name,
							label: name[0]?.toUpperCase() + name.slice(1),
						}))}
					/>
				</section>
				<Link
					to="/settings/archive"
					className="flex min-h-tap items-center text-accent"
				>
					Archive
				</Link>
			</div>
		</AppShell>
	);
}
