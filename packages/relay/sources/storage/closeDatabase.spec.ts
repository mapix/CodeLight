import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeDatabase } from './closeDatabase';

it('closes the real embedded engine after Prisma disconnect and preserves data across reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codelight-db-close-'));
    const pg = new PGlite(directory);
    try {
        await pg.exec('CREATE TABLE fixture (id integer PRIMARY KEY); INSERT INTO fixture VALUES (7)');
        const client = { $disconnect: vi.fn().mockResolvedValue(undefined) };
        await closeDatabase(client, pg);
        expect(pg.closed).toBe(true);
        const reopened = new PGlite(directory);
        try { expect((await reopened.query('SELECT id FROM fixture')).rows).toEqual([{ id: 7 }]); }
        finally { await reopened.close(); }
        expect(client.$disconnect).toHaveBeenCalledTimes(1);
    } finally { if (!pg.closed) await pg.close(); await rm(directory, { recursive: true, force: true }); }
});

it('a Prisma disconnect error cannot skip embedded checkpoint close', async () => {
    const embedded = { close: vi.fn().mockResolvedValue(undefined), closed: false };
    await expect(closeDatabase({ $disconnect: async () => { throw Error('fixture disconnect'); } }, embedded)).rejects.toThrow('fixture disconnect');
    expect(embedded.close).toHaveBeenCalledTimes(1);
});
