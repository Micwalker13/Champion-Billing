import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, degrees } from "pdf-lib";
import { fmtUSD } from "./money";
import { fmtDate } from "./dates";

interface RenderInput {
  invoice: any;           // invoices row (snapshot drives all display data)
  lines: any[];
  attachments: Array<{ filename: string; mime_type: string; content: Buffer }>;
  draft: boolean;
}

const INK = rgb(0.11, 0.13, 0.16);
const MUTED = rgb(0.38, 0.42, 0.48);
const RULE = rgb(0.82, 0.84, 0.87);
const ACCENT = rgb(0.80, 0.33, 0.0);   // Champion orange
const PO_BG = rgb(1, 0.95, 0.88);

// pdf-lib's standard fonts are WinAnsi; replace characters it can't encode.
const clean = (s: unknown) => String(s ?? "").replace(/[–—]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/×/g, "x").replace(/÷/g, "/").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of clean(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const t = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(t, size) > width && line) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}

export async function renderInvoicePdf({ invoice, lines, attachments, draft }: RenderInput): Promise<Uint8Array> {
  const s = invoice.snapshot;
  const doc = await PDFDocument.create();
  // Deterministic metadata so the same invoice always renders to the same bytes.
  const fixedDate = new Date(invoice.finalized_at ?? invoice.created_at ?? 0);
  doc.setTitle(`Invoice ${invoice.invoice_number ?? "DRAFT"}`);
  doc.setAuthor(clean(s.company.legal_name));
  doc.setCreator("Champion Billing");
  doc.setProducer("Champion Billing");
  doc.setCreationDate(fixedDate);
  doc.setModificationDate(fixedDate);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 612, H = 792, M = 40;
  let page = doc.addPage([W, H]);
  const text = (p: PDFPage, t: unknown, x: number, y: number, size = 9, f = font, color = INK) => p.drawText(clean(t), { x, y, size, font: f, color });
  const right = (p: PDFPage, t: unknown, xr: number, y: number, size = 9, f = font, color = INK) => p.drawText(clean(t), { x: xr - f.widthOfTextAtSize(clean(t), size), y, size, font: f, color });

  // Header
  let y = H - M;
  text(page, s.company.legal_name, M, y - 14, 18, bold, ACCENT);
  const addr = [s.company.address_line1, s.company.address_line2, s.company.city_state_zip, [s.company.phone, s.company.email].filter(Boolean).join("  |  ")].filter(Boolean);
  addr.forEach((l, i) => text(page, l, M, y - 30 - i * 11, 9, font, MUTED));
  right(page, draft ? "DRAFT INVOICE" : "INVOICE", W - M, y - 14, 18, bold);
  const meta: Array<[string, string]> = [
    ["Invoice #", invoice.invoice_number ?? "Not yet assigned"],
    ["Invoice date", fmtDate(invoice.invoice_date)],
    ["Due date", fmtDate(invoice.due_date)],
    ["Terms", s.terms.label],
  ];
  meta.forEach(([k, v], i) => { right(page, k, W - M - 110, y - 32 - i * 12, 9, font, MUTED); right(page, v, W - M, y - 32 - i * 12, 9, bold); });

  // PO box — the dedicated, prominent PO field.
  y = H - M - 100;
  page.drawRectangle({ x: M, y: y - 34, width: W - 2 * M, height: 38, color: PO_BG, borderColor: ACCENT, borderWidth: 1.2 });
  text(page, "CUSTOMER PO NUMBER", M + 10, y - 12, 8, bold, ACCENT);
  text(page, invoice.po_number ?? "NONE ASSIGNED", M + 10, y - 28, 16, bold);
  text(page, "BILLING PERIOD", M + 200, y - 12, 8, bold, ACCENT);
  text(page, `${fmtDate(invoice.period_start)} - ${fmtDate(invoice.period_end)}`, M + 200, y - 28, 13, bold);
  text(page, "RENTAL AGREEMENT", M + 380, y - 12, 8, bold, ACCENT);
  text(page, s.contract.number, M + 380, y - 28, 13, bold);

  // Bill to / Jobsite
  y -= 56;
  text(page, "BILL TO", M, y, 8, bold, MUTED);
  text(page, s.customer.name, M, y - 13, 10, bold);
  wrap(s.customer.billing_address, font, 9, 230).forEach((l, i) => text(page, l, M, y - 25 - i * 11, 9));
  text(page, `Customer ID: ${s.customer.code}`, M, y - 25 - wrap(s.customer.billing_address, font, 9, 230).length * 11, 8, font, MUTED);
  text(page, "JOBSITE", M + 290, y, 8, bold, MUTED);
  if (s.jobsite) {
    text(page, s.jobsite.name, M + 290, y - 13, 10, bold);
    wrap(s.jobsite.address, font, 9, 240).forEach((l, i) => text(page, l, M + 290, y - 25 - i * 11, 9));
  } else text(page, "—", M + 290, y - 13, 10);

  // Equipment & references grid
  y -= 90;
  page.drawLine({ start: { x: M, y: y + 8 }, end: { x: W - M, y: y + 8 }, thickness: 0.6, color: RULE });
  const grid: Array<[string, string]> = [
    ["Equipment unit", s.units ? `${s.equipment.unit_number} (exchanged)` : s.equipment.unit_number],
    ["Description", s.equipment.description],
    ["Serial number", s.equipment.serial_number ?? "—"],
    ["Rental start date", fmtDate(s.line.on_rent_date)],
    ["Job number", s.job_number ?? "—"],
    ["Work order", s.work_order_number ?? "—"],
    ["Billing method", s.period.billing_method],
    ["Original agreement", s.contract.number],
  ];
  grid.forEach(([k, v], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = M + col * 270;
    text(page, k, x, y - row * 14, 8, font, MUTED);
    text(page, wrap(v, bold, 9, 160)[0], x + 95, y - row * 14, 9, bold);
  });

  // Line items
  y -= 4 * 14 + 14;
  page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: rgb(0.95, 0.96, 0.97) });
  text(page, "Description", M + 6, y, 8, bold, MUTED);
  right(page, "Qty", M + 360, y, 8, bold, MUTED);
  right(page, "Rate", M + 440, y, 8, bold, MUTED);
  right(page, "Amount", W - M - 6, y, 8, bold, MUTED);
  y -= 18;
  for (const l of lines) {
    const desc = wrap(l.description, font, 9, 300);
    if (y - desc.length * 11 < 160) { page = doc.addPage([W, H]); y = H - M; }
    desc.forEach((d, i) => text(page, d, M + 6, y - i * 11, 9));
    right(page, `${Number(l.quantity).toFixed(4).replace(/\.?0+$/, "")} ${l.unit}`, M + 360, y, 9);
    right(page, fmtUSD(l.unit_price), M + 440, y, 9);
    right(page, fmtUSD(l.amount), W - M - 6, y, 9);
    y -= desc.length * 11 + 6;
    page.drawLine({ start: { x: M, y: y + 3 }, end: { x: W - M, y: y + 3 }, thickness: 0.4, color: RULE });
    y -= 4;
  }

  // Totals
  y -= 6;
  const taxPct = (Number(invoice.tax_rate) * 100).toFixed(3).replace(/\.?0+$/, "");
  const totals: Array<[string, string, boolean]> = [
    ["Rental & charges subtotal", fmtUSD(invoice.subtotal), false],
    [`Sales tax (${taxPct}% on ${fmtUSD(invoice.taxable_amount)})`, fmtUSD(invoice.tax_amount), false],
    ["TOTAL AMOUNT DUE", fmtUSD(invoice.total), true],
  ];
  totals.forEach(([k, v, b], i) => {
    const yy = y - i * 16;
    right(page, k, W - M - 110, yy, b ? 11 : 9, b ? bold : font, b ? INK : MUTED);
    right(page, v, W - M - 6, yy, b ? 12 : 9, b ? bold : font);
  });
  y -= 60;

  // Footer notes
  const notes = [
    `Please reference PO ${invoice.po_number ?? "(none)"} and invoice ${invoice.invoice_number ?? "(draft)"} with payment.`,
    `This invoice is one billing period of continuous rental agreement ${s.contract.number}; the agreement remains in effect until the equipment is called off or returned.`,
    s.units ? `Equipment exchange: ${s.units.map((u: any) => `unit ${u.unit_number}${u.serial_number ? ` (S/N ${u.serial_number})` : ""} on site ${fmtDate(u.from)} - ${fmtDate(u.to)}`).join("; ")}. The rental, rate and PO continue unchanged.` : "",
    s.company.remit_to ? `Remit to: ${s.company.remit_to}` : "",
    attachments.length ? `Attached: original rental agreement (${attachments.map((a) => a.filename).join(", ")}).` : "",
  ].filter(Boolean);
  for (const n of notes) {
    wrap(n, font, 8, W - 2 * M).forEach((l) => { text(page, l, M, y, 8, font, MUTED); y -= 10; });
    y -= 2;
  }
  if (s.company.is_placeholder || s.tax?.is_placeholder) {
    text(page, "PLACEHOLDER company/tax details — confirm in Settings before sending to customers.", M, 28, 8, bold, rgb(0.75, 0.1, 0.1));
  }

  if (draft) {
    for (const p of doc.getPages()) p.drawText("DRAFT - NOT AN INVOICE", { x: 120, y: 300, size: 46, font: bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.18, rotate: degrees(35) });
  }

  // Append the original agreement pages.
  for (const a of attachments) {
    try {
      if (a.mime_type === "application/pdf") {
        const src = await PDFDocument.load(a.content, { ignoreEncryption: true });
        const pages = await doc.copyPages(src, src.getPageIndices());
        pages.forEach((p) => doc.addPage(p));
      } else if (a.mime_type === "image/png" || a.mime_type === "image/jpeg") {
        const img = a.mime_type === "image/png" ? await doc.embedPng(a.content) : await doc.embedJpg(a.content);
        const p = doc.addPage([W, H]);
        const scale = Math.min((W - 2 * M) / img.width, (H - 2 * M - 20) / img.height, 1);
        p.drawText(clean(`Attachment: ${a.filename}`), { x: M, y: H - M, size: 9, font, color: MUTED });
        p.drawImage(img, { x: M, y: H - M - 14 - img.height * scale, width: img.width * scale, height: img.height * scale });
      }
    } catch {
      const p = doc.addPage([W, H]);
      p.drawText(clean(`Attachment ${a.filename} could not be embedded; it is stored with the rental record.`), { x: M, y: H - M, size: 10, font });
    }
  }
  return doc.save({ useObjectStreams: false });
}

