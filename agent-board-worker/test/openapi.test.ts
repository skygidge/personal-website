import { describe, expect, it } from "vitest";
import { openapiDocument } from "../src/openapi";

type JsonObject = Record<string, any>;

function responseSchema(operation: JsonObject, status: string): JsonObject | undefined {
  return operation.responses?.[status]?.content?.["application/json"]?.schema;
}

describe("public OpenAPI contract", () => {
  it("documents every public route and its implemented response statuses", () => {
    const document = openapiDocument as JsonObject;

    expect(document.paths["/openapi.json"]?.get?.responses?.["200"]).toBeTruthy();
    expect(Object.keys(document.paths["/api/register"].post.responses).sort()).toEqual(["201", "400", "413", "429", "503"]);
    expect(Object.keys(document.paths["/api/messages"].post.responses).sort()).toEqual(["201", "400", "401", "404", "409", "413", "422", "429", "503"]);
    expect(Object.keys(document.paths["/api/messages"].get.responses).sort()).toEqual(["200", "400", "429", "503"]);
    expect(Object.keys(document.paths["/api/messages/{message_id}"].get.responses).sort()).toEqual(["200", "404", "429", "503"]);
    expect(Object.keys(document.paths["/api/status"].get.responses).sort()).toEqual(["200", "503"]);
  });

  it("defines success and error bodies with request ids", () => {
    const document = openapiDocument as JsonObject;
    const successSchemas = ["RegisterResponse", "MessageResponse", "MessageListResponse", "MessageDetailResponse", "StatusResponse"];

    for (const name of successSchemas) {
      expect(document.components.schemas[name].required).toContain("request_id");
    }

    expect(responseSchema(document.paths["/api/register"].post, "201")).toEqual({ $ref: "#/components/schemas/RegisterResponse" });
    expect(responseSchema(document.paths["/api/messages"].post, "201")).toEqual({ $ref: "#/components/schemas/MessageResponse" });
    expect(responseSchema(document.paths["/api/messages"].get, "200")).toEqual({ $ref: "#/components/schemas/MessageListResponse" });
    expect(responseSchema(document.paths["/api/messages/{message_id}"].get, "200")).toEqual({ $ref: "#/components/schemas/MessageDetailResponse" });
    expect(responseSchema(document.paths["/api/status"].get, "503")).toEqual({ $ref: "#/components/schemas/StatusResponse" });

    for (const [path, method, statuses] of [
      ["/api/register", "post", ["400", "413", "429", "503"]],
      ["/api/messages", "post", ["400", "401", "404", "409", "413", "422", "429", "503"]],
      ["/api/messages", "get", ["400", "429", "503"]],
      ["/api/messages/{message_id}", "get", ["404", "429", "503"]]
    ] as const) {
      for (const status of statuses) {
        expect(responseSchema(document.paths[path][method], status)).toEqual({ $ref: "#/components/schemas/Error" });
      }
    }
  });

  it("matches required registration fields and paused status values", () => {
    const document = openapiDocument as JsonObject;

    expect(document.components.schemas.RegisterRequest.required).toEqual(["display_name", "description"]);
    expect(document.components.schemas.StatusResponse.properties.registration.enum).toContain("paused");
    expect(document.components.schemas.StatusResponse.properties.writes.enum).toContain("paused");
  });
});
