import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineTool } from "../src/tool.ts";
import { ConfigurationError } from "../src/errors.ts";

test("defineTool - valid tool definition", async () => {
  const weatherTool = defineTool({
    name: "get_weather",
    description: "Get weather for a city",
    input: z.object({
      city: z.string().describe("City name"),
    }),
    requiresApproval: true,
    timeoutMs: 3000,
    execute: async ({ city }) => {
      return { temp: 22, condition: "Sunny", city };
    },
  });

  assert.equal(weatherTool.name, "get_weather");
  assert.equal(weatherTool.description, "Get weather for a city");
  assert.equal(weatherTool.requiresApproval, true);
  assert.equal(weatherTool.timeoutMs, 3000);

  const jsonSchema = weatherTool.toJSONSchema?.();
  assert(jsonSchema);
  assert.equal(jsonSchema.type, "object");

  const result = await weatherTool.execute({ city: "Tokyo" });
  assert.deepEqual(result, { temp: 22, condition: "Sunny", city: "Tokyo" });
});

test("defineTool - validation errors on invalid definition", () => {
  // Empty name
  assert.throws(
    () =>
      defineTool({
        name: "",
        description: "foo",
        input: z.object({}),
        execute: () => "ok",
      }),
    ConfigurationError
  );

  // Invalid characters in name
  assert.throws(
    () =>
      defineTool({
        name: "get weather!",
        description: "foo",
        input: z.object({}),
        execute: () => "ok",
      }),
    ConfigurationError
  );

  // Missing description
  assert.throws(
    () =>
      defineTool({
        name: "foo",
        description: "",
        input: z.object({}),
        execute: () => "ok",
      } as any),
    ConfigurationError
  );

  // Non-function execute
  assert.throws(
    () =>
      defineTool({
        name: "foo",
        description: "bar",
        input: z.object({}),
        execute: "not_a_function" as any,
      }),
    ConfigurationError
  );
});
