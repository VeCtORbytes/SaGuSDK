import { z } from "zod";
import { Agent, defineTool, mock, ConsoleExporter } from "../../src/index.ts";

/**
 * Example 1: Basic Tool-Using Agent
 *
 * Demonstrates:
 * 1. Defining type-safe tools with Zod schema validation
 * 2. Creating an Agent with tools and model provider
 * 3. Running with the deterministic MockProvider (zero network, zero API keys required)
 * 4. Inspecting conversational messages, token usage, and execution trace
 */

// 1. Define calculator tool
const calculateTool = defineTool({
  name: "calculate",
  description: "Evaluate a mathematical expression and return the numeric result.",
  input: z.object({
    expression: z.string().describe("Mathematical expression to evaluate (e.g., '14 * 3')"),
  }),
  execute: async ({ expression }) => {
    // Safe expression evaluator for basic math
    const sanitized = expression.replace(/[^0-9+\-*/().]/g, "");
    try {
      const result = Function(`'use strict'; return (${sanitized})`)();
      return { expression, result: Number(result) };
    } catch {
      return { expression, error: "Invalid math expression" };
    }
  },
});

// 2. Define weather tool
const weatherTool = defineTool({
  name: "get_weather",
  description: "Get the current weather forecast for a specified city.",
  input: z.object({
    city: z.string().describe("Target city name"),
    unit: z.enum(["celsius", "fahrenheit"]).default("celsius"),
  }),
  execute: async ({ city, unit }) => {
    return {
      city,
      temperature: unit === "celsius" ? 21 : 70,
      unit,
      condition: "Partly Cloudy",
      humidity: 55,
    };
  },
});

// 3. Create deterministic mock model script for testing & demo
// (To run against real LLMs: replace with anthropic(), openai(), or gemini())
const model = mock([
  // Turn 1: Model decides to call calculate
  {
    toolCalls: [
      {
        id: "call_calc_1",
        name: "calculate",
        arguments: { expression: "125 * 8" },
      },
    ],
  },
  // Turn 2: Model returns final answer
  "125 multiplied by 8 equals 1,000.",
]);

// 4. Configure the Agent
const agent = new Agent({
  name: "MathAndWeatherAssistant",
  instructions:
    "You are a helpful assistant. Use the calculate tool for math questions and get_weather for weather queries.",
  model,
  tools: [calculateTool, weatherTool],
});

async function main() {
  console.log("=== Sagu SDK: Example 01 - Basic Tool Agent ===");
  console.log("User: What is 125 * 8?");

  const result = await agent.run("What is 125 * 8?", {
    traceExporter: new ConsoleExporter(),
  });

  if (result.success) {
    console.log("\nAssistant Output:\n", result.output);
    console.log("\nTotal Turns:", result.turns);
    console.log("Token Usage:", result.usage);
    console.log("Message History Count:", result.messages.length);
  } else {
    console.error("Execution failed:", result.error);
  }
}

main().catch(console.error);
