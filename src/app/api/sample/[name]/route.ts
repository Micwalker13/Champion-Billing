import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getUser } from "@/lib/session";
import { RPM_SAMPLE_UNITS, rpmPoCsv } from "@/lib/sample-data";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!(await getUser())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { name } = await params;
  if (name === "rpm-po-2026-11.csv") return new NextResponse(rpmPoCsv(), { headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${name}"` } });
  if (name === "rpm-po-2026-11.xlsx") {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("POs");
    ws.addRow(["PO Number", "Unit", "Work Order", "Job", "PO Total"]);
    for (const u of RPM_SAMPLE_UNITS) ws.addRow([Number(u.po), u.unit, Number(u.wo), Number(u.job), Number(u.poTotal)]);
    const buf = await wb.xlsx.writeBuffer();
    return new NextResponse(new Uint8Array(buf as ArrayBuffer), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${name}"` } });
  }
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
