/**
 * Title bar device chooser for Flutter projects: the connected adb devices, read
 * with the same `adb devices -l` call the Logcat tool window uses.
 *
 * Choosing a device writes it into the selected Flutter Attach configuration.
 * With none selected, the choice selects the project's Flutter Attach
 * configuration, and with none at all it adopts a temporary one, so Debug
 * attaches without a trip to Run/Debug Configurations.
 *
 * The Logcat tool window follows the same device. It does not steer this
 * chooser back: the attach target is never changed behind the user's back.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { BarButton, Icon, Menu, type MenuItem } from "@/ui";
import { call, commands, isTauri, type AndroidDevice, type FileEntry, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useTx } from "@/platform/i18n";
import { FLUTTER_ATTACH } from "@/features/debugger/flutterAttach";
import { setDevices as setLogcatDevices, useLogcat } from "@/features/logcat/store";
import { uniqueName } from "./configs";
import { adoptTemporary, persistTemporary, saveUserConfigs, selectConfig, useRun } from "./store";
import { withParams } from "./types";
import styles from "./Run.module.css";

/** `<project root>`: the device the chooser last settled on, per project. */
const CHOSEN_KEY = "openidea.flutter.device.v1:";

/** Folders that never hold the Flutter module of an add-to-app project. */
const FOLDERS_SKIPPED = new Set(["node_modules", "build", ".git", ".dart_tool", ".gradle", "target", "dist", "out"]);

/** How many folders below the root are checked for a `pubspec.yaml`. */
const MAX_SCANNED = 12;

function readChosen(root: string | null): string {
  try {
    return (root && localStorage.getItem(CHOSEN_KEY + root)) ?? "";
  } catch {
    return "";
  }
}

function writeChosen(root: string | null, serial: string) {
  try {
    if (!root) return;
    if (serial) localStorage.setItem(CHOSEN_KEY + root, serial);
    else localStorage.removeItem(CHOSEN_KEY + root);
  } catch {
    /* storage unavailable */
  }
}

async function readDir(path: string): Promise<FileEntry[]> {
  if (!isTauri()) return [];
  return call(commands.fsReadDir(path)).catch(() => []);
}

async function hasPubspec(dir: string): Promise<boolean> {
  return (await readDir(dir)).some((e) => e.name === "pubspec.yaml" && e.kind !== "dir");
}

/** The add-to-app layout: the Flutter module one level below the Android host. */
async function hasPubspecBelow(root: string): Promise<boolean> {
  const dirs = (await readDir(root))
    .filter((e) => e.kind === "dir" && !e.ignored && !FOLDERS_SKIPPED.has(e.name))
    .slice(0, MAX_SCANNED);
  const found = await Promise.all(dirs.map((d) => hasPubspec(d.path)));
  return found.some(Boolean);
}

/**
 * Whether this project holds a Flutter app: a `pubspec.yaml` at the root, or one
 * level down — the add-to-app layout, where the Flutter module sits under the
 * Android host that OpenIDEA opens.
 */
function useFlutterProject(root: string | null): boolean {
  const [found, setFound] = useState<{ root: string; flutter: boolean } | null>(null);
  useEffect(() => {
    if (!root) return;
    let live = true;
    void (async () => {
      const flutter = (await hasPubspec(root)) || (await hasPubspecBelow(root));
      if (live) setFound({ root, flutter });
    })();
    return () => {
      live = false;
    };
  }, [root]);
  // A result from the previous project says nothing about this one.
  return !!root && found?.root === root && found.flutter;
}

/** `config` with its device, keeping the type's other params. */
export function withDevice(config: RunConfig, serial: string): RunConfig {
  return withParams(config, { ...(config.params ?? {}), device: serial });
}

/** A Flutter Attach configuration for `serial` that is not saved until the user saves it. */
export function temporaryAttach(serial: string, configs: readonly RunConfig[]): RunConfig {
  return {
    id: `flutter-attach:${serial || "any"}`,
    name: uniqueName("Flutter Attach", configs),
    kind: FLUTTER_ATTACH,
    command: "",
    args: [],
    cwd: null,
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: "dart",
    params: { request: "attach", device: serial },
  };
}

