import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ownsConsoleWindow, shouldShowWelcome, welcomeText } from "../cli/windows_console.ts";

Deno.test("shouldShowWelcome: windows with its own console and no args shows it", () => {
  assert(shouldShowWelcome({ os: "windows", ownsConsole: true, argCount: 0 }));
});

Deno.test("shouldShowWelcome: windows launched from a shell does not show it", () => {
  assertEquals(shouldShowWelcome({ os: "windows", ownsConsole: false, argCount: 0 }), false);
});

Deno.test("shouldShowWelcome: linux and macOS never show it", () => {
  for (const os of ["linux", "darwin"]) {
    for (const ownsConsole of [true, false]) {
      assertEquals(
        shouldShowWelcome({ os, ownsConsole, argCount: 0 }),
        false,
        `${os}/${ownsConsole}`,
      );
    }
  }
});

Deno.test("shouldShowWelcome: any arg count other than zero does not show it", () => {
  for (const argCount of [1, 2, 5]) {
    assertEquals(shouldShowWelcome({ os: "windows", ownsConsole: true, argCount }), false);
  }
});

Deno.test("welcomeText names the exe and the three first commands", () => {
  const text = welcomeText("hertzbench.exe");
  assertStringIncludes(text, "command-line tool");
  assertStringIncludes(text, "terminal in this folder");
  for (const command of ["examples", "run", "view"]) {
    assertStringIncludes(text, `hertzbench.exe ${command}`);
  }
});

Deno.test("ownsConsoleWindow returns false without throwing off Windows or without FFI", () => {
  if (Deno.build.os === "windows") return;
  assertEquals(ownsConsoleWindow(), false);
});
