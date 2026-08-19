// Timezone contract with the RA dashboard: every timestamp in an API response
// is an IST wall-clock string ("YYYY-MM-DDTHH:mm:ss", no zone suffix), which
// the dashboard reads literally (see TG-RA-Frontend/src/lib/datetime.ts). The
// DB/server store real UTC instants, so values are shifted at the boundary —
// same policy as pwa-node-backend/src/lib/ist.ts.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const pad2 = (n: number) => String(n).padStart(2, '0');

export function toIstWallClock(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return (
    `${ist.getUTCFullYear()}-${pad2(ist.getUTCMonth() + 1)}-${pad2(ist.getUTCDate())}` +
    `T${pad2(ist.getUTCHours())}:${pad2(ist.getUTCMinutes())}:${pad2(ist.getUTCSeconds())}`
  );
}

// Parse a scheduled_for string into a UTC instant. The RA dashboard always
// sends IST wall-clock ("YYYY-MM-DDTHH:mm:ss", no zone), so interpret it as
// IST rather than the server's own timezone — this keeps scheduled times exact
// even if the server's TZ is ever changed. A string that already carries a 'Z'
// or numeric offset is parsed as a plain UTC instant instead.
export function parseIstWallClock(value: string): Date | null {
  if (!value) return null;
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!m) return null;
  const d = new Date(
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] ?? '0')
    ) - IST_OFFSET_MS
  );
  return Number.isNaN(d.getTime()) ? null : d;
}
