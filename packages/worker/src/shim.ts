import {
	type ClientCommand,
	MAX_PROTOCOL_FRAME_BYTES,
	ProtocolValidationError,
	type ServerFrame,
	validateClientCommand,
} from "./protocol.js";

/**
 * Pluggable transport/UI adapter layer between external clients and Cadmus's
 * canonical protocol contract. Default implementation validates and encodes JSON frames;
 * alternative shims (e.g. binary/Protobuf or UI view-model adapters) can implement this interface.
 */
export interface ProtocolShim<WireIn = string, WireOut = string> {
	readonly contentType: string;
	decodeCommand(raw: WireIn): ClientCommand;
	encodeFrame(frame: ServerFrame): WireOut;
}

export class JsonProtocolShim implements ProtocolShim<string, string> {
	readonly contentType = "application/json";

	decodeCommand(raw: string): ClientCommand {
		if (typeof raw !== "string") {
			throw new ProtocolValidationError(
				"Protocol frame must be a UTF-8 string",
				"invalid_frame",
			);
		}
		if (raw.length > MAX_PROTOCOL_FRAME_BYTES) {
			throw new ProtocolValidationError(
				`Protocol frame exceeds maximum size (${MAX_PROTOCOL_FRAME_BYTES} bytes)`,
				"frame_too_large",
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new ProtocolValidationError(
				"Malformed JSON in protocol frame",
				"invalid_json",
			);
		}
		return validateClientCommand(parsed);
	}

	encodeFrame(frame: ServerFrame): string {
		return JSON.stringify(frame);
	}
}

export const defaultJsonShim = new JsonProtocolShim();
