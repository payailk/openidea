/**
 * Flutter Attach: debug an app that is already running on a device — the
 * add-to-app case, where the host APK is built and installed by Gradle, so the
 * debugger must attach to the running app instead of launching `lib/main.dart`.
 *
 * `params.request = "attach"` routes the configuration to `flutterAttach()`
 * (`debugger/launch.ts`), which passes the device to `flutter attach -d` and,
 * when one is given, the VM Service URI to `--debug-uri`. Without a URI,
 * `flutter attach` finds the running app on that device by itself.
 */
import { call, commands, type AndroidDevice } from "@/platform/ipc";
import type { RunConfigTypeContribution } from "@/workbench/contributions";

export const FLUTTER_ATTACH = "flutter-attach";

/**
 * Devices offered in the form: the same `adb devices -l` call the Logcat tool
 * window uses, limited to the ones a debugger can attach to.
 */
export async function deviceOptions(): Promise<ReadonlyArray<{ value: string; label: string; detail?: string }>> {
  const any = { value: "", label: "Any connected device" };
  try {
    const devices = await call(commands.androidDevices());
    return [any, ...devices.filter((d) => d.state === "device").map(deviceOption)];
  } catch {
    // No adb, or a device list that failed: the form still offers "any device",
    // and `flutter attach` picks the connected one itself.
    return [any];
  }
}

function deviceOption(d: AndroidDevice) {
  return { value: d.serial, label: d.model ? `${d.model} (${d.serial})` : d.serial };
}

export const flutterAttachType: RunConfigTypeContribution = {
  id: FLUTTER_ATTACH,
  label: "Flutter Attach",
  icon: "attach-to-process",
  description: "Attach the debugger to a Flutter app that is already running on a device",
  debugOnly: true,
  debugAdapter: "dart",
  defaults: { request: "attach" },
  fields: [
    {
      key: "device",
      label: "Device",
      control: "select",
      loadOptions: deviceOptions,
      hint: "Connected through adb, like the Logcat tool window. Any connected device lets flutter attach pick the only one.",
    },
    {
      key: "vm-service-uri",
      label: "VM Service URI",
      mono: true,
      placeholder: "http://127.0.0.1:8181/",
      hint: "Leave empty to let flutter attach find the running app; a URI pins the endpoint it attaches to.",
    },
  ],
  commandLine: () => null,
};
