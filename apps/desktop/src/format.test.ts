import { describe, expect, it } from "vitest";

import {
  CLUSTER_COLORS,
  clusterColor,
  formatAge,
  formatBytes,
  formatBytesPair,
  formatCpu,
  formatCpuPair,
  initials,
  liveAge,
  previewValue,
  setClusterColors,
} from "./format";

describe("formatAge", () => {
  it("picks the largest unit that fits", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(59)).toBe("59s");
    expect(formatAge(60)).toBe("1m");
    expect(formatAge(3599)).toBe("59m");
    expect(formatAge(3600)).toBe("1h");
    expect(formatAge(86_399)).toBe("23h");
    expect(formatAge(86_400)).toBe("1d");
  });

  it("shows a dash for an age the cluster never reported", () => {
    expect(formatAge(Number.NaN)).toBe("-");
    expect(formatAge(Number.POSITIVE_INFINITY)).toBe("-");
    // The engine sends a sentinel for "no timestamp"; it must not become a date.
    expect(formatAge(1e13)).toBe("-");
  });
});

describe("liveAge", () => {
  it("adds the time since the sample was taken", () => {
    expect(liveAge(30, 1_000_000, 1_005_000)).toBe(35);
  });

  it("passes the age through when there is nothing to measure from", () => {
    expect(liveAge(30, null, 1_005_000)).toBe(30);
  });

  it("never runs backwards when the clock disagrees", () => {
    expect(liveAge(30, 1_000_000, 999_000)).toBe(30);
  });
});

describe("formatCpu", () => {
  it("drops the unit at a whole core and keeps two decimals otherwise", () => {
    expect(formatCpu(1000)).toBe("1");
    expect(formatCpu(1020)).toBe("1");
    expect(formatCpu(1500)).toBe("1.50");
    expect(formatCpu(2500)).toBe("2.50");
  });

  it("keeps millicores below a core", () => {
    expect(formatCpu(10)).toBe("10m");
    expect(formatCpu(9.5)).toBe("9.5m");
    expect(formatCpu(0)).toBe("0.0m");
  });
});

describe("formatCpuPair", () => {
  it("shows usage, request, or both", () => {
    expect(formatCpuPair(150, 200)).toBe("150m / 200m");
    expect(formatCpuPair(150, null)).toBe("150m");
    expect(formatCpuPair(null, 200)).toBe("- / 200m");
    expect(formatCpuPair(null, null)).toBe("-");
  });
});

describe("formatBytes", () => {
  it("picks the largest unit that fits and keeps a decimal below ten", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(1024)).toBe("1.0Ki");
    expect(formatBytes(1536)).toBe("1.5Ki");
    expect(formatBytes(10 * 1024 ** 2)).toBe("10Mi");
    expect(formatBytes(1024 ** 3)).toBe("1.0Gi");
    expect(formatBytes(1024 ** 4)).toBe("1.0Ti");
  });
});

describe("formatBytesPair", () => {
  it("mirrors the CPU pair", () => {
    expect(formatBytesPair(1024, 2048)).toBe("1.0Ki / 2.0Ki");
    expect(formatBytesPair(1024, null)).toBe("1.0Ki");
    expect(formatBytesPair(null, 2048)).toBe("- / 2.0Ki");
    expect(formatBytesPair(null, null)).toBe("-");
  });
});

describe("previewValue", () => {
  it("leaves a short value alone", () => {
    expect(previewValue("key=value")).toBe("key=value");
  });

  it("cuts a long value and says so", () => {
    const long = "x".repeat(4001);
    const cut = previewValue(long);
    expect(cut.endsWith("\n… truncated")).toBe(true);
    expect(cut).toHaveLength(4000 + "\n… truncated".length);
  });
});

describe("initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("prod-eu")).toBe("PE");
    expect(initials("kz mgmt")).toBe("KM");
  });

  it("takes two letters from a single word", () => {
    expect(initials("kz")).toBe("KZ");
    expect(initials("dev")).toBe("DE");
  });

  it("never returns nothing", () => {
    expect(initials("---")).toBe("?");
    expect(initials("")).toBe("?");
  });
});

describe("clusterColor", () => {
  it("is stable for a name and comes from the shipped palette", () => {
    const first = clusterColor("prod-eu");
    expect(clusterColor("prod-eu")).toBe(first);
    expect(CLUSTER_COLORS).toContain(first);
  });

  it("prefers a color the user picked, and forgets it again", () => {
    setClusterColors({ "prod-eu": "#123456" });
    expect(clusterColor("prod-eu")).toBe("#123456");
    setClusterColors({});
    expect(clusterColor("prod-eu")).not.toBe("#123456");
  });
});
