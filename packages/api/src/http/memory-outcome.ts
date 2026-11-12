import type { Response } from "express";

import { MemoryConflictError, MemoryNotFoundError, MemoryValidationError } from "../memory/memory-service.js";

export const INVALID_MEMORY_EDIT = { error: "invalid_memory_edit", message: "That change could not be saved." } as const;

/** Maps the service's errors to fixed answers: never the validator's message, an entry's text or an id. */
export async function memoryOutcome(response: Response, run: () => Promise<unknown>, onDone: () => void, status = 200): Promise<void> {
  try {
    const result = await run();
    onDone();
    if (status === 204) response.status(204).send(); else response.status(status).json(result);
  } catch (error) {
    if (error instanceof MemoryNotFoundError) { response.status(404).json({ error: "not_found" }); return; }
    if (error instanceof MemoryValidationError) { response.status(400).json(INVALID_MEMORY_EDIT); return; }
    if (error instanceof MemoryConflictError) { response.status(409).json({ error: "memory_conflict" }); return; }
    throw error;
  }
}
