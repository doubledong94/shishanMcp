import { z } from "zod";
import { toJSONSchema } from "zod/v4-mini";

/**
 * Single source of truth for what the AI sees.
 * The @Tool() decorator AND the /api/tools endpoint read the SAME spec,
 * so the debug console always shows exactly what gets sent over the wire.
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters?: z.ZodType;
}

/**
 * Convert a zod schema to the JSON Schema MCP sends as inputSchema.
 * Uses the exact same converter the MCP SDK uses (zod/v4-mini, draft-7,
 * input pipe), so /api/tools matches tools/list byte for byte. The SDK
 * emits `$schema` last; reorder to match it exactly.
 */
export function toolInputSchema(spec: ToolSpec): Record<string, unknown> | undefined {
  if (!spec.parameters) return undefined;
  const schema = toJSONSchema(spec.parameters as never, {
    target: "draft-7",
    io: "input",
  }) as Record<string, unknown>;
  const { $schema, ...rest } = schema;
  return $schema === undefined ? rest : { ...rest, $schema };
}
