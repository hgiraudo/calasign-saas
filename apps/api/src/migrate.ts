import { createDb, migrate } from "./infra/db";

const db = await createDb();
await migrate(db, (m) => console.log(m));
console.log("migraciones al día");
await db.close();
