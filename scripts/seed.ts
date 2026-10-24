import "dotenv/config";
/** Seeds global lifecycle templates. Implemented by the email agent in src/lib/email/seed-templates.ts */
import { seedGlobalTemplates } from "../src/lib/email/seed-templates";

seedGlobalTemplates()
  .then((n: number) => {
    console.log(`seeded ${n} template(s)`);
    process.exit(0);
  })
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
