// Names the operator gives to LNbits wallets and accounts. They live in nutboard's own SQLite file
// (next to passkeys and sessions); nothing is ever written to LNbits or to a mint.
import type { DatabaseSync } from "node:sqlite";

export const LABEL_KINDS = ["wallet", "account"] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];
export type Labels = Record<LabelKind, Record<string, string>>;

const MAX_NAME = 60;
const MAX_ID = 200;

export class LabelError extends Error {}

export function createLabels(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS labels (
    kind       TEXT NOT NULL,              -- wallet | account
    id         TEXT NOT NULL,              -- the wallet or account id in LNbits
    name       TEXT NOT NULL,
    updated_at INTEGER NOT NULL,           -- unix ms
    PRIMARY KEY (kind, id)
  )`);
  const q = {
    all: db.prepare("SELECT kind, id, name FROM labels"),
    upsert: db.prepare(
      `INSERT INTO labels (kind, id, name, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (kind, id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    ),
    remove: db.prepare("DELETE FROM labels WHERE kind = ? AND id = ?"),
  };

  function all(): Labels {
    const out: Labels = { wallet: {}, account: {} };
    for (const row of q.all.all() as Array<{ kind: string; id: string; name: string }>) {
      if (row.kind === "wallet" || row.kind === "account") out[row.kind][row.id] = row.name;
    }
    return out;
  }

  /** Sets the name of one wallet or account; an empty name removes it. */
  function set(kind: unknown, id: unknown, name: unknown): Labels {
    if (kind !== "wallet" && kind !== "account") throw new LabelError('kind must be "wallet" or "account"');
    if (typeof id !== "string" || !id || id.length > MAX_ID) throw new LabelError("id must be a wallet or account id");
    if (typeof name !== "string") throw new LabelError("name must be text");
    // Collapse whitespace and drop control characters: the name is shown in tables and tooltips.
    const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
    if (clean) q.upsert.run(kind, id, clean, Date.now());
    else q.remove.run(kind, id);
    return all();
  }

  return { all, set };
}

export type LabelStore = ReturnType<typeof createLabels>;
