import type { Express } from "express";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach } from "vitest";

const listeners = new Map<Express, Promise<Server>>();
/** Supertest assumes an address exists synchronously. Await loopback binding first. */
export async function loopbackRequest(app: Express) {
  if (!listeners.has(app)) listeners.set(app, new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  }));
  return request(await listeners.get(app)!);
}
afterEach(async () => {
  const pending = [...listeners.values()]; listeners.clear();
  for (const listener of pending) {
    const server = await listener;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
