/**
 * node:sqlite backend (issue #238 follow-up).
 *
 * node:sqlite (Node's built-in real SQLite) is now the sole backend. This drives
 * a real index + queries through it, so WAL, FTS5 search, and @named-param
 * writes are all exercised end-to-end.
 *
 * Skipped on Node < 22.5 where node:sqlite doesn't exist.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';
import { createDatabase } from '../src/db/sqlite-adapter';

let nodeSqliteAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('node:sqlite');
  nodeSqliteAvailable = true;
} catch {
  nodeSqliteAvailable = false;
}

describe.skipIf(!nodeSqliteAvailable)('node:sqlite backend — real index + queries', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nodesqlite-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function helper(): number { return 1; }\n');
    fs.writeFileSync(
      path.join(dir, 'b.ts'),
      "import { helper } from './a';\nexport function main(): number { return helper(); }\n"
    );
    cg = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the node:sqlite backend', () => {
    expect(cg.getBackend()).toBe('node-sqlite');
  });

  it('runs in WAL mode — the whole reason it beats the wasm fallback', () => {
    expect(cg.getJournalMode()).toBe('wal');
  });

  it('indexed the project (write path: @named-param INSERTs via node:sqlite)', () => {
    const stats = cg.getStats();
    expect(stats.fileCount).toBe(2);
    expect(stats.nodeCount).toBeGreaterThan(0);
  });

  it('FTS5 search returns the indexed symbol (read path)', () => {
    const results = cg.searchNodes('helper');
    const names = results.map(r => r.node.name);
    expect(names).toContain('helper');
  });

  it('graph traversal resolves the cross-file caller', () => {
    const helper = cg.searchNodes('helper').find(r => r.node.name === 'helper');
    expect(helper).toBeTruthy();
    const callers = cg.getCallers(helper!.node.id);
    expect(callers.map(c => c.node.name)).toContain('main');
  });

  it('registers a deterministic Unicode-safe path scalar on each connection', () => {
    const { db } = createDatabase(':memory:');
    db.exec(`
      CREATE TABLE paths (path TEXT);
      INSERT INTO paths(path) VALUES
        ('src/Élite.ts'), ('src/İnput.ts'), ('src/percent%.ts'),
        ('src/under_score.ts'), ('src/api/client.ts'), ('src\\api\\client.ts');
      CREATE INDEX path_scalar_index ON paths(codegraph_contains_ci(path, 'src'));
    `);
    const matching = (needle: unknown): string[] =>
      (db.prepare('SELECT path FROM paths WHERE codegraph_contains_ci(path, ?) = 1 ORDER BY path').all(needle) as Array<{ path: string }>).map(
        (row) => row.path,
      );

    expect(matching('élite')).toEqual(['src/Élite.ts']);
    expect(matching('i')).toContain('src/İnput.ts');
    expect(matching('%')).toEqual(['src/percent%.ts']);
    expect(matching('_')).toEqual(['src/under_score.ts']);
    expect(matching('/api/')).toEqual(['src/api/client.ts']);
    expect(matching('\\api\\')).toEqual(['src\\api\\client.ts']);
    expect(matching('')).toHaveLength(6);
    expect(db.prepare('SELECT codegraph_contains_ci(NULL, ?) AS hit').get('x')).toMatchObject({ hit: 0 });
    expect(db.prepare('SELECT codegraph_contains_ci(42, ?) AS hit').get('x')).toMatchObject({ hit: 0 });
    expect(db.prepare('SELECT codegraph_contains_ci(?, NULL) AS hit').get('x')).toMatchObject({ hit: 0 });
    db.close();
  });

  it('registers the scalar on read-only connections', () => {
    const dbPath = path.join(dir, 'scalar.db');
    const writable = createDatabase(dbPath);
    writable.db.exec('CREATE TABLE paths (path TEXT); INSERT INTO paths(path) VALUES (\'src/Élite.ts\');');
    writable.db.close();

    const readonly = createDatabase(dbPath, { readOnly: true });
    expect(readonly.db.prepare('SELECT codegraph_contains_ci(path, ?) AS hit FROM paths').get('élite')).toMatchObject({ hit: 1 });
    readonly.db.close();
  });

  it('fails construction when scalar registration is unavailable', async () => {
    const moduleLoader = require('node:module') as {
      _load: (...args: unknown[]) => unknown;
    };
    const originalLoad = moduleLoader._load;
    let closeCalls = 0;
    class MissingScalarDatabase {
      close(): void {
        closeCalls++;
      }
    }
    moduleLoader._load = (...args: unknown[]) =>
      args[0] === 'node:sqlite' ? { DatabaseSync: MissingScalarDatabase } : originalLoad(...args);
    try {
      expect(() => createDatabase(':memory:')).toThrow(/DatabaseSync\.function is missing/);
      expect(closeCalls).toBe(1);
    } finally {
      moduleLoader._load = originalLoad;
    }
  });

  it('closes once and preserves a scalar registration error', () => {
    const moduleLoader = require('node:module') as {
      _load: (...args: unknown[]) => unknown;
    };
    const originalLoad = moduleLoader._load;
    const registrationError = new Error('registration failed');
    let closeCalls = 0;
    class ThrowingRegistrationDatabase {
      function(): void {
        throw registrationError;
      }

      close(): void {
        closeCalls++;
      }
    }
    moduleLoader._load = (...args: unknown[]) =>
      args[0] === 'node:sqlite' ? { DatabaseSync: ThrowingRegistrationDatabase } : originalLoad(...args);
    try {
      expect(() => createDatabase(':memory:')).toThrow(/Underlying error: registration failed/);
      expect(closeCalls).toBe(1);
    } finally {
      moduleLoader._load = originalLoad;
    }
  });

  it('preserves a registration error when cleanup also throws', () => {
    const moduleLoader = require('node:module') as {
      _load: (...args: unknown[]) => unknown;
    };
    const originalLoad = moduleLoader._load;
    const registrationError = new Error('registration failed');
    let closeCalls = 0;
    class ThrowingCleanupDatabase {
      function(): void {
        throw registrationError;
      }

      close(): void {
        closeCalls++;
        throw new Error('cleanup failed');
      }
    }
    moduleLoader._load = (...args: unknown[]) =>
      args[0] === 'node:sqlite' ? { DatabaseSync: ThrowingCleanupDatabase } : originalLoad(...args);
    try {
      expect(() => createDatabase(':memory:')).toThrow(/Underlying error: registration failed/);
      expect(closeCalls).toBe(1);
    } finally {
      moduleLoader._load = originalLoad;
    }
  });

  it('does not close a successfully constructed connection early', () => {
    const moduleLoader = require('node:module') as {
      _load: (...args: unknown[]) => unknown;
    };
    const originalLoad = moduleLoader._load;
    let closeCalls = 0;
    class SuccessfulDatabase {
      isOpen = true;

      function(): void {}

      close(): void {
        closeCalls++;
        this.isOpen = false;
      }
    }
    moduleLoader._load = (...args: unknown[]) =>
      args[0] === 'node:sqlite' ? { DatabaseSync: SuccessfulDatabase } : originalLoad(...args);
    let db: ReturnType<typeof createDatabase>['db'] | undefined;
    try {
      db = createDatabase(':memory:').db;
      expect(closeCalls).toBe(0);
    } finally {
      moduleLoader._load = originalLoad;
    }
    db?.close();
    db?.close();
    expect(closeCalls).toBe(1);
  });
});
