import { describe, expect, it } from "vitest";
import type { RequestContext } from "@/server/context";
import { extractIntake, MAX_INTAKE_CHARS } from "@/server/intake";

// The server action's own cap, independent of the textarea's maxLength.
// With no key set this path never leaves the process.

const dispatcher: RequestContext = {
  userId: "u",
  userName: "Test",
  email: "t@example.test",
  orgId: "o",
  companyId: "c",
  companyName: "Test",
  companyTimezone: "America/Chicago",
  role: "dispatcher",
  driverId: null,
};

describe("extractIntake", () => {
  it("rejects text over the cap and under the minimum before any extractor runs", async () => {
    expect(process.env.ANTHROPIC_API_KEY ?? "").toBe("");
    await expect(extractIntake(dispatcher, "x".repeat(MAX_INTAKE_CHARS + 1))).rejects.toThrow(
      /20,000 characters/,
    );
    await expect(extractIntake(dispatcher, "short")).rejects.toThrow(/Paste the rate/);
    const r = await extractIntake(dispatcher, "x".repeat(MAX_INTAKE_CHARS));
    expect(r.extractor).toBe("baseline");
  });

  it("is staff-only: a driver cannot use the intake", async () => {
    await expect(
      extractIntake({ ...dispatcher, role: "driver", driverId: "d" }, "x".repeat(100)),
    ).rejects.toThrow();
  });
});
