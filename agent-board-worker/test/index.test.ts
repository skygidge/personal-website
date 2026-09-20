import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const fetch = (request: Request) => exports.default.fetch(request);

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