// ───────────────────────── Customer statement ─────────────────────────
interface StatementInput {
  asOf: string;
  company: any;
  customer: any;
  invoices: Array<{ invoice_number: string; invoice_date: string; due_date: string; po_number: string | null; unit: string; period_start: string; period_end: string; total: string; amount_paid: string; amount_credited?: string | null; balance: string; days_past_due: number }>;
  totals: Record<string, string>;
  payments: Array<{ paid_on: string; amount: string; method: string | null; reference: string | null; invoice_number: string }>;
}

/** A statement of account: open invoices with their PO, aging totals and recent payments. Rendered on demand, not stored. */
export async function renderStatementPdf({ asOf, company, customer, invoices, totals, payments }: StatementInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Statement ${customer.customer_code} ${asOf}`);
  doc.setCreator("Champion Billing");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 40;
  let page = doc.addPage([W, H]);
  const text = (t: unknown, x: number, y: number, size = 9, f = font, color = INK) => page.drawText(clean(t), { x, y, size, font: f, color });
  const right = (t: unknown, xr: number, y: number, size = 9, f = font, color = INK) => page.drawText(clean(t), { x: xr - f.widthOfTextAtSize(clean(t), size), y, size, font: f, color });

  let y = H - M;
  text(company?.legal_name ?? "Champion Equipment", M, y - 14, 18, bold, ACCENT);
  [company?.address_line1, company?.address_line2, company?.city_state_zip, [company?.phone, company?.email].filter(Boolean).join("  |  ")].filter(Boolean)
    .forEach((l, i) => text(l, M, y - 30 - i * 11, 9, font, MUTED));
  right("STATEMENT", W - M, y - 14, 18, bold);
  right(`As of ${fmtDate(asOf)}`, W - M, y - 30, 9, font, MUTED);
  right(`Customer ID ${customer.customer_code}`, W - M, y - 41, 9, font, MUTED);

  y -= 95;
  text("BILL TO", M, y, 8, bold, MUTED);
  text(customer.name, M, y - 13, 11, bold);
  wrap(customer.billing_address ?? "", font, 9, 260).forEach((l, i) => text(l, M, y - 26 - i * 11, 9));
  // Amount due box
  page.drawRectangle({ x: W - M - 200, y: y - 40, width: 200, height: 48, color: PO_BG, borderColor: ACCENT, borderWidth: 1 });
  text("TOTAL BALANCE DUE", W - M - 190, y - 6, 8, bold, ACCENT);
  text(fmtUSD(totals.total), W - M - 190, y - 30, 18, bold);

  // Aging strip
  y -= 80;
  const buckets: Array<[string, string]> = [["Not yet due", "current"], ["1-30 days", "d1_30"], ["31-60 days", "d31_60"], ["61-90 days", "d61_90"], ["Over 90 days", "d90_plus"]];
  const bw = (W - 2 * M) / buckets.length;
  buckets.forEach(([label, k], i) => {
    page.drawRectangle({ x: M + i * bw, y: y - 30, width: bw - 4, height: 34, borderColor: RULE, borderWidth: 1 });
    text(label, M + i * bw + 6, y - 8, 7.5, font, MUTED);
    text(fmtUSD(totals[k]), M + i * bw + 6, y - 23, 10, bold);
  });

  // Open invoices table
  y -= 52;
  const cols: Array<[string, number, "l" | "r"]> = [["Invoice #", M, "l"], ["Date", M + 82, "l"], ["Due", M + 132, "l"], ["PO", M + 182, "l"], ["Unit", M + 228, "l"], ["Period", M + 290, "l"], ["Total", M + 418, "r"], ["Paid/credit", M + 470, "r"], ["Balance", W - M, "r"]];
  const header = () => {
    page.drawRectangle({ x: M, y: y - 5, width: W - 2 * M, height: 17, color: rgb(0.95, 0.96, 0.97) });
    cols.forEach(([h, x, a]) => (a === "r" ? right(h, x, y, 8, bold, MUTED) : text(h, x + 3, y, 8, bold, MUTED)));
    y -= 18;
  };
  text("OPEN INVOICES", M, y + 6, 8, bold, MUTED);
  y -= 12;
  header();
  if (!invoices.length) { text("No open invoices. Thank you.", M + 3, y, 9); y -= 14; }
  for (const inv of invoices) {
    if (y < M + 80) { page = doc.addPage([W, H]); y = H - M; header(); }
    const vals = [inv.invoice_number, fmtDate(inv.invoice_date), fmtDate(inv.due_date), inv.po_number ?? "-", inv.unit, `${fmtDate(inv.period_start)}-${fmtDate(inv.period_end).slice(0, 5)}`, fmtUSD(inv.total), fmtUSD(Number(inv.amount_paid) + Number(inv.amount_credited ?? 0)), fmtUSD(inv.balance)];
    cols.forEach(([, x, a], i) => (a === "r" ? right(vals[i], x, y, 8.5, i === 8 ? bold : font) : text(vals[i], x + 3, y, 8.5, font, inv.days_past_due > 0 && i === 2 ? rgb(0.7, 0.1, 0.1) : INK)));
    y -= 13;
  }
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.5, color: RULE });
  right("Total balance due", M + 470, y - 8, 10, bold);
  right(fmtUSD(totals.total), W - M, y - 8, 10, bold);
  y -= 34;

  if (payments.length) {
    if (y < M + 80) { page = doc.addPage([W, H]); y = H - M; }
    text("PAYMENTS AND CREDITS (LAST 90 DAYS)", M, y, 8, bold, MUTED);
    y -= 14;
    for (const p of payments.slice(0, 20)) {
      if (y < M + 40) { page = doc.addPage([W, H]); y = H - M; }
      text(`${fmtDate(p.paid_on)}  ${p.invoice_number}  ${[p.method, p.reference].filter(Boolean).join(" ")}`, M + 3, y, 8.5);
      right(fmtUSD(p.amount), W - M, y, 8.5);
      y -= 12;
    }
    y -= 10;
  }
  if (y < M + 40) { page = doc.addPage([W, H]); y = H - M; }
  const footer = [`Please reference the invoice number and PO with your payment.${customer.payment_terms_label ? ` Terms: ${customer.payment_terms_label}.` : ""}`];
  if (company?.remit_to) footer.push(`Remit to: ${company.remit_to}`);
  footer.flatMap((f) => wrap(f, font, 8.5, W - 2 * M)).forEach((l, i) => text(l, M, y - i * 11, 8.5, font, MUTED));
  if (company?.is_placeholder) text("PLACEHOLDER company details - confirm in Settings before sending to customers.", M, M - 10, 8, bold, rgb(0.75, 0.1, 0.1));
  return doc.save();
}

// ───────────────────────── Equipment sale invoice ─────────────────────────
/** Invoice for selling a unit. The finalized PDF is stored once and never regenerated. */
export async function renderSalePdf({ sale, draft }: { sale: any; draft: boolean }): Promise<Uint8Array> {
  const s = sale.snapshot;
  const doc = await PDFDocument.create();
  const fixedDate = new Date(sale.finalized_at ?? sale.created_at ?? 0);
  doc.setTitle(`Invoice ${sale.sale_number ?? "DRAFT"}`);
  doc.setAuthor(clean(s.company?.legal_name));
  doc.setCreator("Champion Billing");
  doc.setProducer("Champion Billing");
  doc.setCreationDate(fixedDate);
  doc.setModificationDate(fixedDate);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 40;
  const page = doc.addPage([W, H]);
  const text = (t: unknown, x: number, y: number, size = 9, f = font, color = INK) => page.drawText(clean(t), { x, y, size, font: f, color });
  const right = (t: unknown, xr: number, y: number, size = 9, f = font, color = INK) => page.drawText(clean(t), { x: xr - f.widthOfTextAtSize(clean(t), size), y, size, font: f, color });

  let y = H - M;
  text(s.company?.legal_name, M, y - 14, 18, bold, ACCENT);
  [s.company?.address_line1, s.company?.address_line2, s.company?.city_state_zip, [s.company?.phone, s.company?.email].filter(Boolean).join("  |  ")].filter(Boolean)
    .forEach((l, i) => text(l, M, y - 30 - i * 11, 9, font, MUTED));
  right(draft ? "DRAFT INVOICE" : "INVOICE", W - M, y - 14, 18, bold);
  right("EQUIPMENT SALE", W - M, y - 28, 9, bold, ACCENT);
  const terms = Number(sale.terms_days) === 0 ? "Due on receipt" : `Net ${sale.terms_days}`;
  ([["Invoice #", sale.sale_number ?? "Not yet assigned"], ["Invoice date", fmtDate(sale.sale_date)], ["Due date", fmtDate(sale.due_date)], ["Terms", terms]] as Array<[string, string]>)
    .forEach(([k, v], i) => { right(k, W - M - 110, y - 44 - i * 12, 9, font, MUTED); right(v, W - M, y - 44 - i * 12, 9, bold); });

  y = H - M - 120;
  text("BILL TO", M, y, 8, bold, MUTED);
  text(s.customer.name, M, y - 13, 10, bold);
  const addr = wrap(s.customer.billing_address ?? "", font, 9, 260);
  addr.forEach((l, i) => text(l, M, y - 25 - i * 11, 9));
  text(`Customer ID: ${s.customer.code}`, M, y - 25 - addr.length * 11, 8, font, MUTED);

  y -= 90;
  page.drawLine({ start: { x: M, y: y + 8 }, end: { x: W - M, y: y + 8 }, thickness: 0.6, color: RULE });
  const e = s.equipment;
  const grid: Array<[string, string]> = [
    ["Unit", e.unit_number], ["Serial number", e.serial_number ?? "—"],
    ["Make / model", [e.make, e.model].filter(Boolean).join(" ") || "—"], ["Year", e.year ? String(e.year) : "—"],
    ["Description", e.description], ["Hour meter", sale.hours_at_sale != null ? String(sale.hours_at_sale) : "—"],
  ];
  grid.forEach(([k, v], i) => { const x = M + (i % 2) * 270; const yy = y - Math.floor(i / 2) * 14; text(k, x, yy, 8, font, MUTED); text(wrap(v, bold, 9, 160)[0], x + 85, yy, 9, bold); });

  y -= 3 * 14 + 16;
  page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: rgb(0.95, 0.96, 0.97) });
  text("Description", M + 6, y, 8, bold, MUTED);
  right("Amount", W - M - 6, y, 8, bold, MUTED);
  y -= 18;
  const items: Array<[string, string]> = [[`Sale of unit ${e.unit_number}: ${[e.year, e.make, e.model].filter(Boolean).join(" ")} ${e.description}${e.serial_number ? `, S/N ${e.serial_number}` : ""}`, sale.price]];
  if (Number(sale.freight) > 0) items.push(["Freight / delivery", sale.freight]);
  for (const [d, amt] of items) {
    const lines = wrap(d, font, 9, 400);
    lines.forEach((l, i) => text(l, M + 6, y - i * 11, 9));
    right(fmtUSD(amt), W - M - 6, y, 9);
    y -= lines.length * 11 + 6;
    page.drawLine({ start: { x: M, y: y + 3 }, end: { x: W - M, y: y + 3 }, thickness: 0.4, color: RULE });
    y -= 4;
  }
  y -= 6;
  const taxPct = (Number(sale.tax_rate) * 100).toFixed(3).replace(/\.?0+$/, "");
  ([["Subtotal", fmtUSD(sale.subtotal), false], [sale.taxable ? `Sales tax (${taxPct}%)` : "Sales tax (exempt)", fmtUSD(sale.tax_amount), false], ["TOTAL AMOUNT DUE", fmtUSD(sale.total), true]] as Array<[string, string, boolean]>)
    .forEach(([k, v, b], i) => { right(k, W - M - 110, y - i * 16, b ? 11 : 9, b ? bold : font, b ? INK : MUTED); right(v, W - M - 6, y - i * 16, b ? 12 : 9, b ? bold : font); });
  y -= 70;
  const notes = [sale.notes ? `Notes: ${sale.notes}` : "", `Please reference invoice ${sale.sale_number ?? "(draft)"} with payment.`, s.company?.remit_to ? `Remit to: ${s.company.remit_to}` : ""].filter(Boolean);
  for (const n of notes) { wrap(n, font, 8.5, W - 2 * M).forEach((l) => { text(l, M, y, 8.5, font, MUTED); y -= 11; }); y -= 2; }
  if (s.company?.is_placeholder) text("PLACEHOLDER company details - confirm in Settings before sending to customers.", M, 28, 8, bold, rgb(0.75, 0.1, 0.1));
  if (draft) page.drawText("DRAFT - NOT AN INVOICE", { x: 120, y: 300, size: 46, font: bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.18, rotate: degrees(35) });
  return doc.save({ useObjectStreams: false });
}

// ───────────────────────── Credit memo ─────────────────────────
/** A credit against a sent invoice. Stored once at issue and never regenerated. */
export async function renderCreditMemoPdf(memo: { credit_number: string; credit_date: string; reason: string; subtotal: string; tax_rate: string; tax_amount: string; total: string; snapshot: any; created_at: Date }): Promise<Uint8Array> {
  const s = memo.snapshot;
  const doc = await PDFDocument.create();
  doc.setTitle(`Credit memo ${memo.credit_number}`);
  doc.setAuthor(clean(s.company?.legal_name));
  doc.setCreator("Champion Billing");
  doc.setProducer("Champion Billing");
  doc.setCreationDate(memo.created_at);
  doc.setModificationDate(memo.created_at);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 40;
  const page = doc.addPage([W, H]);
  const text = (t: unknown, x: number, y: number, size = 9, f = font, color = INK) => page.drawText(clean(t), { x, y, size, font: f, color });
  const right = (t: unknown, xr: number, y: number, size = 9, f = font, color = INK) => page.drawText(clean(t), { x: xr - f.widthOfTextAtSize(clean(t), size), y, size, font: f, color });

  let y = H - M;
  text(s.company?.legal_name, M, y - 14, 18, bold, ACCENT);
  [s.company?.address_line1, s.company?.address_line2, s.company?.city_state_zip, [s.company?.phone, s.company?.email].filter(Boolean).join("  |  ")].filter(Boolean)
    .forEach((l, i) => text(l, M, y - 30 - i * 11, 9, font, MUTED));
  right("CREDIT MEMO", W - M, y - 14, 18, bold);
  ([["Credit memo #", memo.credit_number], ["Date", fmtDate(memo.credit_date)], ["Applies to invoice", s.invoice.number], ["Invoice date", fmtDate(s.invoice.date)]] as Array<[string, string]>)
    .forEach(([k, v], i) => { right(k, W - M - 120, y - 32 - i * 12, 9, font, MUTED); right(v, W - M, y - 32 - i * 12, 9, bold); });

  y = H - M - 100;
  page.drawRectangle({ x: M, y: y - 34, width: W - 2 * M, height: 38, color: PO_BG, borderColor: ACCENT, borderWidth: 1.2 });
  text("CUSTOMER PO NUMBER", M + 10, y - 12, 8, bold, ACCENT);
  text(s.po_number ?? "NONE", M + 10, y - 28, 16, bold);
  text("BILLING PERIOD", M + 200, y - 12, 8, bold, ACCENT);
  text(`${fmtDate(s.invoice.period_start)} - ${fmtDate(s.invoice.period_end)}`, M + 200, y - 28, 13, bold);
  text("RENTAL AGREEMENT", M + 380, y - 12, 8, bold, ACCENT);
  text(s.contract?.number ?? "-", M + 380, y - 28, 13, bold);

  y -= 56;
  text("CUSTOMER", M, y, 8, bold, MUTED);
  text(s.customer.name, M, y - 13, 10, bold);
  const addr = wrap(s.customer.billing_address ?? "", font, 9, 260);
  addr.forEach((l, i) => text(l, M, y - 25 - i * 11, 9));
  text("EQUIPMENT", M + 290, y, 8, bold, MUTED);
  text(`${s.equipment.unit_number} ${s.equipment.description}`, M + 290, y - 13, 10, bold);

  y -= 80;
  page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: rgb(0.95, 0.96, 0.97) });
  text("Reason for credit", M + 6, y, 8, bold, MUTED);
  right("Amount", W - M - 6, y, 8, bold, MUTED);
  y -= 18;
  const lines = wrap(memo.reason, font, 9, 400);
  lines.forEach((l, i) => text(l, M + 6, y - i * 11, 9));
  right(`-${fmtUSD(memo.subtotal)}`, W - M - 6, y, 9);
  y -= lines.length * 11 + 16;
  const taxPct = (Number(memo.tax_rate) * 100).toFixed(3).replace(/\.?0+$/, "");
  ([["Credit before tax", `-${fmtUSD(memo.subtotal)}`, false], [`Sales tax credited${Number(memo.tax_amount) > 0 ? ` (${taxPct}%)` : ""}`, `-${fmtUSD(memo.tax_amount)}`, false], ["TOTAL CREDIT", `-${fmtUSD(memo.total)}`, true]] as Array<[string, string, boolean]>)
    .forEach(([k, v, b], i) => { right(k, W - M - 110, y - i * 16, b ? 11 : 9, b ? bold : font, b ? INK : MUTED); right(v, W - M - 6, y - i * 16, b ? 12 : 9, b ? bold : font); });
  y -= 70;
  wrap(`This credit reduces the balance of invoice ${s.invoice.number} (original total ${fmtUSD(s.invoice.total)}). The original invoice is unchanged. Please reference ${memo.credit_number} and PO ${s.po_number ?? "(none)"} when applying it.`, font, 8.5, W - 2 * M)
    .forEach((l, i) => text(l, M, y - i * 11, 8.5, font, MUTED));
  if (s.company?.is_placeholder) text("PLACEHOLDER company details - confirm in Settings before sending to customers.", M, 28, 8, bold, rgb(0.75, 0.1, 0.1));
  return doc.save({ useObjectStreams: false });
}

// ───────────────────────── Delivery / pickup ticket ─────────────────────────
async function startDoc(title: string, when: Date) {
  const doc = await PDFDocument.create();
  doc.setTitle(title); doc.setCreator("Champion Billing"); doc.setProducer("Champion Billing");
  doc.setCreationDate(when); doc.setModificationDate(when);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 40;
  const page = doc.addPage([W, H]);
  const text = (t: unknown, x: number, y: number, size = 9, f = font, color = INK) => page.drawText(clean(t), { x, y, size, font: f, color });
  const right = (t: unknown, xr: number, y: number, size = 9, f = font, color = INK) => page.drawText(clean(t), { x: xr - f.widthOfTextAtSize(clean(t), size), y, size, font: f, color });
  return { doc, page, font, bold, W, H, M, text, right };
}

export async function renderTicketPdf(t: {
  ticket_number: string; kind: "delivery" | "pickup"; scheduled_date: string; completed_at: Date; company: any; customer: any; contract_number: string;
  unit: any; site_address: string | null; site_contact: string | null; driver: string | null; truck: string | null; instructions: string | null;
  hours: string | null; fuel_level: string | null; condition_notes: string | null; signed_by: string; signature_png: Buffer;
}): Promise<Uint8Array> {
  const { doc, page, font, bold, W, H, M, text, right } = await startDoc(`${t.kind === "delivery" ? "Delivery" : "Pickup"} ticket ${t.ticket_number}`, t.completed_at);
  let y = H - M;
  text(t.company?.legal_name, M, y - 14, 18, bold, ACCENT);
  [t.company?.address_line1, t.company?.city_state_zip, t.company?.phone].filter(Boolean).forEach((l, i) => text(l, M, y - 30 - i * 11, 9, font, MUTED));
  right(t.kind === "delivery" ? "DELIVERY TICKET" : "PICKUP TICKET", W - M, y - 14, 16, bold);
  ([["Ticket #", t.ticket_number], ["Date", fmtDate(t.scheduled_date)], ["Rental agreement", t.contract_number]] as Array<[string, string]>)
    .forEach(([k, v], i) => { right(k, W - M - 120, y - 34 - i * 12, 9, font, MUTED); right(v, W - M, y - 34 - i * 12, 9, bold); });
  y -= 100;
  page.drawLine({ start: { x: M, y: y + 10 }, end: { x: W - M, y: y + 10 }, thickness: 0.6, color: RULE });
  const rows: Array<[string, string]> = [
    ["Customer", `${t.customer.name} (${t.customer.customer_code})`],
    ["Unit", `${t.unit.unit_number}  ${t.unit.description}${t.unit.serial_number ? `  S/N ${t.unit.serial_number}` : ""}`],
    ["Jobsite", t.site_address ?? "-"], ["Site contact", t.site_contact ?? "-"],
    ["Driver / truck", [t.driver, t.truck].filter(Boolean).join(" / ") || "-"],
    ["Hour meter", t.hours ?? "-"], ["Fuel level", t.fuel_level ?? "-"],
    ["Condition", t.condition_notes ?? "No damage noted"], ["Instructions", t.instructions ?? "-"],
  ];
  for (const [k, v] of rows) {
    const lines = wrap(v, font, 10, W - 2 * M - 110);
    text(k, M, y, 9, font, MUTED);
    lines.forEach((l, i) => text(l, M + 110, y - i * 13, 10, k === "Unit" || k === "Customer" ? bold : font));
    y -= Math.max(1, lines.length) * 13 + 8;
  }
  y -= 10;
  const statement = t.kind === "delivery"
    ? "Received the equipment above in good working order, with the hour meter and fuel level shown, unless noted under Condition."
    : "Released the equipment above to Champion Equipment for return, with the hour meter, fuel level and condition shown.";
  wrap(statement, font, 9, W - 2 * M).forEach((l, i) => text(l, M, y - i * 12, 9, font, MUTED));
  y -= 40;
  const png = await doc.embedPng(t.signature_png);
  const sw = 220, sh = Math.min(80, (png.height / png.width) * sw);
  page.drawImage(png, { x: M, y: y - sh, width: sw, height: sh });
  y -= sh + 6;
  page.drawLine({ start: { x: M, y }, end: { x: M + 260, y }, thickness: 0.8, color: INK });
  text(`Signed by ${t.signed_by}`, M, y - 13, 9, bold);
  text(`${t.completed_at.toLocaleString("en-US", { timeZone: "America/Chicago" })} Central`, M, y - 25, 8, font, MUTED);
  return doc.save({ useObjectStreams: false });
}

// ───────────────────────── Quote ─────────────────────────
const BASIS_WORD: Record<string, string> = { daily: "day", weekly: "week", cycle_28: "28 days", cycle_30: "30 days", monthly: "month" };
export async function renderQuotePdf(qt: { quote_number: string; quote_date: string; valid_until: string; jobsite: string | null; contact: string | null; notes: string | null; created_at: Date },
  lines: any[], company: any, customer: any): Promise<Uint8Array> {
  const { doc, page, font, bold, W, H, M, text, right } = await startDoc(`Quote ${qt.quote_number}`, qt.created_at);
  let y = H - M;
  text(company?.legal_name, M, y - 14, 18, bold, ACCENT);
  [company?.address_line1, company?.address_line2, company?.city_state_zip, [company?.phone, company?.email].filter(Boolean).join("  |  ")].filter(Boolean)
    .forEach((l, i) => text(l, M, y - 30 - i * 11, 9, font, MUTED));
  right("RENTAL QUOTE", W - M, y - 14, 18, bold);
  ([["Quote #", qt.quote_number], ["Date", fmtDate(qt.quote_date)], ["Good through", fmtDate(qt.valid_until)]] as Array<[string, string]>)
    .forEach(([k, v], i) => { right(k, W - M - 110, y - 34 - i * 12, 9, font, MUTED); right(v, W - M, y - 34 - i * 12, 9, bold); });
  y -= 110;
  text("PREPARED FOR", M, y, 8, bold, MUTED);
  text(customer.name, M, y - 13, 10, bold);
  wrap(customer.billing_address ?? "", font, 9, 250).forEach((l, i) => text(l, M, y - 25 - i * 11, 9));
  if (qt.jobsite) { text("JOBSITE", M + 290, y, 8, bold, MUTED); wrap(qt.jobsite, font, 9, 230).forEach((l, i) => text(l, M + 290, y - 13 - i * 11, 9)); }
  if (qt.contact) text(`Attn: ${qt.contact}`, M, y - 70, 9);
  y -= 95;
  page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: rgb(0.95, 0.96, 0.97) });
  text("Equipment", M + 6, y, 8, bold, MUTED); text("Dates", M + 250, y, 8, bold, MUTED);
  right("Qty", M + 380, y, 8, bold, MUTED); right("Rate", W - M - 90, y, 8, bold, MUTED); right("Deliver / pick up", W - M - 6, y, 8, bold, MUTED);
  y -= 18;
  for (const l of lines) {
    const d = wrap(`${l.description}${l.category ? ` (${l.category})` : ""}`, font, 9, 235);
    d.forEach((s, i) => text(s, M + 6, y - i * 11, 9));
    text(`${fmtDate(l.start_date)}${l.end_date ? ` - ${fmtDate(l.end_date)}` : " - open"}`, M + 250, y, 9);
    right(String(l.quantity), M + 380, y, 9);
    right(`${fmtUSD(l.rate_amount)} / ${BASIS_WORD[l.rate_basis]}`, W - M - 90, y, 9, bold);
    right(`${fmtUSD(l.delivery_charge)} / ${fmtUSD(l.pickup_charge)}`, W - M - 6, y, 9);
    y -= Math.max(1, d.length) * 11 + 8;
    page.drawLine({ start: { x: M, y: y + 4 }, end: { x: W - M, y: y + 4 }, thickness: 0.4, color: RULE });
  }
  y -= 12;
  const terms = [
    "Rates are per unit and exclude sales tax.",
    "Availability is confirmed when the quote is accepted and the equipment is reserved.",
    qt.notes ?? "",
  ].filter(Boolean);
  for (const t of terms) { const w = wrap(t, font, 8.5, W - 2 * M); w.forEach((s, i) => text(s, M, y - i * 11, 8.5, font, MUTED)); y -= w.length * 11 + 4; }
  if (company?.is_placeholder) text("PLACEHOLDER company details - confirm in Settings before sending to customers.", M, 28, 8, bold, rgb(0.75, 0.1, 0.1));
  return doc.save({ useObjectStreams: false });
}
