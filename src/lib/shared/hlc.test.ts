import { describe, it, expect } from "vitest";
import { initHlc, packHlc, unpackHlc, tickHlc, receiveHlc } from "./hlc";

describe("Hybrid Logical Clock (HLC) Causal Order and Drift", () => {
  it("should initialize, pack, and unpack HLC correctly", () => {
    const hlc = initHlc("client-1", 1600000000000);
    expect(hlc.physical).toBe(1600000000000);
    expect(hlc.counter).toBe(0);
    expect(hlc.nodeId).toBe("client-1");

    const packed = packHlc(hlc);
    expect(packed).toBe("1600000000000:0000:client-1");

    const unpacked = unpackHlc(packed);
    expect(unpacked).toEqual(hlc);
  });

  it("should tick counter when physical time does not advance", () => {
    const hlc1 = initHlc("client-1", 1600000000000);
    const hlc2 = tickHlc(hlc1, 1600000000000);
    expect(hlc2.physical).toBe(1600000000000);
    expect(hlc2.counter).toBe(1);

    const hlc3 = tickHlc(hlc2, 1600000000000);
    expect(hlc3.counter).toBe(2);
  });

  it("should reset counter to 0 when physical time advances", () => {
    const hlc1 = initHlc("client-1", 1600000000000);
    const hlc2 = tickHlc(hlc1, 1600000000000); // counter = 1
    const hlc3 = tickHlc(hlc2, 1600000001000); // physical advances
    expect(hlc3.physical).toBe(1600000001000);
    expect(hlc3.counter).toBe(0);
  });

  it("should handle receive with normal clock (local is ahead)", () => {
    const local = initHlc("client-1", 1600000010000);
    const remote = packHlc(initHlc("client-2", 1600000000000));

    const result = receiveHlc(local, remote, 1600000010000);
    expect(result.physical).toBe(1600000010000);
    expect(result.counter).toBe(1); // local physical == wall clock, ticks local counter
  });

  it("should handle receive with drifted clock (remote is in future)", () => {
    const local = initHlc("client-1", 1600000000000);
    const remoteFuture = packHlc({ physical: 1600000050000, counter: 5, nodeId: "client-2" });

    // wall clock is 1600000000000
    const result = receiveHlc(local, remoteFuture, 1600000000000);
    expect(result.physical).toBe(1600000050000);
    expect(result.counter).toBe(6); // ticks based on remote counter
  });

  it("should resolve tie-breaks lexicographically by nodeId in string comparison", () => {
    const hlcA = packHlc({ physical: 1600000000000, counter: 2, nodeId: "node-A" });
    const hlcB = packHlc({ physical: 1600000000000, counter: 2, nodeId: "node-B" });

    expect(hlcA < hlcB).toBe(true);
    expect(hlcB > hlcA).toBe(true);
  });
});
