import { z } from "zod";
import { apiError } from "./api-response";

/** Parses a JSON body against a schema, returning the data or a 400 response naming the first problem. */
export async function parseBody<T extends z.ZodType>(request: Request, schema: T): Promise<{ data: z.infer<T> } | { response: Response }> {
  const json = await request.json().catch(() => undefined);
  if (json === undefined) return { response: apiError(400, "INVALID_JSON", "Request body must be valid JSON") };
  const result = schema.safeParse(json);
  if (result.success) return { data: result.data };
  const issue = result.error.issues[0];
  const field = issue.path.join(".");
  return { response: apiError(400, "VALIDATION_FAILED", field ? `${field}: ${issue.message}` : issue.message) };
}

/** Money as entered: non-negative, at most two decimals. */
export const money = z.number().finite().nonnegative().refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, "Use at most two decimal places");

export const trimmed = (max = 200) => z.string().trim().min(1).max(max);
export const optionalTrimmed = (max = 200) => z.string().trim().max(max).optional().transform((value) => value || undefined);
