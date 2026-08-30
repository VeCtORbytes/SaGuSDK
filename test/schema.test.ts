import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { zodToJsonSchema } from "../src/providers/schema.ts";

test("zodToJsonSchema - basic primitives", () => {
  const strSchema = zodToJsonSchema(z.string().describe("A user name"));
  assert.deepEqual(strSchema, { type: "string", description: "A user name" });

  const numSchema = zodToJsonSchema(z.number().describe("Age"));
  assert.deepEqual(numSchema, { type: "number", description: "Age" });

  const boolSchema = zodToJsonSchema(z.boolean());
  assert.deepEqual(boolSchema, { type: "boolean" });
});

test("zodToJsonSchema - object with required and optional fields", () => {
  const schema = z.object({
    city: z.string().describe("Target city"),
    unit: z.enum(["celsius", "fahrenheit"]).default("celsius").describe("Temperature unit"),
    days: z.number().optional().describe("Number of forecast days"),
  });

  const jsonSchema = zodToJsonSchema(schema);
  assert.equal(jsonSchema.type, "object");
  assert.equal(jsonSchema.additionalProperties, false);
  assert.deepEqual(jsonSchema.required, ["city"]);

  const props = jsonSchema.properties as Record<string, any>;
  assert.equal(props.city.type, "string");
  assert.equal(props.city.description, "Target city");
  assert.deepEqual(props.unit.enum, ["celsius", "fahrenheit"]);
  assert.equal(props.unit.default, "celsius");
  assert.equal(props.days.type, "number");
});

test("zodToJsonSchema - nested objects and arrays", () => {
  const schema = z.object({
    items: z.array(
      z.object({
        name: z.string(),
        quantity: z.number(),
      })
    ),
  });

  const jsonSchema = zodToJsonSchema(schema);
  assert.equal(jsonSchema.type, "object");
  const props = jsonSchema.properties as Record<string, any>;
  assert.equal(props.items.type, "array");
  assert.equal(props.items.items.type, "object");
  assert.deepEqual(props.items.items.required, ["name", "quantity"]);
});
