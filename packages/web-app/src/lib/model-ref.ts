import type { ModelInfo } from "@cadmus/contract/types";

/** `account.models.list` `id` is provider-local; bot.model is `<provider>/<id>`. */
export function modelListRef(
	model: Pick<ModelInfo, "id" | "provider">,
): string {
	if (model.id.includes("/")) return model.id;
	return `${model.provider}/${model.id}`;
}
