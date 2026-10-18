import { randomUUID } from "node:crypto";
import type { Agent } from "./agent.ts";
import type {
  Message,
  ProviderMessage,
  ProviderResponse,
  RunOptions,
  RunResult,
  TokenUsage,
  ToolResult,
} from "./types.ts";
import type { AgentEvent } from "./events.ts";
import {
  GuardrailError,
  HandoffError,
  MaxTurnsExceededError,
  SaguError,
} from "./errors.ts";
import {
  buildCombinedToolSpecs,
  isHandoffToolName,
} from "./handoff.ts";
import { zodToJsonSchema } from "./providers/schema.ts";
import { parseStructuredOutput } from "./structuredOutput.ts";
import { withRetry, withTimeout } from "./reliability.ts";
import { TraceRecorder } from "./trace.ts";

/**
 * Async generator for streaming an agent run.
 * Emits AgentEvents (text_delta, tool_start, tool_end, handoff, guardrail_triggered, run_completed, run_failed).
 */
export async function* streamAgent<TOutput = string>(
  agent: Agent<TOutput>,
  input: string,
  options: RunOptions = {}
): AsyncGenerator<AgentEvent<TOutput>, void, unknown> {
  const runId = randomUUID();
  const traceRecorder = new TraceRecorder(runId);
  const rootSpanId = traceRecorder.startSpan("agent_run", {
    agentName: agent.name,
    sessionId: options.sessionId,
  });

  let currentAgent: Agent<any> = agent;
  const maxTurns = options.maxTurns ?? agent.maxTurns ?? 10;
  const maxHandoffs = options.maxHandoffs ?? agent.maxHandoffs ?? 5;
  const maxRepairAttempts = agent.maxRepairAttempts ?? 2;
  let turn = 0;
  let handoffCount = 0;
  let repairAttempts = 0;
  const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const messages: Message[] = [];

  const finalizeTrace = async (err?: unknown) => {
    traceRecorder.endSpan(rootSpanId, undefined, err);
    traceRecorder.finish();
    const trace = traceRecorder.getTrace();
    if (options.traceExporter) {
      try {
        await options.traceExporter.export(trace);
      } catch (exportErr) {
        console.error("Failed to export trace:", exportErr);
      }
    }
    return trace;
  };

  try {
    // 1. Load prior history from SessionStore if provided
    if (options.sessionId && options.sessionStore) {
      const loadSpanId = traceRecorder.startSpan("session_load", { sessionId: options.sessionId });
      const prior = await options.sessionStore.getHistory(options.sessionId);
      if (prior && prior.length > 0) {
        messages.push(...prior);
      }
      traceRecorder.endSpan(loadSpanId, { messageCount: prior?.length ?? 0 });
    }

    if (options.initialMessages && options.initialMessages.length > 0) {
      messages.push(...options.initialMessages);
    }

    // 2. Execute Input Guardrails
    let sanitizedInput = input;
    for (const guardrail of currentAgent.inputGuardrails) {
      const guardSpanId = traceRecorder.startSpan("input_guardrail");
      const guardResult = await guardrail(sanitizedInput, {
        agentName: currentAgent.name,
        runId,
      });

      if (!guardResult.pass) {
        traceRecorder.endSpan(guardSpanId, { pass: false, reason: guardResult.reason });
        yield {
          type: "guardrail_triggered",
          stage: "input",
          reason: guardResult.reason ?? "Input rejected by guardrail",
          action: "blocked",
        };

        const error = new GuardrailError("input", guardResult.reason ?? "Input rejected by guardrail");
        const trace = await finalizeTrace(error);
        yield {
          type: "run_failed",
          error,
          messages,
          usage: totalUsage,
          agentName: currentAgent.name,
          turns: turn,
          trace,
        };
        return;
      }

      if (guardResult.modified !== undefined) {
        sanitizedInput = guardResult.modified;
        traceRecorder.endSpan(guardSpanId, { pass: true, action: "modified" });
        yield {
          type: "guardrail_triggered",
          stage: "input",
          reason: guardResult.reason ?? "Input modified by guardrail",
          action: "modified",
        };
      } else {
        traceRecorder.endSpan(guardSpanId, { pass: true });
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
        const error = new SaguError("Run aborted by signal", "SAGU_CONFIG_ERROR");
        const trace = await finalizeTrace(error);
        yield {
          type: "run_failed",
          error,
          messages,
          usage: totalUsage,
          agentName: currentAgent.name,
          turns: turn,
          trace,
        };
        return;
      }

      // Resolve system instructions for active agent
      let systemPrompt =
        typeof currentAgent.instructions === "function"
          ? await currentAgent.instructions({
              runId,
              agentName: currentAgent.name,
              sessionId: options.sessionId,
              turn,
            })
          : currentAgent.instructions;

      // If agent has structured output schema, augment instructions with schema
      let outputSchemaJson: Record<string, unknown> | undefined;
      if (currentAgent.outputSchema) {
        outputSchemaJson = zodToJsonSchema(currentAgent.outputSchema);
        systemPrompt += `\n\n[STRUCTURED OUTPUT REQUIREMENT]\nYou MUST respond with ONLY a valid JSON object matching this schema:\n${JSON.stringify(
          outputSchemaJson,
          null,
          2
        )}`;
      }

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

      // Call Model Provider (with streaming if supported, and with retry)
      const providerRequest = {
        messages: providerMessages,
        systemPrompt,
        tools: toolSpecs.length > 0 ? toolSpecs : undefined,
        temperature: currentAgent.temperature,
        outputSchema: outputSchemaJson,
        abortSignal: options.signal,
      };

      const modelSpanId = traceRecorder.startSpan("model_call", {
        agent: currentAgent.name,
        turn,
      });

      let response: ProviderResponse;
      try {
        if (typeof currentAgent.model.stream === "function") {
          const streamGen = currentAgent.model.stream(providerRequest);
          let streamText = "";
          let streamResult: ProviderResponse | undefined;

          while (true) {
            const next = await streamGen.next();
            if (next.done) {
              streamResult = next.value as ProviderResponse;
              break;
            }
            if (next.value?.type === "text_delta" && next.value.text) {
              streamText += next.value.text;
              yield { type: "text_delta", text: next.value.text };
            }
          }

          response = streamResult ?? {
            content: streamText,
            stopReason: "end_turn",
          };
        } else {
          response = await withRetry(
            () => currentAgent.model.generate(providerRequest),
            { maxRetries: 3, initialDelayMs: 200 }
          );

          if (response.content) {
            yield { type: "text_delta", text: response.content };
          }
        }

        traceRecorder.endSpan(modelSpanId, {
          stopReason: response.stopReason,
          tokens: response.usage?.totalTokens,
        });
      } catch (modelErr: any) {
        traceRecorder.endSpan(modelSpanId, undefined, modelErr);
        throw modelErr;
      }

      // Accumulate token usage
      if (response.usage) {
        totalUsage.promptTokens += response.usage.promptTokens;
        totalUsage.completionTokens += response.usage.completionTokens;
        totalUsage.totalTokens += response.usage.totalTokens;
        traceRecorder.recordUsage(response.usage);
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
              yield {
                type: "tool_end",
                toolCallId: toolCall.id,
                name: toolCall.name,
                result: errorResult.result,
                isError: true,
              };
              continue;
            }
          }

          // Case A1: Handoff Tool Call
          if (isHandoffToolName(toolCall.name) && matchingTool && "targetAgent" in matchingTool) {
            handoffCount++;
            const targetAgent = (matchingTool as any).targetAgent as Agent<any>;

            yield {
              type: "handoff",
              fromAgent: currentAgent.name,
              toAgent: targetAgent.name,
              reason: parsedArgs?.reason,
            };

            const handoffSpanId = traceRecorder.startSpan("handoff", {
              fromAgent: currentAgent.name,
              toAgent: targetAgent.name,
              hopCount: handoffCount,
            });

            if (handoffCount > maxHandoffs) {
              const error = new HandoffError(
                `Maximum handoffs limit (${maxHandoffs}) exceeded while transferring from '${currentAgent.name}' to '${targetAgent.name}'`,
                {
                  fromAgent: currentAgent.name,
                  toAgent: targetAgent.name,
                  hopCount: handoffCount,
                }
              );
              traceRecorder.endSpan(handoffSpanId, undefined, error);
              const trace = await finalizeTrace(error);
              yield {
                type: "run_failed",
                error,
                messages,
                usage: totalUsage,
                agentName: currentAgent.name,
                turns: turn,
                trace,
              };
              return;
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

            traceRecorder.endSpan(handoffSpanId, { transferred: true });
            continue;
          }

          // Case A2: Regular Tool Call
          yield {
            type: "tool_start",
            toolCallId: toolCall.id,
            name: toolCall.name,
            arguments: parsedArgs,
          };

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
            yield {
              type: "tool_end",
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: errorResult.result,
              isError: true,
            };
            continue;
          }

          // Check Tool Guardrails
          let toolGuardrailBlocked = false;
          for (const guardrail of currentAgent.toolGuardrails) {
            const guardSpanId = traceRecorder.startSpan("tool_guardrail", { toolName: toolCall.name });
            const guardResult = await guardrail(toolCall, {
              agentName: currentAgent.name,
              runId,
            });
            if (!guardResult.pass) {
              traceRecorder.endSpan(guardSpanId, { pass: false, reason: guardResult.reason });
              yield {
                type: "guardrail_triggered",
                stage: "tool",
                reason: guardResult.reason ?? "Denied by tool guardrail",
                action: "blocked",
                toolName: toolCall.name,
              };

              const errorResult: ToolResult = {
                toolCallId: toolCall.id,
                name: toolCall.name,
                result: `Tool guardrail blocked: ${guardResult.reason ?? "Denied by tool guardrail"}`,
                isError: true,
              };
              messages.push({
                role: "tool",
                content: JSON.stringify(errorResult),
                toolResult: errorResult,
              });
              yield {
                type: "tool_end",
                toolCallId: toolCall.id,
                name: toolCall.name,
                result: errorResult.result,
                isError: true,
              };
              toolGuardrailBlocked = true;
              break;
            } else {
              traceRecorder.endSpan(guardSpanId, { pass: true });
            }
          }
          if (toolGuardrailBlocked) {
            continue;
          }

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
              yield {
                type: "tool_end",
                toolCallId: toolCall.id,
                name: toolCall.name,
                result: errorResult.result,
                isError: true,
              };
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
            yield {
              type: "tool_end",
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: errorResult.result,
              isError: true,
            };
            continue;
          }

          // Execute regular tool with timeout and tracing
          const toolSpanId = traceRecorder.startSpan("tool_execution", {
            toolName: matchingTool.name,
          });

          try {
            let execPromise = Promise.resolve(
              matchingTool.execute(validation.data, {
                agentName: currentAgent.name,
                runId,
                abortSignal: options.signal,
              })
            );

            if (matchingTool.timeoutMs && matchingTool.timeoutMs > 0) {
              execPromise = withTimeout(
                execPromise,
                matchingTool.timeoutMs,
                `tool:${matchingTool.name}`,
                options.signal
              );
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

            traceRecorder.endSpan(toolSpanId, { success: true });
            yield {
              type: "tool_end",
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: rawResult,
              isError: false,
            };
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

            traceRecorder.endSpan(toolSpanId, undefined, execErr);
            yield {
              type: "tool_end",
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: toolResult.result,
              isError: true,
            };
          }
        }

        // Loop back to give the model the tool results
        continue;
      }

      // Case B: Model returned plain text answer (final turn or schema candidate)
      const rawText = response.content ?? "";

      // Check Structured Output if schema configured
      let parsedOutput: any = rawText;
      if (currentAgent.outputSchema) {
        const parseResult = parseStructuredOutput(
          rawText,
          currentAgent.outputSchema,
          repairAttempts + 1
        );

        if (!parseResult.success) {
          if (repairAttempts < maxRepairAttempts) {
            repairAttempts++;
            messages.push({
              role: "assistant",
              content: rawText,
            });
            messages.push({
              role: "user",
              content: parseResult.repairPrompt,
            });
            // Continue loop for repair retry
            continue;
          }

          // Repair attempts exhausted
          const trace = await finalizeTrace(parseResult.error);
          yield {
            type: "run_failed",
            error: parseResult.error,
            messages,
            usage: totalUsage,
            agentName: currentAgent.name,
            turns: turn,
            trace,
          };
          return;
        }

        parsedOutput = parseResult.data;
      }

      // Output Guardrails
      let sanitizedOutput = rawText;
      for (const guardrail of currentAgent.outputGuardrails) {
        const guardSpanId = traceRecorder.startSpan("output_guardrail");
        const guardResult = await guardrail(sanitizedOutput, {
          agentName: currentAgent.name,
          runId,
        });

        if (!guardResult.pass) {
          traceRecorder.endSpan(guardSpanId, { pass: false, reason: guardResult.reason });
          yield {
            type: "guardrail_triggered",
            stage: "output",
            reason: guardResult.reason ?? "Output rejected by guardrail",
            action: "blocked",
          };

          const error = new GuardrailError("output", guardResult.reason ?? "Output rejected by guardrail");
          const trace = await finalizeTrace(error);
          yield {
            type: "run_failed",
            error,
            messages,
            usage: totalUsage,
            agentName: currentAgent.name,
            turns: turn,
            trace,
          };
          return;
        }

        if (guardResult.modified !== undefined) {
          sanitizedOutput = guardResult.modified;
          traceRecorder.endSpan(guardSpanId, { pass: true, action: "modified" });
          yield {
            type: "guardrail_triggered",
            stage: "output",
            reason: guardResult.reason ?? "Output modified by guardrail",
            action: "modified",
          };
        } else {
          traceRecorder.endSpan(guardSpanId, { pass: true });
        }
      }

      messages.push({
        role: "assistant",
        content: sanitizedOutput,
      });

      // Save messages from this run to SessionStore if configured
      if (options.sessionId && options.sessionStore) {
        const saveSpanId = traceRecorder.startSpan("session_save");
        const newMessages = messages.slice(runStartMessageCount);
        await options.sessionStore.appendMessages(options.sessionId, newMessages);
        traceRecorder.endSpan(saveSpanId, { savedCount: newMessages.length });
      }

      const finalOutput = currentAgent.outputSchema
        ? (parsedOutput as TOutput)
        : (sanitizedOutput as unknown as TOutput);

      const trace = await finalizeTrace();

      yield {
        type: "run_completed",
        output: finalOutput,
        messages,
        usage: totalUsage,
        agentName: currentAgent.name,
        turns: turn,
        trace,
      };
      return;
    }

    // Max turns reached without final answer
    const error = new MaxTurnsExceededError(maxTurns);
    const trace = await finalizeTrace(error);
    yield {
      type: "run_failed",
      error,
      messages,
      usage: totalUsage,
      agentName: currentAgent.name,
      turns: turn,
      trace,
    };
    return;
  } catch (err: any) {
    const error = err instanceof SaguError ? err : new SaguError(err.message ?? String(err), "SAGU_PROVIDER_ERROR");
    const trace = await finalizeTrace(error);
    yield {
      type: "run_failed",
      error,
      messages,
      usage: totalUsage,
      agentName: currentAgent.name,
      turns: turn,
      trace,
    };
  }
}

/**
 * Executes an agent run to completion by draining its event stream.
 * One loop, not two — returns typed RunResult without throwing on expected outcomes.
 */
export async function runAgent<TOutput = string>(
  agent: Agent<TOutput>,
  input: string,
  options: RunOptions = {}
): Promise<RunResult<TOutput>> {
  let finalResult: RunResult<TOutput> | undefined;

  for await (const event of streamAgent<TOutput>(agent, input, options)) {
    if (event.type === "run_completed") {
      finalResult = {
        success: true,
        output: event.output,
        messages: event.messages,
        usage: event.usage,
        agentName: event.agentName,
        turns: event.turns,
        trace: event.trace,
      };
    } else if (event.type === "run_failed") {
      finalResult = {
        success: false,
        error: event.error,
        messages: event.messages,
        usage: event.usage,
        agentName: event.agentName,
        turns: event.turns,
        trace: event.trace,
      };
    }
  }

  if (!finalResult) {
    throw new SaguError(
      "Agent run ended unexpectedly without emitting a completion or failure event",
      "SAGU_CONFIG_ERROR"
    );
  }

  return finalResult;
}
