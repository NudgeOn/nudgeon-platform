import { parentPort, workerData } from "node:worker_threads";
import { compileBundle, unpackArchive } from "./bundle";
if (parentPort) {
  try {
    parentPort.postMessage({
      ok: true,
      artifact: compileBundle(
        workerData.files ??
          unpackArchive(Buffer.from(workerData.archive_base64, "base64")),
        workerData.manifest,
      ),
    });
  } catch (e) {
    parentPort.postMessage({
      ok: false,
      message: e instanceof Error ? e.message : "Invalid bundle",
    });
  }
}
