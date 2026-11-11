import { createHash } from "node:crypto";

/** Fixed namespace for Loadline's deterministic demo ids (RFC 4122 name-based, version 5). */
export const LOADLINE_NAMESPACE = "7a0b6c3e-2f1d-5e4a-9b8c-1d2e3f4a5b6c";

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

/** uuidv5(namespace, name): the same name always yields the same id. Used only by the seed. */
export function uuidv5(name: string, namespace = LOADLINE_NAMESPACE): string {
  const hash = createHash("sha1").update(uuidToBytes(namespace)).update(name, "utf8").digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50; // version 5
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
