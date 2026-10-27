import type {
	ToolsEnvCatalogChoice,
	ToolsEnvChoice,
} from "../tools-env-form.js";

interface ToolsEnvPinFieldsProps {
	idPrefix: string;
	choice: ToolsEnvChoice;
	envId: string;
	envs: ToolsEnvCatalogChoice[];
	retainedEnvId?: string;
	onChoice: (choice: ToolsEnvChoice) => void;
	onEnvId: (envId: string) => void;
}

export function ToolsEnvPinFields({
	idPrefix,
	choice,
	envId,
	envs,
	retainedEnvId,
	onChoice,
	onEnvId,
}: ToolsEnvPinFieldsProps) {
	return (
		<div className="form-group">
			<span className="form-label">Tools env</span>
			<div
				style={{ display: "flex", gap: "12px", marginBottom: "8px" }}
				role="radiogroup"
				aria-label="Tools env"
			>
				{(["inherit", "on", "off"] as const).map((value) => (
					<label key={value} htmlFor={`${idPrefix}-choice-${value}`}>
						<input
							id={`${idPrefix}-choice-${value}`}
							type="radio"
							name={`${idPrefix}-choice`}
							value={value}
							checked={choice === value}
							onChange={() => onChoice(value)}
						/>{" "}
						{value === "inherit" ? "Inherit" : value === "on" ? "On" : "Off"}
					</label>
				))}
			</div>
			{choice === "on" ? (
				<select
					id={`${idPrefix}-env`}
					className="select input-mono"
					aria-label="Tools env id"
					value={envId}
					onChange={(event) => onEnvId(event.target.value)}
				>
					<option value="">Account default</option>
					{envs.map((env) => (
						<option key={env.envId} value={env.envId}>
							{env.label ? `${env.label} (${env.envId})` : env.envId} ·{" "}
							{env.kind}
						</option>
					))}
				</select>
			) : null}
			{choice === "off" && retainedEnvId ? (
				<span className="form-hint">
					Retained env {retainedEnvId}. Turning On restores it.
				</span>
			) : null}
			{choice === "inherit" ? (
				<span className="form-hint">
					Inherit the next level. The account default is used when no bot pin is
					set.
				</span>
			) : null}
		</div>
	);
}
