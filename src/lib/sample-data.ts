/**
 * SAMPLE data for development and acceptance testing. The first four rows are the real examples
 * Champion supplied; the remaining 22 are invented placeholders so the 26-unit workflow can be exercised
 * until the real November file is loaded.
 */
export interface SampleUnit {
  unit: string; description: string; serial: string; make: string; model: string;
  contract: string; job: string; wo: string; rate: string; onRent: string; po: string; poTotal: string; real: boolean;
}

const real: SampleUnit[] = [
  { unit: "MUR002101", description: "Mini excavator 3.5T", serial: "SAMPLE-SN-2101", make: "SAMPLE", model: "ME35", contract: "CE-10025", job: "5276", wo: "184139", rate: "1924.25", onRent: "2026-08-14", po: "459186", poTotal: "2083.00", real: true },
  { unit: "MUR002102", description: "Mini excavator 3.5T", serial: "SAMPLE-SN-2102", make: "SAMPLE", model: "ME35", contract: "CE-10026", job: "5430", wo: "184140", rate: "1924.25", onRent: "2026-09-02", po: "459381", poTotal: "2083.00", real: true },
  { unit: "MUR02035", description: "Mini excavator 2.5T", serial: "SAMPLE-SN-2035", make: "SAMPLE", model: "ME25", contract: "CE-10027", job: "4814", wo: "178493", rate: "1443.19", onRent: "2026-07-21", po: "459187", poTotal: "1562.25", real: true },
  { unit: "SSL019098", description: "Skid steer loader", serial: "SAMPLE-SN-9098", make: "SAMPLE", model: "SSL90", contract: "CE-10028", job: "5398", wo: "160063", rate: "2927.94", onRent: "2026-06-30", po: "459201", poTotal: "3169.50", real: true },
];

const kinds = [
  { prefix: "MUR0021", description: "Mini excavator 3.5T", model: "ME35", rate: "1924.25", total: "2083.00" },
  { prefix: "SSL0191", description: "Skid steer loader", model: "SSL90", rate: "2927.94", total: "3169.50" },
  { prefix: "CTL0045", description: "Compact track loader", model: "CTL75", rate: "3250.00", total: "3518.13" },
  { prefix: "EXC0088", description: "Excavator 14T", model: "EX140", rate: "5400.00", total: "5845.50" },
];
const jobs = ["5276", "5430", "4814", "5398", "5512", "5120"];

const synthetic: SampleUnit[] = Array.from({ length: 22 }, (_, i) => {
  const k = kinds[i % kinds.length];
  const n = String(10 + i).padStart(2, "0");
  return {
    unit: `${k.prefix}${n}`, description: k.description, serial: `SAMPLE-SN-${k.model}-${n}`, make: "SAMPLE", model: k.model,
    contract: `CE-${10029 + i}`, job: jobs[i % jobs.length], wo: String(184200 + i), rate: k.rate,
    onRent: `2026-${String(6 + (i % 4)).padStart(2, "0")}-${String(1 + ((i * 3) % 27)).padStart(2, "0")}`,
    po: String(459300 + i * 7), poTotal: k.total, real: false,
  };
});

export const RPM_SAMPLE_UNITS: SampleUnit[] = [...real, ...synthetic];

export function rpmPoCsv(units = RPM_SAMPLE_UNITS, poFor: (u: SampleUnit, i: number) => string = (u) => u.po) {
  const lines = ["PO Number,Unit,Work Order,Job,PO Total"];
  units.forEach((u, i) => lines.push([poFor(u, i), u.unit, u.wo, u.job, u.poTotal].join(",")));
  return lines.join("\n") + "\n";
}

/** December sample: every unit gets a different, new PO. */
export const decemberPo = (_u: SampleUnit, i: number) => String(560100 + i * 3);
