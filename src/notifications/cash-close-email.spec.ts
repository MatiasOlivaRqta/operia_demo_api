import { describe, expect, it } from "vitest";
import {
  cashCloseEmailDataSchema,
  renderCashCloseDifferenceEmail,
  type CashCloseEmailData,
} from "./cash-close-email.js";

const data: CashCloseEmailData = {
  companyName: "Empresa",
  differenceCents: -200,
  theoreticalCents: 284200,
  declaredCents: 284000,
  closedBy: { name: "Ana Pérez", email: "ana@example.com" },
  openedBy: { name: "Luis Gómez", email: "luis@example.com" },
  observation: "Recuento",
  openedAt: "2026-10-09T12:00:00.000Z",
  closedAt: "2026-10-09T21:00:00.000Z",
};
describe("renderCashCloseDifferenceEmail", () => {
  it("requires openedBy and rejects operatorName in the strict payload", () => {
    expect(cashCloseEmailDataSchema.safeParse(data).success).toBe(true);
    expect(cashCloseEmailDataSchema.safeParse({ ...data, operatorName: "Operador" }).success).toBe(
      false,
    );
  });
  it("renders a shortage, pesos, identities and Argentina dates", () => {
    const result = renderCashCloseDifferenceEmail(data);
    for (const text of [
      "Empresa",
      "Faltante",
      "$2,00",
      "Teórico: $2.842,00",
      "Declarado: $2.840,00",
      "Diferencia: -$2,00",
      "Abrió: Luis Gómez (luis@example.com)",
      "Apertura: 2026-10-09 09:00",
      "Cierre: 2026-10-09 18:00",
      "Ana Pérez (ana@example.com)",
      "Recuento",
    ])
      expect(result.text).toContain(text);
    expect(result.subject).toBe("Diferencia de cierre de caja - Empresa");
    expect(result.html).toContain("background:#fee4e2;color:#b42318");
    expect(result.html).toContain("-$2,00");
  });
  it("renders a visually distinct surplus with an absolute highlighted amount", () => {
    const result = renderCashCloseDifferenceEmail({
      ...data,
      differenceCents: 200,
      declaredCents: 284400,
    });
    expect(result.text).toContain("Sobrante: $2,00");
    expect(result.text).toContain("Diferencia: +$2,00");
    expect(result.html).toContain("background:#dcfae6;color:#067647");
  });
  it("includes all business data in plain text", () => {
    const result = renderCashCloseDifferenceEmail(data);
    for (const value of [
      "Diferencia de cierre de caja",
      "Empresa",
      "Faltante: $2,00",
      "Teórico: $2.842,00",
      "Declarado: $2.840,00",
      "Diferencia: -$2,00",
      "Luis Gómez (luis@example.com)",
      "Ana Pérez (ana@example.com)",
      "Apertura: 2026-10-09 09:00",
      "Cierre: 2026-10-09 18:00",
      "Observación\nRecuento",
    ])
      expect(result.text).toContain(value);
  });
  it("escapes all free text in HTML", () => {
    const result = renderCashCloseDifferenceEmail({
      ...data,
      observation: "<script>alert(1)</script>",
      companyName: "A&B",
      closedBy: { name: "<Ana>", email: "<correo>" },
      openedBy: { name: "<Luis>", email: "luis&@example.com" },
    });
    expect(result.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(result.html).toContain("A&amp;B");
    expect(result.html).toContain("&lt;Luis&gt;");
    expect(result.html).toContain("luis&amp;@example.com");
    expect(result.html).not.toMatch(/<(script|img|Ana|Luis|correo)/);
  });
  it("uses only inline table markup without external resources", () => {
    const html = renderCashCloseDifferenceEmail(data).html;
    expect(html).toMatch(/^<table[\s\S]*<\/table>$/);
    expect(html).not.toMatch(/<\s*(img|link|script)\b/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toContain("<style");
  });
  it("keeps header-like observation exclusively in the body", () => {
    const result = renderCashCloseDifferenceEmail({
      ...data,
      observation: "\r\nBcc: otro@dominio.com",
    });
    expect(result.subject).toBe(renderCashCloseDifferenceEmail(data).subject);
    expect(result.subject).not.toMatch(/[\r\n]/);
    expect(Object.keys(result).sort()).toEqual(["html", "subject", "text"]);
    expect(result.text).toContain("Bcc: otro@dominio.com");
  });
  it("removes company line breaks from the fixed subject template", () => {
    expect(
      renderCashCloseDifferenceEmail({ ...data, companyName: "Empresa\r\nBcc: otra" }).subject,
    ).toBe("Diferencia de cierre de caja - Empresa  Bcc: otra");
  });
});
