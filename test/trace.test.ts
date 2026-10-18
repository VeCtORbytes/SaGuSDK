import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceRecorder, ConsoleExporter, JSONFileExporter } from "../src/trace.ts";
import { Agent } from "../src/agent.ts";
import { mock } from "../src/providers/mock.ts";
import { defineTool } from "../src/tool.ts";
import { z } from "zod";
import type { Trace } from "../src/types.ts";

test("TraceRecorder - creates spans with parent hierarchy and accumulates usage", () => {
  const recorder = new TraceRecorder("test_run_123");

  const rootSpanId = recorder.startSpan("root_task", { task: "research" });
  assert.equal(typeof rootSpanId, "string");

  const childSpanId = recorder.startSpan("child_task", { step: 1 });
  recorder.endSpan(childSpanId, { stepDone: true });

  recorder.recordUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  recorder.endSpan(rootSpanId);
  recorder.finish();

  const trace = recorder.getTrace();
  assert.equal(trace.runId, "test_run_123");
  assert.equal(trace.spans.length, 2);

  const rootSpan = trace.spans.find((s) => s.id === rootSpanId);
  const childSpan = trace.spans.find((s) => s.id === childSpanId);

  assert.equal(rootSpan?.parentId, undefined);
  assert.equal(childSpan?.parentId, rootSpanId);
  assert.equal(childSpan?.attributes.stepDone, true);
  assert.equal(trace.usage.totalTokens, 150);
});

test("TraceRecorder - redacts secret attributes", () => {
  const recorder = new TraceRecorder("sec_run");
  const spanId = recorder.startSpan("auth_step", {
    apiKey: "sk-abcdef1234567890abcdef1234567890",
    safeField: "ok",
  });
  recorder.endSpan(spanId);
  recorder.finish();

  const trace = recorder.getTrace();
  assert.equal(trace.spans[0]?.attributes.apiKey, "[REDACTED_SECRET]");
  assert.equal(trace.spans[0]?.attributes.safeField, "ok");
});

test("JSONFileExporter - writes formatted JSON trace to disk", async () => {
  const tempDir = join(tmpdir(), `sagu_traces_${Date.now()}`);
  const exporter = new JSONFileExporter({ outputDir: tempDir });

  const mockTrace: Trace = {
    runId: "trace_export_test",
    spans: [
      {
        id: "s1",
        name: "test_span",
        startTime: 1000,
        endTime: 1050,
        attributes: { status: "complete" },
      },
    ],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    startTime: 1000,
    endTime: 1050,
  };

  await exporter.export(mockTrace);

  const expectedFile = join(tempDir, "trace-trace_export_test.json");
  assert.equal(existsSync(expectedFile), true);

  const content = JSON.parse(readFileSync(expectedFile, "utf-8")) as Trace;
  assert.equal(content.runId, "trace_export_test");
  assert.equal(content.spans.length, 1);

  rmSync(tempDir, { recursive: true, force: true });
});

test("ConsoleExporter - formats and logs trace without throwing", () => {
  const exporter = new ConsoleExporter();
  const mockTrace: Trace = {
    runId: "console_test",
    spans: [
      {
        id: "root",
        name: "agent_run",
        startTime: Date.now() - 100,
        endTime: Date.now(),
        attributes: { agent: "testAgent" },
      },
      {
        id: "child1",
        parentId: "root",
        name: "tool_execution",
        startTime: Date.now() - 80,
        endTime: Date.now() - 20,
        attributes: { tool: "calc" },
      },
    ],
    usage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
    startTime: Date.now() - 100,
    endTime: Date.now(),
  };

  // Should execute cleanly
  exporter.export(mockTrace);
});

test("Agent Run - emits trace with spans attached to RunResult and invokes exporter", async () => {
  let exportedTrace: Trace | undefined;

  const tool = defineTool({
    name: "ping",
    description: "Ping",
    input: z.object({}),
    execute: async () => ({ pong: true }),
  });

  const agent = new Agent({
    name: "traced_agent",
    instructions: "Answer queries.",
    model: mock([
      {
        toolCalls: [{ id: "c1", name: "ping", arguments: {} }],
      },
      "Pong acknowledged.",
    ]),
    tools: [tool],
  });

  const res = await agent.run("Ping the system", {
    traceExporter: {
      export: (trace) => {
        exportedTrace = trace;
      },
    },
  });

  assert.equal(res.success, true);
  assert(res.trace);
  assert(exportedTrace);
  assert.equal(res.trace.runId, exportedTrace.runId);

  // Spans should include agent_run, model_call, tool_execution
  const spanNames = res.trace.spans.map((s) => s.name);
  assert(spanNames.includes("agent_run"));
  assert(spanNames.includes("model_call"));
  assert(spanNames.includes("tool_execution"));
});
