import type { Context } from "hono";

export function notImplemented(message = "Not implemented") {
  return (c: Context) => c.json({ error: message }, 501);
}
