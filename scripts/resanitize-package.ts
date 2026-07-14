import { sanitizeScormPackage } from "../src/lib/scorm-uploads.js";

const packageDir =
  process.argv[2] ??
  "uploads/scorm/33ca7421-aa40-487e-8b7d-b4efbf71fc5c/d9886220-3212-4fad-96c0-142638e5bdf6";

const report = sanitizeScormPackage(packageDir);
console.log(JSON.stringify(report, null, 2));
