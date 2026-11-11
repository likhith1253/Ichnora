import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { buildModelRequest } from "@/lib/agent/prompt";
import { OAUTH_COOKIE } from "@/lib/auth/flow";
import { defaultDbPath } from "@/lib/db";
import { analyzeQuery } from "@/lib/memory/query";
import { retrieve } from "@/lib/memory/retrieval";
import { SESSION_COOKIE } from "@/lib/server/identity";
import { memDb } from "./helpers";

describe("Ichnora branding and compatibility", () => {
  it("identifies as Ichnora in the system prompt", () => {
    const now = new Date("2026-11-11T06:00:00Z");
    const retrieval = retrieve(memDb(), {
      workspaceId: randomUUID(),
      conversationId: randomUUID(),
      text: "Hello",
      now,
      timeZone: "Asia/Kolkata",
    });
    const req = buildModelRequest({
      retrieval,
      userText: "Hello",
      now,
      timeZone: "Asia/Kolkata",
    });
    expect(req.system).toContain("You are Ichnora");
    expect(req.system).not.toMatch(/minimi/i);
  });

  it("recognizes greetings to Ichnora without treating Ichnora as a person name", () => {
    const q = analyzeQuery("Hi Ichnora!", new Date("2026-11-11T06:00:00Z"), "Asia/Kolkata");
    expect(q.isGreeting).toBe(true);
    expect(q.people).toEqual([]);
  });

  it("publishes Ichnora web manifest and branding assets", () => {
    const m = manifest();
    expect(m.name).toBe("Ichnora");
    expect(m.short_name).toBe("Ichnora");

    const assets = [
      "src/app/icon.svg",
      "public/favicon.ico",
      "public/apple-touch-icon.png",
      "public/icons/icon-192.png",
      "public/icons/icon-512.png",
      "public/brand/ichnora-mark.svg",
      "public/brand/ichnora-mark-mono.svg",
      "public/brand/ichnora-logo-light.svg",
      "public/brand/ichnora-logo-dark.svg",
    ];
    for (const rel of assets) {
      const full = path.join(process.cwd(), rel);
      expect(fs.existsSync(full)).toBe(true);
      expect(fs.statSync(full).size).toBeGreaterThan(0);
    }

    const iconSvg = fs.readFileSync(path.join(process.cwd(), "src/app/icon.svg"), "utf8");
    expect(iconSvg).toContain("<svg");
    expect(iconSvg).not.toContain(">m<");
  });

  it("preserves backward-compatible storage and session identifiers", () => {
    expect(SESSION_COOKIE).toBe("minimi_session");
    expect(OAUTH_COOKIE).toBe("minimi_oauth");
    if (!process.env.MINIMI_DB_PATH) {
      expect(defaultDbPath()).toMatch(/minimi\.db$/);
    }
  });
});