const isFlutterAttach = (c: RunConfig | undefined): c is RunConfig => c?.kind === FLUTTER_ATTACH;

/**
 * Writes `serial` into the Flutter Attach configuration this project debugs with,
 * adopting a temporary one when it has none, and returns that configuration.
 */
export async function pickDevice(serial: string): Promise<RunConfig> {
  const state = useRun.getState();
  const selected = state.configs.find((c) => c.id === state.selectedId);
  const existing = isFlutterAttach(selected) ? selected : state.configs.find(isFlutterAttach);
  if (!existing) return adoptTemporary(temporaryAttach(serial, state.configs));

  const next = withDevice(existing, serial);
  const configs = state.configs.map((c) => (c.id === next.id ? next : c));
  useRun.setState({ configs });
  if (state.selectedId !== next.id) selectConfig(next.id);
  if (state.temporary.includes(next.id)) {
    persistTemporary();
  } else if (!next.detected) {
    const user = configs.filter((c) => !c.detected && !state.temporary.includes(c.id));
    await saveUserConfigs(user).catch(() => {});
  }
  return next;
}

function deviceName(d: AndroidDevice): string {
  return d.model && d.model !== "unknown" ? d.model : d.serial;
}

export function DevicePicker() {
  const tx = useTx();
  const root = useProject((s) => s.project?.root ?? null);
  const flutter = useFlutterProject(root);
  const configs = useRun((s) => s.configs);
  const selectedId = useRun((s) => s.selectedId);
  const selected = configs.find((c) => c.id === selectedId);
  const [devices, setDevices] = useState<AndroidDevice[]>([]);
  const [chosen, setChosen] = useState(() => readChosen(root));
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  // The configuration's own device wins; the last choice covers the case with no
  // Flutter Attach configuration yet.
  const current = isFlutterAttach(selected) ? (selected.params?.device ?? "") : chosen;
  const connected = devices.filter((d) => d.state === "device");
  const shown = devices.find((d) => d.serial === current);

  useEffect(() => {
    setChosen(readChosen(root));
  }, [root]);

  async function refresh() {
    if (!isTauri()) return;
    const list = await call(commands.androidDevices()).catch(() => [] as AndroidDevice[]);
    setDevices(list);
    setLogcatDevices(list);
  }

  // Devices are listed when the project opens and every time the menu opens:
  // plugging a phone in is followed without polling adb in the background.
  useEffect(() => {
    if (!flutter) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flutter, root]);

  if (!flutter) return null;

  const label = current ? (shown ? deviceName(shown) : current) : tx("Any connected device");

  async function choose(serial: string) {
    setOpen(false);
    setChosen(serial);
    writeChosen(root, serial);
    useLogcat.setState({ serial: serial || null });
    await pickDevice(serial).catch(() => {});
  }

  const items: MenuItem[] = [
    { kind: "item", label: "Any connected device", checked: current === "", run: () => void choose("") },
    ...devices.map((d): MenuItem => ({
      kind: "item",
      label: d.state === "device" ? deviceName(d) : `${deviceName(d)} — ${d.state}`,
      verbatim: true,
      checked: current === d.serial,
      disabled: d.state !== "device",
      run: () => void choose(d.serial),
    })),
    { kind: "separator" },
    { kind: "item", label: "Refresh devices", icon: "refresh", run: () => void refresh() },
  ];

  return (
    <>
      <BarButton
        ref={button}
        variant="title"
        className={clsx(styles.widgetChooser, styles.widgetDevice)}
        tooltip={connected.length ? tx`Device — ${label}` : tx("No devices")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={tx("Device")}
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void refresh();
        }}
      >
        <span className={styles.widgetName}>{label}</span>
        <Icon name="chevron-down" size={14} className={styles.widgetChevron} />
      </BarButton>
      <Menu open={open} anchor={button} items={items} placement="bottom-start" onClose={() => setOpen(false)} />
    </>
  );
}
