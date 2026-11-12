import { describe, expect, it, vi } from "vitest";

import { PERSONAL_CREDENTIALS } from "../snaptrade/gateway.js";
import { OWNER_SUBJECT, OwnerIdentity } from "./owner-identity.js";

function fakePrisma() {
  const rows = new Map<string, { id: string; authSubject: string }>();
  const upsert = vi.fn(async (input: { where: { authSubject: string }; create: { authSubject: string }; update: object }) => {
    const existing = rows.get(input.where.authSubject);
    if (existing) return existing;
    const row = { id: `owner-row-${rows.size + 1}`, authSubject: input.create.authSubject };
    rows.set(row.authSubject, row);
    return row;
  });
  return { rows, upsert, prisma: { appUser: { upsert } } };
}

describe("OwnerIdentity", () => {
  it("returns the Personal credentials for the owner only", async () => {
    const identity = new OwnerIdentity({ prisma: fakePrisma().prisma });

    await expect(identity.getExisting(OWNER_SUBJECT)).resolves.toEqual(PERSONAL_CREDENTIALS);
    await expect(identity.getOrCreate(OWNER_SUBJECT)).resolves.toEqual(PERSONAL_CREDENTIALS);
  });

  it("gives a non-owner subject no credentials", async () => {
    const identity = new OwnerIdentity({ prisma: fakePrisma().prisma });

    await expect(identity.getExisting("subject|someone-else")).resolves.toBeNull();
    await expect(identity.getOrCreate("subject|someone-else")).rejects.toThrow("unknown_subject");
    await expect(identity.getExisting("")).resolves.toBeNull();
  });

  it("never asks for a relink", async () => {
    const identity = new OwnerIdentity({ prisma: fakePrisma().prisma });

    await expect(identity.relinkRequired(OWNER_SUBJECT)).resolves.toBe(false);
    await expect(identity.relinkRequired("subject|someone-else")).resolves.toBe(false);
  });

  it("ensureOwner is idempotent", async () => {
    const fake = fakePrisma();
    const identity = new OwnerIdentity({ prisma: fake.prisma });

    const first = await identity.ensureOwner();
    const second = await identity.ensureOwner();

    expect(second).toBe(first);
    expect(fake.rows.size).toBe(1);
    expect(fake.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { authSubject: OWNER_SUBJECT } }));
  });
});
