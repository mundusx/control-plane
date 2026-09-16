import { migrateChatFromEnv } from "../src/migrations.js";
if (!process.env.MUNDUSX_DATABASE_POOL_URL && !process.env.DATABASE_URL) throw new Error("Database URL required for deployment migrations");
await migrateChatFromEnv();
