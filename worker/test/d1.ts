// The slice of D1 the Worker uses, over node:sqlite, with the Worker's own schema.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SCHEMA } from '../src/schema.ts';

export function fakeD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  for (const sql of SCHEMA) db.exec(sql);

  const prepare = (sql: string) => {
    let args: SQLInputValue[] = [];
    const statement = {
      bind(...values: SQLInputValue[]) { args = values; return statement; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { db.prepare(sql).run(...args); return { success: true }; },
    };
    return statement;
  };
  const batch = async (statements: { run(): Promise<unknown> }[]) => {
    const out = [];
    for (const s of statements) out.push(await s.run());
    return out;
  };
  return { prepare, batch } as unknown as D1Database;
}
