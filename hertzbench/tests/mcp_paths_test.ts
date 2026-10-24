// Path-taking MCP tools stay inside the workspace (and the bundled examples,
// read-only), through the real `hertzbench mcp` process.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EXAMPLES, withServer } from "./mcp_client.ts";
import { IS_WINDOWS } from "./platform.ts";

const SHORT = `name: two-nodes
seed: 5
duration: 1500ms
nodes:
  - id: a
    board: scripted
    position: [0, 0]
    firmware: {}
  - { id: b, board: scripted, position: [5, 0], firmware: {} }
`;

const SECRET = "secret: not a scenario\n";

async function withOutside(
  body: (outside: string) => Promise<void>,
): Promise<void> {
  const outside = await Deno.makeTempDir({ prefix: "hzb-paths-outside-" });
  try {
    await Deno.writeTextFile(`${outside}/secret.yaml`, SECRET);
    await body(outside);
  } finally {
    await Deno.remove(outside, { recursive: true });
  }
}

const READERS = ["read_scenario", "validate_scenario", "run_scenario"] as const;

Deno.test("mcp paths: no reader leaves the roots by absolute path or ..", async () => {
  await withOutside(async (outside) => {
    await withServer(async (client, workspace) => {
      const hostile = [
        `${outside}/secret.yaml`,
        `${workspace}/../${outside.split(/[\\/]/).pop()}/secret.yaml`,
        "../../../../../../../../etc/passwd",
        `${outside}/does-not-exist.yaml`,
      ];
      for (const tool of READERS) {
        for (const path of hostile) {
          const text = await client.refused(tool, { path });
          assertStringIncludes(text, "must be inside the workspace", `${tool} ${path}`);
          assertEquals(text.includes(SECRET.trim()), false, "file text never reaches the caller");
        }
      }
    });
  });
});

Deno.test("mcp paths: a NUL byte is refused", async () => {
  await withServer(async (client) => {
    for (const tool of READERS) {
      assertStringIncludes(
        await client.refused(tool, { path: "ok.yaml\0/../../etc/passwd" }),
        "NUL",
        tool,
      );
    }
    assertStringIncludes(
      await client.refused("create_scenario", { path: "a\0.yaml", yaml: SHORT }),
      "NUL",
    );
  });
});

Deno.test("mcp paths: a symlink out of the workspace is refused, a dangling one too", async () => {
  if (IS_WINDOWS) return; // ponytail: creating symlinks needs privileges on Windows; covered on Linux and macOS
  await withOutside(async (outside) => {
    await withServer(async (client, workspace) => {
      await Deno.symlink(`${outside}/secret.yaml`, `${workspace}/file-link.yaml`);
      await Deno.symlink(outside, `${workspace}/dir-link`);
      await Deno.symlink(`${outside}/nowhere.yaml`, `${workspace}/dangling.yaml`);
      for (const path of ["file-link.yaml", "dir-link/secret.yaml", "dangling.yaml"]) {
        for (const tool of READERS) {
          assertStringIncludes(
            await client.refused(tool, { path }),
            "must be inside the workspace",
            `${tool} ${path}`,
          );
        }
      }
    });
  });
});

Deno.test("mcp paths: files in the workspace, a link that stays inside, and the examples still read", async () => {
  await withServer(async (client, workspace) => {
    await client.ok("create_scenario", { path: "sub/s.yaml", yaml: SHORT });
    await Deno.symlink(`${workspace}/sub`, `${workspace}/alias`).catch(() => {
      if (!IS_WINDOWS) throw new Error("symlink failed");
    });
    assertEquals((await client.ok("read_scenario", { path: "sub/s.yaml" })).valid, true);
    assertEquals(
      (await client.ok("read_scenario", { path: `${workspace}/sub/s.yaml` })).valid,
      true,
    );
    if (!IS_WINDOWS) {
      assertEquals((await client.ok("read_scenario", { path: "alias/s.yaml" })).valid, true);
    }
    assertEquals(
      (await client.ok("validate_scenario", { path: `${EXAMPLES}live-3-scripted.yaml` })).ok,
      true,
    );
    // Inside the roots but absent: the usual not-found, not a path-policy answer.
    const absent = await client.refused("read_scenario", { path: "sub/none.yaml" });
    assertStringIncludes(absent, "does not exist");
  });
});

Deno.test("mcp paths: the examples are readable but never writable", async () => {
  await withServer(async (client) => {
    assertStringIncludes(
      await client.refused("edit_scenario", {
        path: `${EXAMPLES}live-3-scripted.yaml`,
        set: { seed: 1 },
      }),
      "must be inside the workspace",
    );
  });
});
