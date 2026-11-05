import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AndroidDevice, RunConfig } from "@/platform/ipc";
import { FLUTTER_ATTACH, deviceOptions, flutterAttachType } from "../flutterAttach";
import { launchConfigFor } from "../launch";

const devices: AndroidDevice[] = [
  {
    serial: "HT7A1B2C3D4",
    state: "device",
    model: "Generic_Phone",
    product: "generic",
    device: "generic",
    transportId: "1",
  },
  { serial: "emulator-5554", state: "offline", model: null, product: null, device: null, transportId: "2" },
  { serial: "0123456789ABCDEF", state: "unauthorized", model: null, product: null, device: null, transportId: "3" },
];

const ipc = vi.hoisted(() => ({ devices: [] as AndroidDevice[], fail: false }));

vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    call: (p: Promise<unknown>) => p,
    commands: {
      ...real.commands,
      androidDevices: () =>
        ipc.fail ? Promise.reject(new Error("adb is not installed")) : Promise.resolve(ipc.devices),
    },
  };
});

const rc = (p: Partial<RunConfig>): RunConfig => ({
  id: "x",
  name: "Flutter",
  kind: FLUTTER_ATTACH,
  command: "",
  args: [],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: "dart",
  ...p,
});

describe("Flutter Attach configuration", () => {
  beforeEach(() => {
    ipc.devices = devices;
    ipc.fail = false;
  });

  it("is a debugger-only Dart configuration", () => {
    expect(flutterAttachType.debugOnly).toBe(true);
    expect(flutterAttachType.debugAdapter).toBe("dart");
    expect(flutterAttachType.commandLine({})).toBeNull();
    expect(flutterAttachType.defaults).toMatchObject({ request: "attach" });
  });

  it("offers the devices adb reports as usable, plus any device", async () => {
    expect(await deviceOptions()).toEqual([
      { value: "", label: "Any connected device" },
      { value: "HT7A1B2C3D4", label: "Generic_Phone (HT7A1B2C3D4)" },
    ]);
  });

  it("still offers any device when adb is missing", async () => {
    ipc.fail = true;
    expect(await deviceOptions()).toEqual([{ value: "", label: "Any connected device" }]);
  });

  it("attaches to the chosen device, with or without a VM Service URI", () => {
    const withDevice = launchConfigFor(rc({ params: { request: "attach", device: "HT7A1B2C3D4" } }), "/p");
    expect(withDevice).toMatchObject({ request: "attach", program: null, adapter: "dart" });
    expect(JSON.parse(withDevice!.extraJson!)).toEqual({ __flutter: true, toolArgs: ["-d", "HT7A1B2C3D4"] });

    const withUri = launchConfigFor(
      rc({ params: { request: "attach", "vm-service-uri": "http://127.0.0.1:8181/abc/" } }),
      "/p",
    );
    expect(JSON.parse(withUri!.extraJson!)).toEqual({
      __flutter: true,
      vmServiceUri: "http://127.0.0.1:8181/abc/",
    });
  });

  it("launches the entry point when the configuration does not attach", () => {
    const launched = launchConfigFor(rc({ params: {} }), "/p");
    expect(launched).toMatchObject({ request: "launch", program: "/p/lib/main.dart" });
  });
});
