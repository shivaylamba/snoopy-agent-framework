/**
 * Buffered boot logging.
 *
 * Lets the worker queue startup lines during the noisy iii/OTel handshake
 * and flush them in a clean block once the worker is ready. Falls back to
 * direct stdout when `SNOOPY_BOOT_VERBOSE=1`.
 */
const buffer: string[] = [];
let flushed = false;

const VERBOSE = process.env.SNOOPY_BOOT_VERBOSE === "1";

export function bootLog(line: string): void {
  if (VERBOSE) {
    console.log(`[snoopy] ${line}`);
    return;
  }
  buffer.push(line);
}

export function flushBootLog(): void {
  if (flushed) return;
  flushed = true;
  if (buffer.length === 0) return;
  console.log("\n──── snoopy worker ────");
  for (const line of buffer) console.log(`  ${line}`);
  console.log("───────────────────────\n");
  buffer.length = 0;
}
