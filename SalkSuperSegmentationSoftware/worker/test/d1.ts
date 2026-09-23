// The slice of D1 the Worker uses, over node:sqlite, with the real migrations.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export function fakeD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));

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
  return { prepare } as unknown as D1Database;
}
