import { z } from "zod";

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

export async function parseJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) {
    throw new RequestBodyError("payload_too_large", "Request body exceeds 16 KiB.");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    throw new RequestBodyError("invalid_request", "Request body must be valid UTF-8 JSON.");
  }

  if (hasLoneSurrogate(text)) {
    throw new RequestBodyError("invalid_request", "Request body contains invalid Unicode.");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new RequestBodyError("invalid_request", "Request body must be valid JSON.");
  }
}
