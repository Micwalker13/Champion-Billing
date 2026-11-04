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
    ["Equipment unit", s.equipment.unit_number],
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
  invoices: Array<{ invoice_number: string; invoice_date: string; due_date: string; po_number: string | null; unit: string; period_start: string; period_end: string; total: string; amount_paid: string; balance: string; days_past_due: number }>;
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
  const cols: Array<[string, number, "l" | "r"]> = [["Invoice #", M, "l"], ["Date", M + 82, "l"], ["Due", M + 132, "l"], ["PO", M + 182, "l"], ["Unit", M + 228, "l"], ["Period", M + 290, "l"], ["Total", M + 418, "r"], ["Paid", M + 470, "r"], ["Balance", W - M, "r"]];
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
    const vals = [inv.invoice_number, fmtDate(inv.invoice_date), fmtDate(inv.due_date), inv.po_number ?? "-", inv.unit, `${fmtDate(inv.period_start)}-${fmtDate(inv.period_end).slice(0, 5)}`, fmtUSD(inv.total), fmtUSD(inv.amount_paid), fmtUSD(inv.balance)];
    cols.forEach(([, x, a], i) => (a === "r" ? right(vals[i], x, y, 8.5, i === 8 ? bold : font) : text(vals[i], x + 3, y, 8.5, font, inv.days_past_due > 0 && i === 2 ? rgb(0.7, 0.1, 0.1) : INK)));
    y -= 13;
  }
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.5, color: RULE });
  right("Total balance due", M + 470, y - 8, 10, bold);
  right(fmtUSD(totals.total), W - M, y - 8, 10, bold);
  y -= 34;

  if (payments.length) {
    if (y < M + 80) { page = doc.addPage([W, H]); y = H - M; }
    text("PAYMENTS RECEIVED (LAST 90 DAYS)", M, y, 8, bold, MUTED);
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
