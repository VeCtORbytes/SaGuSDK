import { z } from "zod";

/**
 * Converts a Zod schema into a JSON Schema object suitable for LLM tool calling and structured output.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return parseZodType(schema);
}

function parseZodType(schema: z.ZodTypeAny): Record<string, unknown> {
  if (!schema || !("_def" in schema)) {
    return { type: "string" };
  }

  const def = (schema as any)._def;
  const typeName: string = def.typeName;
  const description = schema.description || def.description;

  const result: Record<string, unknown> = {};
  if (description) {
    result.description = description;
  }

  switch (typeName) {
    case "ZodString":
      result.type = "string";
      return result;

    case "ZodNumber":
      result.type = "number";
      return result;

    case "ZodBoolean":
      result.type = "boolean";
      return result;

    case "ZodObject": {
      result.type = "object";
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, fieldSchema] of Object.entries(shape)) {
        const fieldZod = fieldSchema as z.ZodTypeAny;
        properties[key] = parseZodType(fieldZod);

        // Check if field is optional or has default
        const fieldDef = (fieldZod as any)._def;
        const isOptional =
          fieldDef.typeName === "ZodOptional" ||
          fieldDef.typeName === "ZodDefault" ||
          (fieldDef.typeName === "ZodNullable" && (fieldDef.innerType?._def?.typeName === "ZodOptional"));

        if (!isOptional) {
          required.push(key);
        }
      }

      result.properties = properties;
      if (required.length > 0) {
        result.required = required;
      }
      result.additionalProperties = false;
      return result;
    }

    case "ZodArray": {
      result.type = "array";
      result.items = parseZodType(def.type);
      return result;
    }

    case "ZodEnum": {
      result.type = "string";
      result.enum = [...def.values];
      return result;
    }

    case "ZodNativeEnum": {
      result.type = "string";
      result.enum = Object.values(def.values);
      return result;
    }

    case "ZodOptional":
      return { ...parseZodType(def.innerType), ...result };

    case "ZodNullable": {
      const inner = parseZodType(def.innerType);
      return { ...inner, ...result, nullable: true };
    }

    case "ZodDefault":
      return { ...parseZodType(def.innerType), ...result, default: def.defaultValue() };

    case "ZodEffects":
      return parseZodType(def.schema);

    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = def.options as z.ZodTypeAny[];
      result.anyOf = options.map((opt) => parseZodType(opt));
      return result;
    }

    case "ZodRecord": {
      result.type = "object";
      result.additionalProperties = parseZodType(def.valueType);
      return result;
    }

    case "ZodLiteral": {
      result.type = typeof def.value;
      result.const = def.value;
      return result;
    }

    default:
      result.type = "string";
      return result;
  }
}
