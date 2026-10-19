import { z } from "zod";
import { formatArgentinaDateTime } from "../common/argentina-time.js";
import { formatPesos } from "../common/pesos.js";

export const cashCloseEmailDataSchema = z
  .object({
    companyName: z.string(),
    differenceCents: z.number().int().safe(),
    theoreticalCents: z.number().int().safe(),
    declaredCents: z.number().int().safe(),
    closedBy: z.object({ name: z.string(), email: z.string() }).strict(),
    openedBy: z.object({ name: z.string(), email: z.string() }).strict(),
    observation: z.string(),
    openedAt: z.iso.datetime({ offset: true }),
    closedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CashCloseEmailData = z.infer<typeof cashCloseEmailDataSchema>;
export type RenderedEmail = { subject: string; text: string; html: string };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });
}

export function renderCashCloseDifferenceEmail(data: CashCloseEmailData): RenderedEmail {
  const shortage = data.differenceCents < 0;
  const kind = shortage ? "Faltante" : "Sobrante";
  const absoluteDifference = formatPesos(Math.abs(data.differenceCents));
  const signedDifference =
    data.differenceCents > 0
      ? `+${formatPesos(data.differenceCents)}`
      : formatPesos(data.differenceCents);
  const statusColor = shortage ? "#b42318" : "#067647";
  const statusBackground = shortage ? "#fee4e2" : "#dcfae6";
  const amountRows: ReadonlyArray<readonly [string, string]> = [
    ["Teórico", formatPesos(data.theoreticalCents)],
    ["Declarado", formatPesos(data.declaredCents)],
    ["Diferencia", signedDifference],
  ];
  const detailRows: ReadonlyArray<readonly [string, string]> = [
    ["Abrió", `${data.openedBy.name} (${data.openedBy.email})`],
    ["Cerró", `${data.closedBy.name} (${data.closedBy.email})`],
    ["Apertura", formatArgentinaDateTime(new Date(data.openedAt))],
    ["Cierre", formatArgentinaDateTime(new Date(data.closedAt))],
  ];
  const htmlRows = (rows: ReadonlyArray<readonly [string, string]>): string =>
    rows
      .map(
        ([label, value]) =>
          `<tr><td style="padding:8px 12px;color:#475467;border-bottom:1px solid #eaecf0;">${escapeHtml(label)}</td><td style="padding:8px 12px;color:#101828;text-align:right;border-bottom:1px solid #eaecf0;">${escapeHtml(value)}</td></tr>`,
      )
      .join("");
  const plainRows = (rows: ReadonlyArray<readonly [string, string]>): string =>
    rows.map(([label, value]) => `${label}: ${value}`).join("\n");

  return {
    subject: `Diferencia de cierre de caja - ${data.companyName.replace(/[\r\n]/g, " ")}`,
    text: [
      "Diferencia de cierre de caja",
      data.companyName,
      `${kind}: ${absoluteDifference}`,
      "",
      "Importes",
      plainRows(amountRows),
      "",
      "Detalle",
      plainRows(detailRows),
      "",
      "Observación",
      data.observation,
    ].join("\n"),
    html: `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;margin:0 auto;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;color:#101828;"><tbody><tr><td style="padding:24px;background:#f8fafc;"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #eaecf0;"><tbody><tr><td style="padding:24px;"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tbody><tr><td style="font-size:20px;font-weight:700;padding-bottom:6px;">Diferencia de cierre de caja</td></tr><tr><td style="font-size:16px;color:#475467;padding-bottom:20px;">${escapeHtml(data.companyName)}</td></tr><tr><td style="padding-bottom:24px;"><table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tbody><tr><td style="padding:6px 12px;border-radius:999px;background:${statusBackground};color:${statusColor};font-size:13px;font-weight:700;">${kind}</td><td style="padding-left:12px;color:${statusColor};font-size:24px;font-weight:700;">${escapeHtml(absoluteDifference)}</td></tr></tbody></table></td></tr><tr><td style="font-size:16px;font-weight:700;padding-bottom:8px;">Importes</td></tr><tr><td style="padding-bottom:22px;"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">${htmlRows(amountRows)}</table></td></tr><tr><td style="font-size:16px;font-weight:700;padding-bottom:8px;">Detalle</td></tr><tr><td style="padding-bottom:22px;"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">${htmlRows(detailRows)}</table></td></tr><tr><td style="padding:14px 16px;background:#f2f4f7;border-left:4px solid #98a2b3;"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tbody><tr><td style="font-weight:700;padding-bottom:6px;">Observación</td></tr><tr><td style="white-space:pre-wrap;color:#344054;">${escapeHtml(data.observation)}</td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table>`,
  };
}
