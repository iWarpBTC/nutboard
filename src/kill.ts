// The kill switch: the one thing nutboard can do besides looking.
//
// nutboard runs as an unprivileged, sandboxed user and cannot stop anything itself. Asking for a kill
// means creating an empty file with a fixed name in KILL_SWITCH_DIR. A root-owned systemd path unit
// watches that directory and runs deploy/killswitch/nutboard-kill.sh, which stops and disables the
// units listed in KILL_SWITCH_CONF. Nothing nutboard writes is ever read as a command or an argument:
// the helper only looks at which of four file names exist.
//
// It works in one direction. Starting things again takes a root shell on the server (deploy/README.md).
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { KillConfig } from "./config.ts";

export const KILL_TARGETS = [
  {
    id: "mints",
    label: "Stop the mints",
    confirm: "STOP MINTS",
    groups: ["mints"],
    description: "Stops and disables the mint services. Wallets get connection errors; ecash and quotes stay as they are in the databases.",
  },
  {
    id: "lnbits",
    label: "Stop LNbits",
    confirm: "STOP LNBITS",
    groups: ["lnbits"],
    description: "Stops and disables LNbits. Its wallets, extensions and API stop answering.",
  },
  {
    id: "all",
    label: "Stop mints and LNbits",
    confirm: "STOP ALL",
    groups: ["mints", "lnbits"],
    description: "Both of the above at once.",
  },
  {
    id: "lnd-link",
    label: "Cut the link to the Lightning node",
    confirm: "CUT LND",
    groups: ["lnd-link", "mints", "lnbits"],
    catastrophic: true,
    description:
      "Takes down the tunnel to the Lightning node first, then stops the mints and LNbits. Nothing on this server can pay or " +
      "create an invoice until the tunnel is brought back by hand. It does not help if this server itself is taken over: " +
      "then the peer has to be removed on the node.",
  },
] as const;
export type KillTargetId = (typeof KILL_TARGETS)[number]["id"];
export type KillGroup = "mints" | "lnbits" | "lnd-link";

const GROUP_KEYS: Record<KillGroup, string> = { mints: "MINT_UNITS", lnbits: "LNBITS_UNITS", "lnd-link": "LND_LINK_UNITS" };
const UNIT_NAME = /^[A-Za-z0-9@:._-]+\.(service|socket|target)$/;

export class KillError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface UnitState {
  group: KillGroup;
  unit: string;
  /** what systemd says: active, inactive, failed, activating…; "unknown" when it cannot be asked */
  state: string;
}

export interface KillStatus {
  enabled: true;
  targets: typeof KILL_TARGETS;
  units: UnitState[];
  /** requests written but not yet picked up by the root helper */
  pending: string[];
  /** whether the helper's directory and unit list are in place */
  problems: string[];
  log: Array<{ at: number; target: string; passkey: string | null; userAgent: string | null }>;
}

/** KEY="unit unit" lines from the helper's configuration; anything else in the file is ignored. */
export function parseUnits(text: string): Record<KillGroup, string[]> {
  const out: Record<KillGroup, string[]> = { mints: [], lnbits: [], "lnd-link": [] };
  for (const [group, key] of Object.entries(GROUP_KEYS) as Array<[KillGroup, string]>) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^#\\n]*))`, "m").exec(text);
    const raw = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
    out[group] = raw.split(/\s+/).filter((u) => UNIT_NAME.test(u));
  }
  return out;
}

function systemctlStates(units: string[]): Promise<string[]> {
  if (!units.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    // Exits non-zero as soon as one unit is not active; the answer is on stdout either way, one line per unit.
    execFile("systemctl", ["is-active", "--", ...units], { timeout: 3000 }, (_err, stdout) => {
      const lines = String(stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      // No systemctl (a development machine) or a short answer: say so instead of guessing.
      resolve(lines.length === units.length ? lines : units.map(() => "unknown"));
    });
  });
}

export function createKillSwitch(db: DatabaseSync, config: KillConfig) {
  db.exec(`CREATE TABLE IF NOT EXISTS kill_log (
    id            INTEGER PRIMARY KEY,
    at            INTEGER NOT NULL,        -- unix ms
    target        TEXT NOT NULL,
    credential_id TEXT,                    -- the passkey that confirmed it
    user_agent    TEXT
  )`);
  const q = {
    insert: db.prepare("INSERT INTO kill_log (at, target, credential_id, user_agent) VALUES (?, ?, ?, ?)"),
    recent: db.prepare(
      `SELECT l.at, l.target, c.name AS passkey, l.user_agent AS userAgent
         FROM kill_log l LEFT JOIN auth_credentials c ON c.id = l.credential_id
        ORDER BY l.at DESC LIMIT 20`,
    ),
  };
  const requestFile = (target: string): string => join(config.dir, `${target}.request`);

  function units(): { units: Record<KillGroup, string[]>; problems: string[] } {
    const problems: string[] = [];
    let parsed: Record<KillGroup, string[]> = { mints: [], lnbits: [], "lnd-link": [] };
    try {
      parsed = parseUnits(readFileSync(config.conf, "utf8"));
    } catch {
      problems.push(`cannot read ${config.conf}: the list of units is unknown`);
    }
    if (!existsSync(config.dir)) problems.push(`${config.dir} does not exist: the root-side helper is not installed`);
    return { units: parsed, problems };
  }

  async function status(): Promise<KillStatus> {
    const { units: byGroup, problems } = units();
    const flat = (Object.keys(byGroup) as KillGroup[]).flatMap((group) => byGroup[group].map((unit) => ({ group, unit })));
    const states = await systemctlStates(flat.map((u) => u.unit));
    let pending: string[] = [];
    try {
      pending = readdirSync(config.dir).filter((f) => f.endsWith(".request")).map((f) => f.slice(0, -".request".length));
    } catch {
      /* reported above */
    }
    return {
      enabled: true,
      targets: KILL_TARGETS,
      units: flat.map((u, i) => ({ ...u, state: states[i] ?? "unknown" })),
      pending,
      problems,
      log: q.recent.all() as KillStatus["log"],
    };
  }

  /** Asks the root helper to carry out one target. The phrase has to be typed exactly. */
  function request(target: unknown, confirm: unknown, who: { credentialId: string | null; userAgent: string | null }): void {
    const t = KILL_TARGETS.find((k) => k.id === target);
    if (!t) throw new KillError(400, "unknown_target", "Unknown kill switch target");
    if (confirm !== t.confirm) throw new KillError(400, "not_confirmed", `Type “${t.confirm}” to confirm`);
    if (!existsSync(config.dir)) {
      throw new KillError(503, "not_installed", `The kill switch helper is not installed (${config.dir} is missing)`);
    }
    try {
      // The content is for humans reading the directory; the helper never looks inside.
      writeFileSync(requestFile(t.id), `${new Date().toISOString()}\n`, { mode: 0o660 });
    } catch (err) {
      throw new KillError(500, "write_failed", `Could not hand the request to the helper: ${(err as Error).message}`);
    }
    q.insert.run(Date.now(), t.id, who.credentialId, who.userAgent);
  }

  return { status, request };
}

export type KillSwitch = ReturnType<typeof createKillSwitch>;
