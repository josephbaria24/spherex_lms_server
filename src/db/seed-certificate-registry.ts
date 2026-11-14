/**
 * Ensure registry tables exist, sync LMS/IELTS certs, import legacy PSI-ELA CSV.
 * Usage: npx tsx src/db/seed-certificate-registry.ts
 */
import {
  ensureCertificateRegistryTables,
  importLegacyCertificateCsv,
  syncIeltsCertificatesIntoRegistry,
  syncLmsCertificatesIntoRegistry,
} from "../lib/certificate-registry.js";

async function main() {
  await ensureCertificateRegistryTables();
  const lms = await syncLmsCertificatesIntoRegistry();
  const ielts = await syncIeltsCertificatesIntoRegistry();
  const legacy = await importLegacyCertificateCsv();
  console.log(
    JSON.stringify(
      {
        lms_synced: lms,
        ielts_synced: ielts,
        legacy_imported: legacy.imported,
        legacy_skipped: legacy.skipped,
        csv: legacy.path,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
