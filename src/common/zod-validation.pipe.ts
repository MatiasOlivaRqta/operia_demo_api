import { Injectable, type PipeTransform } from "@nestjs/common";
import { z } from "zod";
import { ApiException } from "./errors.js";
import { messageKey, type MessageKey, type MessageParams } from "./i18n/index.js";
import es from "./i18n/es.js";

type IssueTranslation = { key: MessageKey; params?: MessageParams };

@Injectable()
export class ZodValidationPipe implements PipeTransform<unknown> {
  constructor(private readonly schema: z.ZodType) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const fieldErrors: Record<string, string[]> = {};
      const fieldErrorParams: Record<string, MessageParams[]> = {};
      for (const issue of result.error.issues) {
        const field =
          issue.code === "unrecognized_keys" && issue.keys.length > 0
            ? issue.keys.join(", ")
            : issue.path.join(".") || "body";
        const translation = this.translateIssue(issue);
        fieldErrors[field] = [...(fieldErrors[field] ?? []), translation.key];
        fieldErrorParams[field] = [...(fieldErrorParams[field] ?? []), translation.params ?? {}];
      }
      throw new ApiException(
        "validation",
        messageKey("validation.reviewInput"),
        400,
        fieldErrors,
        {},
        fieldErrorParams,
      );
    }
    return result.data;
  }

  private translateIssue(issue: z.core.$ZodIssue): IssueTranslation {
    const issueKey = issue.message as MessageKey;
    if (Object.hasOwn(es, issueKey)) return { key: issueKey };
    if (issue.code === "unrecognized_keys") return { key: "validation.unrecognized" };
    if (issue.code === "invalid_format" && "format" in issue && issue.format === "email")
      return { key: "validation.email" };
    if (issue.code === "too_small" && "minimum" in issue && typeof issue.minimum === "number")
      return { key: "validation.parameter.min", params: { min: issue.minimum } };
    if (issue.code === "too_big" && "maximum" in issue && typeof issue.maximum === "number")
      return { key: "validation.parameter.max", params: { max: issue.maximum } };
    if (issue.code === "invalid_type" || issue.code === "invalid_format")
      return { key: "validation.invalidFormat" };
    return { key: "validation.invalidValue" };
  }
}
