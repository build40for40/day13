import { describe, expect, it } from "vitest";
import { findCardNumbers, findSensitive, luhn } from "./sensitive.ts";

describe("findCardNumbers", () => {
  it("finds a Luhn-valid card number however it's spaced", () => {
    expect(findCardNumbers("card 4242 4242 4242 4242 exp 09/29")).toEqual(["4242 4242 4242 4242"]);
    expect(findCardNumbers("4242-4242-4242-4242")).toHaveLength(1);
    expect(findCardNumbers("4242424242424242")).toHaveLength(1);
  });

  it("ignores digit runs that fail the check or are too short", () => {
    expect(findCardNumbers("4242 4242 4242 4241")).toEqual([]);
    expect(findCardNumbers("call 020 7946 0000 about the boiler")).toEqual([]);
    expect(luhn("")).toBe(false);
  });
});

describe("findSensitive", () => {
  it("finds a given secret ignoring case, spaces and hyphens", () => {
    expect(findSensitive("wifi is blueotter42!", ["BlueOtter42!"])).toEqual(["BlueOtter42!"]);
    expect(findSensitive("code 482 913", ["482913"])).toEqual(["482913"]);
  });

  it("returns nothing for clean text", () => {
    expect(findSensitive("call the landlord about the boiler", ["BlueOtter42!"])).toEqual([]);
  });
});
