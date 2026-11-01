import { describe, expect, it } from "vitest";

import { conditionReason, orderSections, rowCaption, sectionCount, startsFolded } from "./detail";
import type { DetailSection } from "./types";

const section = (title: string): DetailSection => ({ title, rows: [] });

const titles = (sections: DetailSection[]): string[] => sections.map((item) => item.title);

describe("orderSections", () => {
  it("puts the object and its status above the long metadata lists", () => {
    const ordered = orderSections([
      section("Annotations"),
      section("Labels"),
      section("Status"),
      section("Object"),
    ]);
    expect(titles(ordered)).toEqual(["Object", "Status", "Labels", "Annotations"]);
  });

  it("keeps a kind's own section above the metadata lists", () => {
    const ordered = orderSections([section("Rules"), section("Labels"), section("Object")]);
    expect(titles(ordered)).toEqual(["Object", "Rules", "Labels"]);
  });

  it("keeps the arrival order of two sections it has never heard of", () => {
    const ordered = orderSections([section("Rules"), section("Subjects")]);
    expect(titles(ordered)).toEqual(["Rules", "Subjects"]);
  });

  it("leaves the array it was given alone", () => {
    const input = [section("Labels"), section("Object")];
    orderSections(input);
    expect(titles(input)).toEqual(["Labels", "Object"]);
  });
});

describe("startsFolded", () => {
  it("folds the metadata that runs long", () => {
    expect(startsFolded("Labels")).toBe(true);
    expect(startsFolded("Annotations")).toBe(true);
  });

  it("folds where a pod may land, which is a list of keys", () => {
    expect(startsFolded("Scheduling")).toBe(true);
  });

  it("leaves everything else open", () => {
    expect(startsFolded("Object")).toBe(false);
    expect(startsFolded("Rules")).toBe(false);
  });
});

describe("rowCaption", () => {
  it("drops a label that only repeats the section title", () => {
    expect(rowCaption("Labels", "Labels")).toBeNull();
  });

  it("keeps a label that says something the title does not", () => {
    expect(rowCaption("Status", "Conditions")).toBe("Conditions");
  });
});

describe("conditionReason", () => {
  it("drops a reason that only repeats the condition's own name", () => {
    expect(conditionReason("PodScheduled", "PodScheduled")).toBeNull();
  });

  it("drops an empty reason", () => {
    expect(conditionReason("Ready", "")).toBeNull();
  });

  it("keeps a reason that says something the name does not", () => {
    expect(conditionReason("Ready", "ContainersNotReady")).toBe("ContainersNotReady");
  });
});

describe("sectionCount", () => {
  it("counts the entries of a one-table section, not its single row", () => {
    const labels: DetailSection = {
      title: "Labels",
      rows: [
        {
          table: {
            label: "Labels",
            columns: ["Key", "Value"],
            rows: [
              ["app", "web"],
              ["tier", "front"],
            ],
          },
        },
      ],
    };
    expect(sectionCount(labels)).toBe(2);
  });

  it("counts the conditions of a status section", () => {
    const status: DetailSection = {
      title: "Status",
      rows: [
        {
          conditions: {
            label: "Conditions",
            conditions: [
              { name: "Ready", status: "True", tone: "ok", reason: "", message: "", sinceSecs: 1 },
            ],
          },
        },
      ],
    };
    expect(sectionCount(status)).toBe(1);
  });

  it("counts the rows of a section that holds several", () => {
    const object: DetailSection = {
      title: "Object",
      rows: [
        { text: { label: "UID", value: "1" } },
        { text: { label: "Resource version", value: "2" } },
      ],
    };
    expect(sectionCount(object)).toBe(2);
  });

  it("counts the chips of a selector", () => {
    const selector: DetailSection = {
      title: "Service",
      rows: [{ badges: { label: "Selector", items: ["app=web", "tier=front"] } }],
    };
    expect(sectionCount(selector)).toBe(2);
  });

  it("counts the ports a service exposes", () => {
    const ports: DetailSection = {
      title: "Service",
      rows: [
        {
          ports: {
            label: "Ports",
            ports: [
              { label: "http: 80/TCP", port: 80, proto: "TCP" },
              { label: "9090/UDP", port: 9090, proto: "UDP" },
            ],
          },
        },
      ],
    };
    expect(sectionCount(ports)).toBe(2);
  });
});
