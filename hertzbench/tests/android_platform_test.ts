import { assertEquals } from "@std/assert";
import {
  adbExecutableName,
  type AndroidPlatform,
  defaultSdkRoot,
  emulatorExecutableName,
  joinHostPath,
  resolveSdkRoot,
} from "../orchestrator/boards/android/platform.ts";
import { fakeCommandRunner, fakeHostEnv, fakeSdk } from "./android_fake_sdk.ts";
import { skipOnWindows } from "./platform.ts";

const fakeSdkTest = skipOnWindows("the fake emulator and adb are sh scripts");

const PLATFORMS: AndroidPlatform[] = ["linux", "windows", "darwin"];

Deno.test("executable names carry .exe on windows only", () => {
  for (const platform of PLATFORMS) {
    const suffix = platform === "windows" ? ".exe" : "";
    assertEquals(emulatorExecutableName(platform), `emulator${suffix}`);
    assertEquals(adbExecutableName(platform), `adb${suffix}`);
  }
});

Deno.test("default SDK root per platform", () => {
  assertEquals(defaultSdkRoot(fakeHostEnv("linux")), "/home/tester/Android/Sdk");
  assertEquals(defaultSdkRoot(fakeHostEnv("darwin")), "/Users/tester/Library/Android/sdk");
  assertEquals(
    defaultSdkRoot(fakeHostEnv("windows")),
    "C:\\Users\\tester\\AppData\\Local\\Android\\Sdk",
  );
});

Deno.test("windows default SDK root follows localAppData and falls back to the home", () => {
  assertEquals(
    defaultSdkRoot(fakeHostEnv("windows", { localAppData: "D:\\Local" })),
    "D:\\Local\\Android\\Sdk",
  );
  assertEquals(
    defaultSdkRoot(fakeHostEnv("windows", { localAppData: undefined })),
    "C:\\Users\\tester\\AppData\\Local\\Android\\Sdk",
  );
});

Deno.test("SDK lookup order is ANDROID_HOME, ANDROID_SDK_ROOT, then the default", () => {
  const host = fakeHostEnv("linux", { env: { ANDROID_HOME: "/a", ANDROID_SDK_ROOT: "/b" } });
  const all = () => true;
  assertEquals(resolveSdkRoot(host, all), "/a");
  assertEquals(resolveSdkRoot(host, (p) => p !== "/a"), "/b");
  assertEquals(resolveSdkRoot(host, (p) => p === defaultSdkRoot(host)), "/home/tester/Android/Sdk");
  assertEquals(resolveSdkRoot(host, () => false), undefined);
});

Deno.test("SDK lookup ignores empty variables and uses the platform default", () => {
  const darwin = fakeHostEnv("darwin", { env: { ANDROID_HOME: "", ANDROID_SDK_ROOT: undefined } });
  assertEquals(resolveSdkRoot(darwin, () => true), "/Users/tester/Library/Android/sdk");
  const windows = fakeHostEnv("windows");
  assertEquals(
    resolveSdkRoot(windows, () => true),
    "C:\\Users\\tester\\AppData\\Local\\Android\\Sdk",
  );
});

Deno.test("SDK lookup checks the real file system by default", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hzb-platform-" });
  try {
    const host = fakeHostEnv("linux", { home: dir, env: { ANDROID_HOME: `${dir}/missing` } });
    assertEquals(resolveSdkRoot(host), undefined);
    await Deno.mkdir(`${dir}/Android/Sdk`, { recursive: true });
    assertEquals(resolveSdkRoot(host), `${dir}/Android/Sdk`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("joinHostPath uses backslashes on windows and slashes elsewhere", () => {
  assertEquals(
    joinHostPath(fakeHostEnv("windows"), "C:\\Sdk", "platform-tools", "adb.exe"),
    "C:\\Sdk\\platform-tools\\adb.exe",
  );
  assertEquals(
    joinHostPath(fakeHostEnv("windows"), "C:\\Sdk", "emulator/emulator.exe"),
    "C:\\Sdk\\emulator\\emulator.exe",
  );
  assertEquals(joinHostPath(fakeHostEnv("linux"), "/sdk", "emulator"), "/sdk/emulator");
  assertEquals(joinHostPath(fakeHostEnv("darwin"), "/sdk", "adb"), "/sdk/adb");
});

fakeSdkTest("fake SDK names its tools per platform", async () => {
  for (const platform of PLATFORMS) {
    const sdk = await fakeSdk("", undefined, platform);
    try {
      assertEquals(sdk.emulator.endsWith(emulatorExecutableName(platform)), true);
      assertEquals(sdk.adb.endsWith(adbExecutableName(platform)), true);
      assertEquals((await Deno.stat(sdk.emulator)).isFile, true);
      assertEquals((await Deno.stat(sdk.adb)).isFile, true);
    } finally {
      await sdk.restore();
    }
  }
});

Deno.test("fake command runner records calls and returns scripted results", async () => {
  const runner = fakeCommandRunner((cmd) => cmd === "bad" ? { code: 1, stderr: "no" } : undefined);
  assertEquals(await runner.run("ok", ["-a"]), { code: 0, stdout: "", stderr: "" });
  assertEquals(await runner.run("bad", []), { code: 1, stdout: "", stderr: "no" });
  assertEquals(runner.calls, [{ cmd: "ok", args: ["-a"] }, { cmd: "bad", args: [] }]);
});
