import type { z } from "zod";
import type {
  AgentConfig,
  InputGuardrail,
  OutputGuardrail,
  ToolGuardrail,
  ModelProvider,
  RunOptions,
  RunResult,
  Tool,
} from "./types.ts";
import { ConfigurationError } from "./errors.ts";
import { runAgent, streamAgent } from "./runner.ts";

/**
 * The core Agent class in Sagu SDK.
 * Encapsulates immutable static configuration: instructions, model provider, tools, guardrails, and handoffs.
 */
export class Agent<TOutput = string> {
  readonly name: string;
  readonly instructions: AgentConfig<TOutput>["instructions"];
  readonly model: ModelProvider;
  readonly tools: Tool[];
  readonly outputSchema?: z.ZodType<TOutput>;
  readonly inputGuardrails: InputGuardrail[];
  readonly outputGuardrails: OutputGuardrail[];
  readonly toolGuardrails: ToolGuardrail[];
  readonly handoffs: Agent<any>[];
  readonly maxTurns: number;
  readonly maxHandoffs: number;
  readonly maxRepairAttempts: number;
  readonly temperature?: number;

  constructor(config: AgentConfig<TOutput>) {
    if (!config || typeof config !== "object") {
      throw new ConfigurationError("Agent config must be an object");
    }

    if (!config.name || typeof config.name !== "string" || config.name.trim() === "") {
      throw new ConfigurationError("Agent must have a valid non-empty 'name'");
    }

    if (!config.instructions) {
      throw new ConfigurationError(`Agent '${config.name}' must have 'instructions' defined`);
    }

    if (!config.model || typeof config.model.generate !== "function") {
      throw new ConfigurationError(
        `Agent '${config.name}' must have a valid 'model' implementing ModelProvider`
      );
    }

    this.name = config.name.trim();
    this.instructions = config.instructions;
    this.model = config.model;
    this.tools = [...(config.tools ?? [])];
    this.outputSchema = config.outputSchema;
    this.inputGuardrails = [...(config.inputGuardrails ?? [])];
    this.outputGuardrails = [...(config.outputGuardrails ?? [])];
    this.toolGuardrails = [...(config.toolGuardrails ?? [])];
    this.handoffs = [...(config.handoffs ?? [])];
    this.maxTurns = config.maxTurns ?? 10;
    this.maxHandoffs = config.maxHandoffs ?? 5;
    this.maxRepairAttempts = config.maxRepairAttempts ?? 2;
    this.temperature = config.temperature;

    // Freeze tools and handoffs arrays to ensure immutability
    Object.freeze(this.tools);
    Object.freeze(this.handoffs);
    Object.freeze(this.inputGuardrails);
    Object.freeze(this.outputGuardrails);
    Object.freeze(this.toolGuardrails);
  }

  /**
   * Execute a run with this agent.
   * Never throws on expected execution failures (returns { success: false, error }).
   */
  async run(
    input: string,
    options: RunOptions = {}
  ): Promise<RunResult<TOutput>> {
    return runAgent<TOutput>(this, input, options);
  }

  /**
   * Stream a run with this agent yielding events.
   */
  async *stream(
    input: string,
    options: RunOptions = {}
  ) {
    yield* streamAgent<TOutput>(this, input, options);
  }
}
