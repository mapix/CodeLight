export async function closeDatabase(client: { $disconnect(): Promise<void> }, embedded: { close(): Promise<void>; closed?: boolean } | null) {
    // Prisma adapter 不拥有传入的 PGlite；只 disconnect 会漏掉检查点落盘。
    try { await client.$disconnect(); }
    finally { if (embedded && !embedded.closed) await embedded.close(); }
}
