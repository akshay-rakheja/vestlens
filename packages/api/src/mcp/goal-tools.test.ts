import { describe, expect, it } from "vitest";

import { accountKey } from "../memory/keys.js";
import { connectFacts, firstText, TFSA_ID } from "../testing/fact-tools-harness.js";
import { goalText, YOUR_ASSUMPTION } from "./goal-tools.js";

// Synthetic accounts and amounts only. My TFSA reports 1,300 CAD and had a 600 deposit on 2026-08-03.
const house = (over: Record<string, unknown> = {}) => ({ name: "House", targetCad: 50_000, targetDate: "2028-06-30", accounts: [TFSA_ID], ...over });
const goalRows = (repository: { rows: Array<{ property: string; supersededAt: Date | null }> }, property = "goal.savings_target") =>
  repository.rows.filter((r) => r.property === property && r.supersededAt === null) as any[];

describe("set_savings_goal", () => {
  it("saves a stated goal on a memorySlug key and echoes verbatim", async () => {
    const { client, repository } = await connectFacts();
    const result = await client.callTool({ name: "set_savings_goal", arguments: house() });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe("Noted your goal: House.");
    const [row] = goalRows(repository);
    expect(row.nodeKey).toBe("house");
    expect(row.provenance).toBe("stated");
    expect(row.value.accounts).toEqual([accountKey(TFSA_ID)]);
  });

  it("saves outside values as account.value on outside:<slug> and links them", async () => {
    const { client, repository } = await connectFacts();
    await client.callTool({ name: "set_savings_goal", arguments: house({ outsideValues: [{ label: "Questrade TFSA", amountCad: 4000, asOf: "2026-06-01" }] }) });
    expect(goalRows(repository)[0].value.accounts).toEqual([accountKey(TFSA_ID), "outside:questrade-tfsa"]);
    const [value] = goalRows(repository, "account.value");
    expect(value.nodeKey).toBe("outside:questrade-tfsa");
    expect(value.value).toEqual({ amountCad: 4000, asOf: "2026-06-01" });
    const shown = firstText(await client.callTool({ name: "show_goal", arguments: {} }));
    expect(shown).toContain("about $5,300");
    expect(shown).toContain("Your stated value for Questrade TFSA is from 2026-06-01, more than 90 days ago.");
    expect(shown).not.toContain("questrade-tfsa");
  });

  it("outside names replace only their own placeholders in the notes, never other copy (M-1)", async () => {
    const { client } = await connectFacts();
    await client.callTool({ name: "set_savings_goal", arguments: house({ outsideValues: [{ label: "Chart!", amountCad: 100, asOf: "2026-06-01" }] }) });
    const shown = firstText(await client.callTool({ name: "show_goal", arguments: {} }));
    expect(shown).toContain("Your stated value for Chart! is from 2026-06-01");
    expect(shown).toContain("Not enough daily values for a chart.");
  });

  it("with only outside accounts and no removal of connected ones, no portfolio is read (M-4)", async () => {
    const { client, portfolio } = await connectFacts();
    await client.callTool({ name: "set_savings_goal", arguments: { name: "Cottage", targetCad: 9000, targetDate: "2029-01-01", accounts: ["outside:Credit union"] } });
    await client.callTool({ name: "set_savings_goal", arguments: { name: "Cottage", remove: true } });
    expect(portfolio.getPortfolio).not.toHaveBeenCalled();
  });

  it("rejections are isError with plain text and nothing is written", async () => {
    const { client, repository } = await connectFacts();
    const rate = await client.callTool({ name: "set_savings_goal", arguments: house({ growthRatePct: 25 }) });
    expect(rate.isError).toBe(true);
    expect(firstText(rate)).toMatch(/^Not saved: /);
    const account = await client.callTool({ name: "set_savings_goal", arguments: house({ accounts: ["SYNTHETIC-NOT-MINE"] }) });
    expect(account.isError).toBe(true);
    const badOutside = await client.callTool({ name: "set_savings_goal", arguments: house({ outsideValues: [{ label: "Elsewhere", amountCad: -5, asOf: "2026-10-01" }] }) });
    expect(badOutside.isError).toBe(true);
    const noDate = await client.callTool({ name: "set_savings_goal", arguments: house({ targetDate: undefined }) });
    expect(noDate.isError).toBe(true);
    expect(repository.rows).toHaveLength(0);
  });

  it("a same-name update with only the changed field keeps the rest of the goal (M-3)", async () => {
    const { client, repository } = await connectFacts();
    await client.callTool({ name: "set_savings_goal", arguments: house({ growthRatePct: 4 }) });
    const result = await client.callTool({ name: "set_savings_goal", arguments: { name: "house", targetCad: 60_000 } });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe("Noted your goal: house.");
    const [row] = goalRows(repository);
    expect(row.value).toEqual({ name: "house", targetCad: 60_000, targetDate: "2028-06-30", accounts: [accountKey(TFSA_ID)], growthRatePct: 4 });
    expect(row.text).toBe("Goal: house, $60,000 by 2028-06-30.");
    // A new goal still needs its amount, date and accounts.
    const fresh = await client.callTool({ name: "set_savings_goal", arguments: { name: "Boat", targetCad: 9_000 } });
    expect(fresh.isError).toBe(true);
  });

  it("remove deletes the goal", async () => {
    const { client, repository } = await connectFacts();
    await client.callTool({ name: "set_savings_goal", arguments: house() });
    expect(firstText(await client.callTool({ name: "set_savings_goal", arguments: { name: "House", remove: true } }))).toBe("Removed your goal: House.");
    expect(goalRows(repository)).toHaveLength(0);
  });
});

