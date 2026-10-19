# Quickstart Guide

Get up and running with **SAGU SDK** in under 3 minutes.

---

## Installation

```bash
npm install sagu-sdk zod
```

*(Optional: `npm install neo4j-driver` if using Neo4j for semantic graph memory).*

---

## 1. Minimal Working Agent (Zero Network, Zero API Keys)

```typescript
import { Agent, mock } from "sagu-sdk";

const agent = new Agent({
  name: "Assistant",
  instructions: "You are a concise, helpful assistant.",
  model: mock(["Hello from SAGU! I'm running locally with zero external network."]),
});

const result = await agent.run("Hello!");

if (result.success) {
  console.log("Agent output:", result.output);
  console.log("Tokens used:", result.usage.totalTokens);
} else {
  console.error("Run failed:", result.error);
}
```

---

## 2. Adding Type-Safe Tools

Tools are defined with `defineTool()` and validated using standard Zod schemas:

```typescript
import { z } from "zod";
import { Agent, defineTool, mock } from "sagu-sdk";

const weatherTool = defineTool({
  name: "get_weather",
  description: "Get weather for a city",
  input: z.object({
    city: z.string().describe("City name"),
  }),
  execute: async ({ city }) => {
    return { city, temperature: 22, condition: "Sunny" };
  },
});

const agent = new Agent({
  name: "WeatherBot",
  instructions: "Answer weather questions using get_weather.",
  model: mock([
    {
      toolCalls: [
        { id: "call_1", name: "get_weather", arguments: { city: "Tokyo" } },
      ],
    },
    "The weather in Tokyo is 22°C and Sunny.",
  ]),
  tools: [weatherTool],
});

const result = await agent.run("What's the weather in Tokyo?");
console.log(result.output); // "The weather in Tokyo is 22°C and Sunny."
```

---

## 3. Switching to Real Providers (Claude, OpenAI, Gemini)

Connecting to live model providers only requires swapping the `model` property:

### Claude (Anthropic):
```typescript
import { Agent, anthropic } from "sagu-sdk";

const agent = new Agent({
  name: "ClaudeAgent",
  instructions: "Help the user.",
  model: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
});
```

### OpenAI:
```typescript
import { Agent, openai } from "sagu-sdk";

const agent = new Agent({
  name: "OpenAIAgent",
  instructions: "Help the user.",
  model: openai({ apiKey: process.env.OPENAI_API_KEY }),
});
```

### Google Gemini:
```typescript
import { Agent, gemini } from "sagu-sdk";

const agent = new Agent({
  name: "GeminiAgent",
  instructions: "Help the user.",
  model: gemini({ apiKey: process.env.GEMINI_API_KEY }),
});
```

### Multi-Provider Fallback:
```typescript
import { Agent, fallback, anthropic, openai, gemini } from "sagu-sdk";

const agent = new Agent({
  name: "ResilientAgent",
  instructions: "Help the user.",
  model: fallback(
    anthropic(), // Primary
    openai(),    // First fallback
    gemini()     // Second fallback
  ),
});
```

---

## Next Steps

- Explore [Tools & Approvals](tools.md)
- Learn about [Multi-Agent Handoffs](handoffs.md)
- Discover [Semantic Graph Memory](memory-and-sessions.md)
