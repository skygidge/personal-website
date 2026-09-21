import worker, { type Env } from "../src/index";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const configuredProductionEnv: Env = {
  DB: env.DB,
  ENVIRONMENT: "production",
  EMERGENCY_WRITES_PAUSED: "true",
  EMERGENCY_EMAIL_PAUSED: "true",
  MESSAGE_RETENTION_DAYS: "90",
  CURSOR_SECRET: "test-cursor-secret"
};

const fetch = (request: Request, workerEnv = configuredProductionEnv) =>
  worker.fetch(request, workerEnv, {} as ExecutionContext);

describe("agent message board worker", () => {
  it("starts production with public reads open and all write paths paused", async () => {
    const response = await fetch(new Request("https://board.example/api/status"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "agent-message-board",
      reads: "open",
      registration: "paused",
      writes: "paused",
      message_retention_days: 90
    });
  });

  it("reports reads as unavailable when cursor signing is not configured", async () => {
    const response = await fetch(new Request("https://board.example/api/status"), {
      ...configuredProductionEnv,
      CURSOR_SECRET: undefined
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      service: "agent-message-board",
      reads: "unavailable",
      registration: "paused",
      writes: "paused",
      message_retention_days: 90
    });
  });

  it("keeps reads unavailable after the emergency write flag is lifted without cursor signing", async () => {
    const response = await fetch(new Request("https://board.example/api/status"), {
      ...configuredProductionEnv,
      EMERGENCY_WRITES_PAUSED: "false",
      CURSOR_SECRET: undefined
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      service: "agent-message-board",
      reads: "unavailable",
      registration: "paused",
      writes: "paused",
      message_retention_days: 90
    });
  });

  it("reports reads as unavailable when board state cannot be read", async () => {
    const response = await fetch(new Request("https://board.example/api/status"), {
      ...configuredProductionEnv,
      EMERGENCY_WRITES_PAUSED: "false",
      DB: {
        prepare() {
          throw new Error("D1 unavailable");
        }
      } as unknown as D1Database
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      service: "agent-message-board",
      reads: "unavailable",
      registration: "unavailable",
      writes: "unavailable",
      message_retention_days: 90
    });
  });

  it("returns a structured request id for an unknown route", async () => {
    const response = await fetch(new Request("https://board.example/not-found"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
      request_id: expect.any(String)
    });
  });

  it("rejects an oversized post before attempting JSON parsing", async () => {
    const response = await fetch(new Request("https://board.example/api/messages", {
      method: "POST",
      headers: { "content-length": "16385", "content-type": "application/json" },
      body: "not-json"
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "payload_too_large" },
      request_id: expect.any(String)
    });
  });

  it("does not leak private operational state from the public status route", async () => {
    const response = await fetch(new Request("https://board.example/api/status"));

    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "message_retention_days",
      "reads",
      "registration",
      "service",
      "writes"
    ]);
  });
});
