export interface ScheduleTiming {
	kind: "relative" | "absolute" | "cron";
	input: string | number;
	nextRun?: number;
	enabled: boolean;
	timeZone?: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function pad(value: string): string {
	return value.padStart(2, "0");
}

function clock(hour: string, minute: string): string | undefined {
	if (!/^\d{1,2}$/.test(hour) || !/^\d{1,2}$/.test(minute)) return undefined;
	const h = Number(hour);
	const m = Number(minute);
	if (h > 23 || m > 59) return undefined;
	return `${pad(String(h))}:${pad(String(m))}`;
}

function weekdayName(token: string): string {
	if (/^\d$/.test(token)) {
		const day = Number(token) % 7;
		return WEEKDAYS[day] ?? token;
	}
	const short = token.slice(0, 3);
	const known = WEEKDAYS.find(
		(day) => day.toLowerCase() === short.toLowerCase(),
	);
	return known ?? token;
}

function cadence(kind: ScheduleTiming["kind"], input: string | number): string {
	if (kind === "relative") return `in ${input}`;
	if (kind === "absolute") return String(input);
	const raw = String(input).trim();
	if (raw === "@daily" || raw === "@midnight") return "every day";
	if (raw === "@hourly") return "hourly";
	if (raw === "@weekly") return "weekly";
	if (raw === "@monthly") return "monthly";
	const parts = raw.split(/\s+/);
	if (parts.length < 5) return raw;
	const [minute, hour, dom, , dow] = parts;
	const hm = minute && hour ? clock(hour, minute) : undefined;
	if (dom === "*" && (dow === "*" || dow === "?") && hm) return "every day";
	if (dom === "*" && dow && dow !== "*" && dow !== "?" && hm) {
		const names = dow.split(",").map(weekdayName).join(" ");
		return `every ${names} ${hm}`;
	}
	if (hour === "*" && minute && minute !== "*") return "hourly";
	if (hm && dom && dom !== "*") return `monthly ${hm}`;
	return raw;
}

function partsInZone(ts: number, timeZone: string) {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		weekday: "short",
		hourCycle: "h23",
	});
	const bag: Record<string, string> = {};
	for (const part of fmt.formatToParts(new Date(ts))) {
		if (part.type !== "literal") bag[part.type] = part.value;
	}
	return bag;
}

/**
 * One readable line for a schedule row or editor.
 * Enabled daily runs read "Next: tomorrow 07:00 · every day".
 * A paused weekly run reads "Paused · every Wed 20:00".
 */
export function describeSchedule(
	schedule: ScheduleTiming,
	now = Date.now(),
): string {
	const timeZone = schedule.timeZone || "UTC";
	const pattern = cadence(schedule.kind, schedule.input);
	if (!schedule.enabled) {
		if (schedule.kind === "cron") {
			const parts = String(schedule.input).trim().split(/\s+/);
			const hm =
				parts.length >= 2 && parts[0] && parts[1]
					? clock(parts[1], parts[0])
					: undefined;
			const dow = parts[4];
			if (
				hm &&
				parts[2] === "*" &&
				dow &&
				dow !== "*" &&
				!dow.includes(",") &&
				!dow.includes("-")
			) {
				return `Paused · every ${weekdayName(dow)} ${hm}`;
			}
			if (hm && (dow === "*" || dow === "?")) return `Paused · every day`;
		}
		return `Paused · ${pattern}`;
	}

	if (schedule.nextRun == null) return pattern;

	const next = partsInZone(schedule.nextRun, timeZone);
	const today = partsInZone(now, timeZone);
	const tomorrow = partsInZone(now + 86_400_000, timeZone);
	const hm = `${pad(next.hour ?? "0")}:${pad(next.minute ?? "0")}`;
	const dayKey = (bag: Record<string, string>) =>
		`${bag.year}-${bag.month}-${bag.day}`;
	const weekly =
		schedule.kind === "cron" &&
		(() => {
			const parts = String(schedule.input).trim().split(/\s+/);
			const dow = parts[4];
			return Boolean(
				dow &&
					dow !== "*" &&
					dow !== "?" &&
					!dow.includes(",") &&
					parts[2] === "*",
			);
		})();
	if (weekly) {
		const short = (next.weekday ?? "").slice(0, 3);
		return `Next: ${short} ${hm} · weekly`;
	}
	const when =
		dayKey(next) === dayKey(today)
			? `today ${hm}`
			: dayKey(next) === dayKey(tomorrow)
				? `tomorrow ${hm}`
				: `${(next.weekday ?? "").slice(0, 3)} ${hm}`;
	const daily = schedule.kind === "cron" && /every day/.test(pattern);
	const suffix = daily ? "every day" : pattern;
	return `Next: ${when} · ${suffix}`;
}
