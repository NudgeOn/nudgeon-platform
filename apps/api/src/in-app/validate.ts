import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { BundleError } from "./bundle";
import type { Artifact } from "./assets.service";
let active = 0;
/** Untrusted parsing is CPU/memory bounded outside the API event loop. */
export async function validateBundle(input: unknown): Promise<Artifact> {
  if (active >= 2)
    throw new BundleError(
      "VALIDATION_BUSY",
      "Two uploads are being validated; retry shortly",
    );
  active++;
  try {
    return await new Promise<Artifact>((resolve, reject) => {
      const source = __filename.endsWith(".ts");
      const worker = new Worker(
        join(__dirname, `validate-worker.${source ? "ts" : "js"}`),
        {
          workerData: input,
          execArgv: source ? ["-r", "ts-node/register/transpile-only"] : [],
          resourceLimits: {
            maxOldGenerationSizeMb: 192,
            maxYoungGenerationSizeMb: 32,
          },
        },
      );
      let settled = false;
      const done = (error?: Error, value?: Artifact) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        error ? reject(error) : resolve(value!);
      };
      const timer = setTimeout(
        () =>
          done(
            new BundleError(
              "VALIDATION_TIMEOUT",
              "Validation exceeded 15 seconds",
            ),
          ),
        15000,
      );
      worker.once("message", (r) =>
        r.ok
          ? done(undefined, r.artifact)
          : done(
              new BundleError(
                "INVALID_BUNDLE",
                String(r.message).slice(0, 300),
              ),
            ),
      );
      worker.once("error", () =>
        done(new BundleError("INVALID_BUNDLE", "Validation worker failed")),
      );
      worker.once("exit", () => {
        if (!settled)
          done(new BundleError("INVALID_BUNDLE", "Validation worker stopped"));
      });
    });
  } finally {
    active--;
  }
}
