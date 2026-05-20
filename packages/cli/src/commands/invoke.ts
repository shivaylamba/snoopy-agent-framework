import kleur from "kleur";
import { registerWorker } from "iii-sdk";

interface InvokeOpts {
  payload?: string;
  payloadFile?: string;
  timeoutMs?: string;
}

/**
 * Direct synchronous invocation of a registered agent. Reads the payload
 * from --payload (inline JSON) or --payload-file (path to a JSON file),
 * routes it through iii with no trigger action so we await the return
 * value, then prints the result.
 */
export async function invokeCommand(agentId: string, opts: InvokeOpts) {
  const payload = await resolvePayload(opts);

  const iii = registerWorker(process.env.III_WS_URL ?? "ws://localhost:49134", {
    workerName: `snoopy-invoke-${process.pid}`,
  });

  console.log(kleur.cyan("→"), `invoke ${agentId}`);
  console.log(kleur.dim("payload:"), JSON.stringify(payload));

  try {
    const result = await iii.trigger({
      function_id: agentId,
      payload,
      timeoutMs: opts.timeoutMs ? Number(opts.timeoutMs) : undefined,
    });
    console.log(kleur.green("✓ result:"));
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err: any) {
    console.error(kleur.red("✗ error:"), err?.message ?? String(err));
    if (err?.code) console.error(kleur.dim("code:"), err.code);
    process.exit(1);
  }
}

async function resolvePayload(opts: InvokeOpts): Promise<unknown> {
  if (opts.payload) return JSON.parse(opts.payload);
  if (opts.payloadFile) {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(opts.payloadFile, "utf-8");
    return JSON.parse(raw);
  }
  return {};
}
