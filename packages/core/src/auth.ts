/**
 * Timing-safe string compare for bearer tokens / HMAC checks.
 * Same pattern agentmemory uses for `AGENTMEMORY_SECRET`.
 *
 * Constant-time: takes the same time regardless of where the first
 * difference appears, so attackers can't iteratively guess characters
 * via response timing.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function timingSafeCompare(a: string, b: string): boolean {
  // Hash both to identical length first — `timingSafeEqual` requires
  // equal-length inputs and would itself leak length otherwise.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
