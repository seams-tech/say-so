/**
 * Per-proposal SQLite Durable Object (`MultisigProposalDO`).
 *
 * Stores:
 * 1. `StoredOpening` (`proposal_id`, `receiver`/`amount_yocto` or `note_id`, `salt_hex`).
 * 2. Per-member `words` refusal counter (`MAX_TRIES = 3`, race-free without CAS loops).
 * 3. Signer `SVT1` templates of members who already spoke this proposal so `same_speaker`
 *    runs in 0 cross-DO hops.
 */

export const MULTISIG_MAX_TRIES = 3;

export interface StoredMultisigOpening {
  proposal_id: number;
  receiver?: string;
  amount_yocto?: string;
  note_id?: number;
  salt_hex: string;
}

export interface MultisigStore {
  saveProposal(
    multisig: string,
    commitmentHex: string,
    opening: StoredMultisigOpening,
    proposer: string,
    proposerTemplateSvt1B64: string,
  ): Promise<void>;
  prepareConfirm(
    multisig: string,
    commitmentHex: string,
    member: string,
  ): Promise<{
    opening: StoredMultisigOpening | null;
    attemptsExhausted: boolean;
    otherSignerTemplatesB64: string[];
  }>;
  recordConfirmOutcome(
    multisig: string,
    commitmentHex: string,
    member: string,
    outcome: 'accept' | 'step_up' | 'words_refusal',
    memberTemplateSvt1B64: string,
  ): Promise<void>;
}

export class MultisigProposalDO {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS opening (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tries (
        member TEXT PRIMARY KEY,
        count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS signers (
        member TEXT PRIMARY KEY,
        svt1_b64 TEXT NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'PUT' && url.pathname === '/proposal') {
      const body = (await request.json()) as {
        opening: StoredMultisigOpening;
        proposer: string;
        proposerTemplateSvt1B64: string;
      };
      this.sql.exec(
        `INSERT INTO opening (id, json) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
        JSON.stringify(body.opening),
      );
      this.sql.exec(
        `INSERT INTO signers (member, svt1_b64) VALUES (?, ?)
         ON CONFLICT(member) DO UPDATE SET svt1_b64 = excluded.svt1_b64`,
        body.proposer,
        body.proposerTemplateSvt1B64,
      );
      return Response.json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/prepare-confirm') {
      const { member } = (await request.json()) as { member: string };
      const openingRows = this.sql.exec(`SELECT json FROM opening WHERE id = 1`).toArray();
      if (openingRows.length === 0) {
        return Response.json({
          opening: null,
          attemptsExhausted: false,
          otherSignerTemplatesB64: [],
        });
      }
      const opening = JSON.parse(String((openingRows[0] as { json: string }).json)) as StoredMultisigOpening;
      const tryRows = this.sql.exec(`SELECT count FROM tries WHERE member = ?`, member).toArray();
      const tries = tryRows.length > 0 ? Number((tryRows[0] as { count: number }).count) : 0;
      const signerRows = this.sql
        .exec(`SELECT svt1_b64 FROM signers WHERE member != ?`, member)
        .toArray() as Array<{ svt1_b64: string }>;
      return Response.json({
        opening,
        attemptsExhausted: tries >= MULTISIG_MAX_TRIES,
        otherSignerTemplatesB64: signerRows.map((r) => String(r.svt1_b64)),
      });
    }

    if (request.method === 'POST' && url.pathname === '/record-outcome') {
      const body = (await request.json()) as {
        member: string;
        outcome: 'accept' | 'step_up' | 'words_refusal';
        memberTemplateSvt1B64: string;
      };
      if (body.outcome === 'words_refusal') {
        this.sql.exec(
          `INSERT INTO tries (member, count) VALUES (?, 1)
           ON CONFLICT(member) DO UPDATE SET count = count + 1`,
          body.member,
        );
      } else {
        this.sql.exec(
          `INSERT INTO signers (member, svt1_b64) VALUES (?, ?)
           ON CONFLICT(member) DO UPDATE SET svt1_b64 = excluded.svt1_b64`,
          body.member,
          body.memberTemplateSvt1B64,
        );
      }
      return Response.json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  }
}

export function createDurableObjectMultisigStore(ns: DurableObjectNamespace): MultisigStore {
  const stubFor = (multisig: string, commitmentHex: string) =>
    ns.get(ns.idFromName(`${multisig}:${commitmentHex}`));

  return {
    async saveProposal(multisig, commitmentHex, opening, proposer, proposerTemplateSvt1B64) {
      await stubFor(multisig, commitmentHex).fetch('https://do/proposal', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opening, proposer, proposerTemplateSvt1B64 }),
      });
    },
    async prepareConfirm(multisig, commitmentHex, member) {
      const res = await stubFor(multisig, commitmentHex).fetch('https://do/prepare-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member }),
      });
      return (await res.json()) as {
        opening: StoredMultisigOpening | null;
        attemptsExhausted: boolean;
        otherSignerTemplatesB64: string[];
      };
    },
    async recordConfirmOutcome(multisig, commitmentHex, member, outcome, memberTemplateSvt1B64) {
      await stubFor(multisig, commitmentHex).fetch('https://do/record-outcome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member, outcome, memberTemplateSvt1B64 }),
      });
    },
  };
}