describe("show_goal", () => {
  it("shows progress, time left, what it takes and the pace; the rate projection only with a rate, labelled", async () => {
    const { client } = await connectFacts();
    await client.callTool({ name: "set_savings_goal", arguments: house() });
    const text = firstText(await client.callTool({ name: "show_goal", arguments: { name: "House" } }));
    expect(text).toContain("Goal: \"House\", $50,000 by 2028-06-30.");
    expect(text).toContain("Saved so far: about $1,300");
    expect(text).toMatch(/Time left: 20 months\./);
    expect(text).toMatch(/a month from here reaches the target if values stay flat\./);
    expect(text).toContain("Recent pace: about $100 a month in net contributions over the last 6 months");
    expect(text).not.toContain(YOUR_ASSUMPTION);
    await client.callTool({ name: "set_savings_goal", arguments: house({ growthRatePct: 5 }) });
    const withRate = firstText(await client.callTool({ name: "show_goal", arguments: {} }));
    expect(withRate).toMatch(/With your 5% yearly growth rate \(your assumption\): about \$[\d,]+ by 2028-06-30\./);
    expect(withRate).not.toMatch(/\b(should|sell|buy|recommend|consider)\b/i);
  });

  const plainGoal = { slug: "s", name: "Trip", targetCad: 10_000, targetDate: "2028-06-30", estimated: false, monthsLeft: 20, dateStatus: "future" as const, projectedAtPaceCad: null,
    projectedWithRateCad: null, growthRatePct: null, series: [], notes: [], savedFxDate: null, paceEstimated: false, paceFxDate: null };
  it("a met goal says the target is reached, not about $0 a month (B10)", () => {
    const text = goalText({ ...plainGoal, savedCad: 12_000, savedPct: 120, remainingCad: 0, neededPerMonthFlatCad: 0, recentPacePerMonthCad: null });
    expect(text).toContain("What it takes: target reached.");
    expect(text).not.toContain("$0");
  });
  it("a pace prorated from a later start says since that date, not the last 6 months (B10)", () => {
    const text = goalText({ ...plainGoal, savedCad: 5_000, savedPct: 50, remainingCad: 5_000, neededPerMonthFlatCad: 250, recentPacePerMonthCad: 2_013, paceSince: "2026-08-15" });
    expect(text).toContain("Recent pace: about $2,013 a month in net contributions since 2026-08-15");
    expect(text).not.toContain("last 6 months");
  });

  it("under a month left says about $X still to go instead of a per-month figure", () => {
    const text = goalText({
      slug: "s", name: "Trip", targetCad: 5000, targetDate: "2026-11-10", savedCad: 4200, savedPct: 84, remainingCad: 800, estimated: false,
      monthsLeft: 0.6, dateStatus: "under_month", neededPerMonthFlatCad: null, recentPacePerMonthCad: null, projectedAtPaceCad: null,
      projectedWithRateCad: null, growthRatePct: null, series: [], notes: ["less than a month left"], savedFxDate: null, paceEstimated: false, paceFxDate: null,
    });
    expect(text).toContain("What it takes: about $800 still to go.");
    expect(text).not.toMatch(/a month from here/);
    expect(text).toContain("Time left: less than a month left.");
  });

  const trip = {
    slug: "s", name: "Trip", targetCad: 5000, targetDate: "2027-11-10", savedCad: 4200, savedPct: 84, remainingCad: 800, monthsLeft: 12, dateStatus: "future" as const,
    neededPerMonthFlatCad: 67, recentPacePerMonthCad: 100, projectedAtPaceCad: 5400, projectedWithRateCad: 5600, growthRatePct: 5, series: [], notes: [],
    estimated: false, savedFxDate: null, paceEstimated: false, paceFxDate: null,
  };
  const label = (d: string) => `(est., Bank of Canada rate ${d})`;

  it("every converted figure carries its own estimate label and rate date", () => {
    const text = goalText({ ...trip, estimated: true, savedFxDate: "2026-10-22", paceEstimated: true, paceFxDate: "2026-09-01" });
    expect(text).toContain(`Saved so far: about $4,200 ${label("2026-10-22")}, 84% of the target.`);
    expect(text).toContain(`about $67 ${label("2026-10-22")} a month from here reaches the target`);
    expect(text).toContain(`Recent pace: about $100 ${label("2026-09-01")} a month in net contributions`);
    // A projection rests on both: the later of the two dates.
    expect(text).toContain(`at that pace, about $5,400 ${label("2026-10-22")} by 2027-11-10 with no growth.`);
    expect(text).toContain(`With your 5% yearly growth rate (your assumption): about $5,600 ${label("2026-10-22")} by 2027-11-10.`);
  });

  it("a converted pace alone labels the pace and the projections, not the saved figures", () => {
    const text = goalText({ ...trip, paceEstimated: true, paceFxDate: "2026-09-01" });
    expect(text).toContain("Saved so far: about $4,200, 84% of the target.");
    expect(text).toContain("about $67 a month from here");
    expect(text).toContain(`Recent pace: about $100 ${label("2026-09-01")} a month`);
    expect(text).toContain(`about $5,400 ${label("2026-09-01")} by`);
  });

  it("still to go is labelled when the saved total is converted", () => {
    const text = goalText({ ...trip, estimated: true, savedFxDate: "2026-10-22", dateStatus: "passed", monthsLeft: 0, neededPerMonthFlatCad: null });
    expect(text).toContain(`What it takes: about $800 ${label("2026-10-22")} still to go.`);
  });

  it("a lower bound reads 'at least', with no percentage, no what-it-takes and no projection (review 7)", () => {
    const text = goalText({ ...trip, savedAtLeast: true, savedPct: null, remainingCad: null, neededPerMonthFlatCad: null, projectedAtPaceCad: null, projectedWithRateCad: null, notes: ["Not included in the total: Managed RRSP. SnapTrade doesn't provide the value of Wealthsimple managed portfolios, so saved so far is a lower bound"] });
    expect(text).toContain("Saved so far: at least $4,200; an account's value is unknown (see the notes), so there is no percentage of the target.");
    expect(text).not.toMatch(/% of the target|What it takes|at that pace|growth rate/);
    expect(text).toContain("Recent pace: about $100 a month");
  });

  it("estimated with no date keeps the bare (est.); no conversion has no label", () => {
    expect(goalText({ ...trip, estimated: true })).toContain("Saved so far: about $4,200 (est.), 84%");
    expect(goalText({ ...trip, paceEstimated: true })).toContain("Recent pace: about $100 (est.) a month");
    expect(goalText(trip)).not.toMatch(/est\./);
  });

  it("with no goal says so plainly", async () => {
    const { client } = await connectFacts();
    const result = await client.callTool({ name: "show_goal", arguments: { name: "Boat" } });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe("No savings goal named \"Boat\" is saved.");
  });
});
