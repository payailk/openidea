import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import type { AndroidDevice, FileEntry, RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useLogcat } from "@/features/logcat/store";
import { FLUTTER_ATTACH } from "@/features/debugger/flutterAttach";
import { DevicePicker, pickDevice, temporaryAttach, withDevice } from "./DevicePicker";
import { resetRuns, useRun } from "./store";

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
];

const ipc = vi.hoisted(() => ({
  devices: [] as AndroidDevice[],
  root: "/p",
  pubspec: true,
  subPubspec: false,
  saved: [] as unknown[],
}));

const entry = (name: string, kind: FileEntry["kind"], path: string): FileEntry => ({
  name,
  path,
  kind,
  size: 0,
  mtimeMs: null,
  ignored: false,
  excluded: false,
  hidden: false,
});

vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    call: (p: Promise<unknown>) => p,
    commands: {
      ...real.commands,
      androidDevices: () => Promise.resolve(ipc.devices),
      fsReadDir: (path: string) =>
        Promise.resolve(
          path === ipc.root
            ? [
                ...(ipc.pubspec ? [entry("pubspec.yaml", "file", `${path}/pubspec.yaml`)] : []),
                entry("app", "dir", `${path}/app`),
                entry("node_modules", "dir", `${path}/node_modules`),
              ]
            : ipc.subPubspec && path.endsWith("/app")
              ? [entry("pubspec.yaml", "file", `${path}/pubspec.yaml`)]
              : [],
        ),
      runConfigs: () => Promise.resolve(ipc.saved as RunConfig[]),
      runSaveConfigs: (configs: RunConfig[]) => {
        ipc.saved.splice(0, ipc.saved.length, ...configs);
        return Promise.resolve(null);
      },
      runWithoutDerived: (configs: RunConfig[]) => Promise.resolve(configs),
      runApplySettings: (configs: RunConfig[]) => Promise.resolve(configs),
    },
  };
});

const attach = (p: Partial<RunConfig> = {}): RunConfig => ({
  id: "flutter-attach",
  name: "Flutter Attach",
  kind: FLUTTER_ATTACH,
  command: "",
  args: [],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: "dart",
  params: { request: "attach" },
  ...p,
});

beforeEach(() => {
  ipc.devices = devices;
  ipc.root = "/p";
  ipc.pubspec = true;
  ipc.subPubspec = false;
  ipc.saved = [];
  resetRuns();
  useProject.setState({ project: { root: "/p", name: "p", trusted: true } as never });
  useRun.setState({ configs: [], selectedId: null, loaded: true, temporary: [] });
  useLogcat.setState({ serial: null });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("device chooser", () => {
  it("keeps the type's other params when the device changes", () => {
    const next = withDevice(attach({ params: { request: "attach", "vm-service-uri": "http://x/" } }), "HT7A1B2C3D4");
    expect(next.params).toEqual({ request: "attach", "vm-service-uri": "http://x/", device: "HT7A1B2C3D4" });
  });

  it("writes the device into the selected Flutter Attach configuration", async () => {
    useRun.setState({ configs: [attach()], selectedId: "flutter-attach" });
    await pickDevice("HT7A1B2C3D4");
    expect(useRun.getState().configs[0]?.params?.device).toBe("HT7A1B2C3D4");
  });

  it("adopts a temporary configuration when the project has none", async () => {
    const config = await pickDevice("HT7A1B2C3D4");
    expect(config.kind).toBe(FLUTTER_ATTACH);
    expect(config.params).toEqual({ request: "attach", device: "HT7A1B2C3D4" });
    expect(useRun.getState().temporary).toContain(config.id);
    expect(useRun.getState().selectedId).toBe(config.id);
  });

  it("selects the project's Flutter Attach configuration when another one is selected", async () => {
    const other: RunConfig = { ...attach({ id: "other", name: "Other", kind: "shell", command: "sh" }) };
    useRun.setState({ configs: [other, attach()], selectedId: "other" });
    await pickDevice("HT7A1B2C3D4");
    expect(useRun.getState().selectedId).toBe("flutter-attach");
    expect(useRun.getState().configs.find((c) => c.id === "flutter-attach")?.params?.device).toBe("HT7A1B2C3D4");
  });

  it("names a temporary configuration once", () => {
    expect(temporaryAttach("", []).name).toBe("Flutter Attach");
    expect(temporaryAttach("", [attach()]).name).toBe("Flutter Attach (2)");
    expect(temporaryAttach("", []).params).toEqual({ request: "attach", device: "" });
  });
});

describe("the title bar device chooser", () => {
  it("stays away from projects without a Flutter app", async () => {
    ipc.pubspec = false;
    render(<DevicePicker />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Device" })).toBeNull());
  });

  it("finds the Flutter module of an add-to-app project", async () => {
    ipc.pubspec = false;
    ipc.subPubspec = true;
    render(<DevicePicker />);
    expect(await screen.findByRole("button", { name: "Device" })).toBeTruthy();
  });

  it("lists the connected devices and writes the chosen one into the configuration", async () => {
    useRun.setState({ configs: [attach()], selectedId: "flutter-attach" });
    render(<DevicePicker />);
    let button: HTMLElement;
    await waitFor(() => {
      button = screen.getByRole("button", { name: "Device" });
      expect(button.textContent).toContain("Any connected device");
    });
    fireEvent.click(screen.getByRole("button", { name: "Device" }));
    const item = await screen.findByText("Generic_Phone");
    fireEvent.click(item);
    await waitFor(() => expect(useRun.getState().configs[0]?.params?.device).toBe("HT7A1B2C3D4"));
    // The Logcat tool window follows the same device.
    expect(useLogcat.getState().serial).toBe("HT7A1B2C3D4");
  });
});
