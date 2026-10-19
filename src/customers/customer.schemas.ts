import { z } from "zod";
import { isValidCuit } from "../common/cuit.js";
import { paginationSchema } from "../common/pagination.js";
import { messageKey } from "../common/i18n/index.js";

const text = z.string().trim().default("");
const personTypes = ["Física", "Jurídica"] as const;
const documentTypes = ["DNI", "CUIT/CUIL", "Pasaporte"] as const;

const legalRequired = {
  address: messageKey("validation.customer.address"),
  commercialName: messageKey("validation.customer.commercialName"),
  contactName: messageKey("validation.customer.contactName"),
  contactPhone: messageKey("validation.customer.phone"),
  fiscalAddress: messageKey("validation.customer.fiscalAddress"),
  locality: messageKey("validation.customer.locality"),
  province: messageKey("validation.customer.province"),
} as const;

export const customerSchema = z
  .object({
    address: text,
    city: z.string().trim().optional(),
    commercialName: text,
    contactEmail: text,
    contactName: text,
    contactPhone: text,
    documentNumber: z.string().trim().min(1, messageKey("validation.customer.documentNumber")),
    documentType: z.enum(documentTypes),
    fiscalAddress: text,
    legalName: z.string().trim().min(1, messageKey("validation.customer.legalName")),
    locality: text,
    personType: z.enum(personTypes),
    postalCode: text,
    priceList: z.string().trim().min(1, messageKey("validation.customer.priceList")),
    province: text,
    status: z.enum(["active", "inactive"]),
    vatCondition: z.enum(["Consumidor final", "Exento", "Monotributista", "Responsable inscripto"]),
  })
  .strict()
  .superRefine((values, ctx) => {
    const issue = (field: keyof typeof values, message: string) =>
      ctx.addIssue({ code: "custom", message, path: [field] });

    if (values.contactEmail && !z.email().safeParse(values.contactEmail).success)
      issue("contactEmail", messageKey("validation.customer.emailValid"));

    if (values.documentType === "CUIT/CUIL") {
      if (!/^[\d-]+$/.test(values.documentNumber) || !isValidCuit(values.documentNumber))
        issue("documentNumber", messageKey("validation.customer.cuit"));
    } else if (values.documentType === "DNI") {
      if (
        !/^[\d.]+$/.test(values.documentNumber) ||
        !/^\d{7,8}$/.test(values.documentNumber.replaceAll(".", ""))
      )
        issue("documentNumber", messageKey("validation.customer.dni"));
    } else if (!/^[A-Za-z0-9]{6,20}$/.test(values.documentNumber)) {
      issue("documentNumber", messageKey("validation.customer.passport"));
    }

    if (values.personType === "Física") {
      if (!values.contactPhone && !values.contactEmail)
        issue("contactPhone", messageKey("validation.customer.phoneOrEmail"));
      return;
    }

    if (values.documentType !== "CUIT/CUIL")
      issue("documentType", messageKey("validation.customer.legalDocumentType"));
    for (const [field, message] of Object.entries(legalRequired)) {
      if (!values[field as keyof typeof legalRequired])
        issue(field as keyof typeof values, message);
    }
  });

export const customerQuerySchema = paginationSchema
  .extend({
    search: z.string().trim().max(200).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    vatCondition: z
      .enum(["Consumidor final", "Exento", "Monotributista", "Responsable inscripto"])
      .optional(),
  })
  .strict();

export const customerIdSchema = z.object({ id: z.string().min(1).max(100) }).strict();
export const customerStatusSchema = z.object({ status: z.enum(["active", "inactive"]) }).strict();

export type CustomerInput = z.infer<typeof customerSchema>;
export type CustomerQuery = z.infer<typeof customerQuerySchema>;
export type CustomerStatusInput = z.infer<typeof customerStatusSchema>;

export const customerInputOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "documentNumber",
    "documentType",
    "legalName",
    "personType",
    "priceList",
    "status",
    "vatCondition",
  ],
  properties: {
    address: { type: "string", default: "" },
    city: { type: "string" },
    commercialName: { type: "string", default: "" },
    contactEmail: {
      type: "string",
      default: "",
      description: "Si se informa, debe ser un correo válido.",
    },
    contactName: { type: "string", default: "" },
    contactPhone: { type: "string", default: "" },
    documentNumber: { type: "string", minLength: 1 },
    documentType: { type: "string", enum: documentTypes },
    fiscalAddress: { type: "string", default: "" },
    legalName: { type: "string", minLength: 1 },
    locality: { type: "string", default: "" },
    personType: { type: "string", enum: personTypes },
    postalCode: { type: "string", default: "" },
    priceList: { type: "string", minLength: 1 },
    province: { type: "string", default: "" },
    status: { type: "string", enum: ["active", "inactive"] },
    vatCondition: {
      type: "string",
      enum: ["Consumidor final", "Exento", "Monotributista", "Responsable inscripto"],
    },
  },
} as const;
