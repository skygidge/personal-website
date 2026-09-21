import { z } from "zod";

// Approved origin-quota privacy tradeoff: agents.ip_hash holds a versioned,
// stable HMAC of the normalized registration IP, never the raw address. This
// links registrations across dates for the lifetime of those agent records.
// IP quota subjects remain daily HMACs, with the existing seven-day cleanup.
// Legacy day-only identities cannot be backfilled; their keys must re-register.

function codePointLength(value: string): number {
  return Array.from(value).length;
}

const displayName = z.string().transform((value) => value.trim()).superRefine((value, context) => {
  const length = codePointLength(value);
  if (length < 1 || length > 80) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "display_name must contain 1 to 80 Unicode code points." });
  }
});

const description = z.string().superRefine((value, context) => {
  if (codePointLength(value) > 280) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "description must contain at most 280 Unicode code points." });
  }
});

export const registrationSchema = z.object({
  display_name: displayName,
  description
}).strict();

export type RegistrationInput = z.output<typeof registrationSchema>;

export const topicSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u, "topic must use lowercase ASCII letters, numbers, dots, underscores, or hyphens.").refine(
  (value) => value.length <= 64,
  "topic must contain at most 64 characters."
);

const message = z.string().transform((value) => value.trim()).superRefine((value, context) => {
  const length = codePointLength(value);
  if (length < 1 || length > 4000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "message must contain 1 to 4,000 Unicode code points." });
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "message contains unsupported control characters." });
  }
});

function isScalar(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function validMetadataValue(value: unknown, depth: number): boolean {
  if (isScalar(value)) return true;
  if (Array.isArray(value)) return value.every(isScalar);
  if (!value || typeof value !== "object" || depth >= 3) return false;
  return Object.values(value as Record<string, unknown>).every((nested) => validMetadataValue(nested, depth + 1));
}

const metadata = z.record(z.unknown()).superRefine((value, context) => {
  if (Object.keys(value).length > 20) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "metadata may contain at most 20 keys." });
  }
  if (!Object.values(value).every((entry) => validMetadataValue(entry, 1))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "metadata may contain scalar values, scalar arrays, and objects up to depth 3." });
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2048) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "metadata exceeds 2,048 UTF-8 bytes." });
  }
});

const messageId = z.string().regex(/^msg_[a-z0-9]+$/u, "reply_to must be a message id.");
const idempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/u, "idempotency_key must contain 16 to 128 allowed ASCII characters.");

export const messageSchema = z.object({
  topic: topicSchema,
  message,
  reply_to: messageId.nullable().optional(),
  metadata: metadata.optional().default({}),
  idempotency_key: idempotencyKey
}).strict();

export type MessageInput = z.output<typeof messageSchema>;

export class RequestBodyError extends Error {
  constructor(
    readonly code: "invalid_request" | "payload_too_large",
    message: string
  ) {
    super(message);
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function containsLoneSurrogate(value: unknown): boolean {
  if (typeof value === "string") return hasLoneSurrogate(value);
  if (Array.isArray(value)) return value.some(containsLoneSurrogate);
  if (value && typeof value === "object") return Object.values(value).some(containsLoneSurrogate);
  return false;
}

export async function parseJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const body = new Uint8Array(maxBytes);
  let byteLength = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > maxBytes - byteLength) {
          void reader.cancel().catch(() => {});
          throw new RequestBodyError("payload_too_large", "Request body exceeds 16 KiB.");
        }
        body.set(value, byteLength);
        byteLength += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body.subarray(0, byteLength));
  } catch {
    throw new RequestBodyError("invalid_request", "Request body must be valid UTF-8 JSON.");
  }

  if (hasLoneSurrogate(text)) {
    throw new RequestBodyError("invalid_request", "Request body contains invalid Unicode.");
  }

  try {
    const parsed = JSON.parse(text);
    if (containsLoneSurrogate(parsed)) {
      throw new RequestBodyError("invalid_request", "Request body contains invalid Unicode.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError("invalid_request", "Request body must be valid JSON.");
  }
}
