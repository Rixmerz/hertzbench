// The MCP tools an agent drives the whole simulator with, through the real
// `hertzbench mcp` process: link chaos, the channel and radios of a live run,
// serial input, the event stream, captures, scenario edits and the view.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EXAMPLES, type Json, pollMetrics, pollStatus, withServer } from "./mcp_client.ts";

const LIVE = `${EXAMPLES}live-3-scripted.yaml`;

const link = (m: Json, phase: string, from: string, to: string) =>
  m.phases.find((p: Json) => p.label === phase)?.links.find((l: Json) =>
    l.from === from && l.to === to
  );

Deno.test("mcp drive: inject_fault adds jitter and interference; interference costs frames by itself", async () => {
  await withServer(async (client) => {
    await client.ok("run_scenario", { path: LIVE });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");

    const fault = await client.ok("inject_fault", {
      link: "a->b",
      interference_db: 80,
      extra_jitter_ms: 5,
      phase: "jammed",
    });
    assertEquals(
      [fault.links, fault.interference_db, fault.extra_jitter_ms, fault.extra_loss_pct],
      [["a->b"], 80, 5, 0],
    );
    // 80 dB of noise rise at b: no rate decodes, so the MAC gives up; nothing is forced lost.
    const jammed = await pollMetrics(
      client,
      (m) => (link(m, "jammed", "a", "b")?.dropped.retry_exhausted ?? 0) >= 2,
    );
    assertEquals(link(jammed, "jammed", "a", "b").delivered, 0);
    assertEquals(link(jammed, "jammed", "a", "b").dropped.extra_loss, undefined);
    assertEquals(link(jammed, "jammed", "b", "a").delivered > 0, true, "b->a is not jammed");

    assertStringIncludes(
      await client.refused("inject_fault", { link: "a->b", interference_db: -1 }),
      "interference_db",
    );
    await client.ok("stop");
  });
});
