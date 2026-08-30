import { randomUUID } from "node:crypto";
import type { Agent } from "./agent.ts";
import type {
  Message,
  ProviderMessage,
  RunOptions,
  RunResult,
  TokenUsage,
  ToolResult,
} from "./types.ts";
import {
  GuardrailError,
  HandoffError,
  MaxTurnsExceededError,
  SaguError,
  TimeoutError,
} from "./errors.ts";
import {
  buildCombinedToolSpecs,
  isHandoffToolName,
} from "./handoff.ts";

/**
 * Execute a timeout-wrapped promise.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(operationName, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Executes an agent run to completion, supporting multi-turn tools and handoffs.
 */
export async function runAgent<TOutput = string>(
  agent: Agent<TOutput>,
  input: string,
  options: RunOptions = {}
): Promise<RunResult<TOutput>> {
  const runId = randomUUID();
  let currentAgent: Agent<any> = agent;
  const maxTurns = options.maxTurns ?? agent.maxTurns ?? 10;
  const maxHandoffs = options.maxHandoffs ?? agent.maxHandoffs ?? 5;
  let turn = 0;
  let handoffCount = 0;
  const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const messages: Message[] = [];

  try {
    // 1. Load prior history from SessionStore if provided
    if (options.sessionId && options.sessionStore) {
      const prior = await options.sessionStore.getHistory(options.sessionId);
      if (prior && prior.length > 0) {
        messages.push(...prior);
      }
    }

    if (options.initialMessages && options.initialMessages.length > 0) {
      messages.push(...options.initialMessages);
    }

    // 2. Execute Input Guardrails
    let sanitizedInput = input;
    for (const guardrail of currentAgent.inputGuardrails) {
      const guardResult = await guardrail(sanitizedInput, {
        agentName: currentAgent.name,
        runId,
      });

      if (!guardResult.pass) {
        return {
          success: false,
          error: new GuardrailError("input", guardResult.reason ?? "Input rejected by guardrail"),
          messages,
          usage: totalUsage,
          agentName: currentAgent.name,
          turns: turn,
        };
      }

      if (guardResult.modified !== undefined) {
        sanitizedInput = guardResult.modified;
      }
    }

    // Append initial user input message
    messages.push({
      role: "user",
      content: sanitizedInput,
    });

    const runStartMessageCount = messages.length - 1; // index before new user message

    // 3. Core Agent Loop
    while (turn < maxTurns) {
      turn++;

      // Check abort signal
      if (options.signal?.aborted) {
        return {
          success: false,
          error: new SaguError("Run aborted by signal", "SAGU_CONFIG_ERROR"),
          messages,
          usage: totalUsage,
          agentName: currentAgent.name,
          turns: turn,
        };
      }

      // Resolve system instructions for active agent
      const systemPrompt =
        typeof currentAgent.instructions === "function"
          ? await currentAgent.instructions({
              runId,
              agentName: currentAgent.name,
              sessionId: options.sessionId,
              turn,
            })
          : currentAgent.instructions;

      // Compile tool specs (regular tools + synthetic handoff tools)
      const { toolSpecs, allTools } = buildCombinedToolSpecs(currentAgent);

      // Convert messages to ProviderMessage format
      const providerMessages: ProviderMessage[] = messages.map((m) => ({
        role: m.role,
        content: m.content,
        name: m.name,
        toolCalls: m.toolCalls,
        toolResult: m.toolResult,
      }));

      // Call Model Provider
      const response = await currentAgent.model.generate({
        messages: providerMessages,
        systemPrompt,
        tools: toolSpecs.length > 0 ? toolSpecs : undefined,
        temperature: currentAgent.temperature,
        abortSignal: options.signal,
      });

      // Accumulate token usage
      if (response.usage) {
        totalUsage.promptTokens += response.usage.promptTokens;
        totalUsage.completionTokens += response.usage.completionTokens;
        totalUsage.totalTokens += response.usage.totalTokens;
      }

      // Case A: Model returned tool calls
      if (response.toolCalls && response.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: response.content ?? "",
          toolCalls: response.toolCalls,
        });

        for (const toolCall of response.toolCalls) {
          const matchingTool = allTools.find((t) => t.name === toolCall.name);

          // Check if tool exists
          if (!matchingTool) {
            const errorResult: ToolResult = {
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: `Error: Tool '${toolCall.name}' is not registered on agent '${currentAgent.name}'`,
              isError: true,
            };
            messages.push({
              role: "tool",
              content: JSON.stringify(errorResult),
              toolResult: errorResult,
            });
            continue;
          }

          // Parse arguments
          let parsedArgs: any = toolCall.arguments;
          if (typeof parsedArgs === "string") {
            try {
              parsedArgs = JSON.parse(parsedArgs);
            } catch {
              const errorResult: ToolResult = {
                toolCallId: toolCall.id,
                name: toolCall.name,
                result: `Invalid JSON arguments for tool '${toolCall.name}': ${toolCall.arguments}`,
                isError: true,
              };
              messages.push({
                role: "tool",
                content: JSON.stringify(errorResult),
                toolResult: errorResult,
              });
              continue;
            }
          }

          // Case A1: Handoff Tool Call
          if (isHandoffToolName(toolCall.name) && "targetAgent" in matchingTool) {
            handoffCount++;
            const targetAgent = (matchingTool as any).targetAgent as Agent<any>;

            if (handoffCount > maxHandoffs) {
              return {
                success: false,
                error: new HandoffError(
                  `Maximum handoffs limit (${maxHandoffs}) exceeded while transferring from '${currentAgent.name}' to '${targetAgent.name}'`,
                  {
                    fromAgent: currentAgent.name,
                    toAgent: targetAgent.name,
                    hopCount: handoffCount,
                  }
                ),
                messages,
                usage: totalUsage,
                agentName: currentAgent.name,
                turns: turn,
              };
            }

            const fromAgentName = currentAgent.name;
            currentAgent = targetAgent;

            const handoffResult: ToolResult = {
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: {
                transferred: true,
                from: fromAgentName,
                to: currentAgent.name,
                reason: parsedArgs?.reason,
                note: `Conversation successfully transferred to ${currentAgent.name}.`,
              },
              isError: false,
            };

            messages.push({
              role: "tool",
              content: JSON.stringify(handoffResult.result),
              toolResult: handoffResult,
            });

            continue;
          }

          // Case A2: Regular Tool Call
          // Check tool approval if required
          if (matchingTool.requiresApproval) {
            let approved = false;
            if (options.onApprovalRequired) {
              approved = await options.onApprovalRequired(toolCall);
            }
            if (!approved) {
              const errorResult: ToolResult = {
                toolCallId: toolCall.id,
                name: toolCall.name,
                result: `Approval denied for tool execution '${toolCall.name}'`,
                isError: true,
              };
              messages.push({
                role: "tool",
                content: JSON.stringify(errorResult),
                toolResult: errorResult,
              });
              continue;
            }
          }

          // Validate tool inputs
          const validation = matchingTool.inputSchema.safeParse(parsedArgs);
          if (!validation.success) {
            const errorResult: ToolResult = {
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: `Schema validation failed for tool '${toolCall.name}': ${validation.error.message}`,
              isError: true,
            };
            messages.push({
              role: "tool",
              content: JSON.stringify(errorResult),
              toolResult: errorResult,
            });
            continue;
          }

          // Execute regular tool with optional timeout
          try {
            let execPromise = Promise.resolve(
              matchingTool.execute(validation.data, {
                agentName: currentAgent.name,
                runId,
                abortSignal: options.signal,
              })
            );

            if (matchingTool.timeoutMs && matchingTool.timeoutMs > 0) {
              execPromise = withTimeout(execPromise, matchingTool.timeoutMs, `tool:${matchingTool.name}`);
            }

            const rawResult = await execPromise;
            const toolResult: ToolResult = {
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: rawResult,
              isError: false,
            };

            messages.push({
              role: "tool",
              content: typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult),
              toolResult,
            });
          } catch (execErr: any) {
            const toolResult: ToolResult = {
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: `Tool execution failed: ${execErr.message ?? String(execErr)}`,
              isError: true,
            };

            messages.push({
              role: "tool",
              content: JSON.stringify(toolResult),
              toolResult,
            });
          }
        }

        // Loop back to give the model the tool results
        continue;
      }

      // Case B: Model returned plain text answer (final turn)
      const rawText = response.content ?? "";

      // Output Guardrails
      let sanitizedOutput = rawText;
      for (const guardrail of currentAgent.outputGuardrails) {
        const guardResult = await guardrail(sanitizedOutput, {
          agentName: currentAgent.name,
          runId,
        });

        if (!guardResult.pass) {
          return {
            success: false,
            error: new GuardrailError("output", guardResult.reason ?? "Output rejected by guardrail"),
            messages,
            usage: totalUsage,
            agentName: currentAgent.name,
            turns: turn,
          };
        }

        if (guardResult.modified !== undefined) {
          sanitizedOutput = guardResult.modified;
        }
      }

      messages.push({
        role: "assistant",
        content: sanitizedOutput,
      });

      // Save messages from this run to SessionStore if configured
      if (options.sessionId && options.sessionStore) {
        const newMessages = messages.slice(runStartMessageCount);
        await options.sessionStore.appendMessages(options.sessionId, newMessages);
      }

      return {
        success: true,
        output: sanitizedOutput as unknown as TOutput,
        messages,
        usage: totalUsage,
        agentName: currentAgent.name,
        turns: turn,
      };
    }

    // Max turns reached without final answer
    return {
      success: false,
      error: new MaxTurnsExceededError(maxTurns),
      messages,
      usage: totalUsage,
      agentName: currentAgent.name,
      turns: turn,
    };
  } catch (err: any) {
    if (err instanceof SaguError) {
      return {
        success: false,
        error: err,
        messages,
        usage: totalUsage,
        agentName: currentAgent.name,
        turns: turn,
      };
    }
    throw err;
  }
}

/**
 * Streaming generator for an agent run.
 */
export async function* streamAgent<TOutput = string>(
  agent: Agent<TOutput>,
  input: string,
  options: RunOptions = {}
) {
  const result = await runAgent<TOutput>(agent, input, options);
  yield result;
  return result;
}
