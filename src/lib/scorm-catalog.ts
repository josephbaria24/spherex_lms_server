/** Hostinger static SCORM packages (Option A). */
export const PETROSPHERE_SCORM_BASE = "https://petrosphere.com.ph/spherex_lms/scorm";

export type ScormCatalogEntry = {
  /** Folder name on Hostinger, e.g. "127" */
  packageId: string;
  title: string;
  description?: string;
};

export function scormStoryUrl(packageId: string): string {
  return `${PETROSPHERE_SCORM_BASE}/${packageId}/story.html`;
}

/**
 * Known Uncanny / Hostinger package IDs (119–127).
 * Rename titles in admin after seeding if your WordPress mapping differs.
 */
export const HOSTINGER_SCORM_PACKAGES: ScormCatalogEntry[] = [
  { packageId: "119", title: "Petrosphere Safety Module 119" },
  { packageId: "120", title: "Petrosphere Safety Module 120" },
  { packageId: "121", title: "Petrosphere Safety Module 121" },
  { packageId: "122", title: "Petrosphere Safety Module 122" },
  { packageId: "123", title: "Petrosphere Safety Module 123" },
  { packageId: "124", title: "Petrosphere Safety Module 124" },
  { packageId: "125", title: "Petrosphere Safety Module 125" },
  { packageId: "126", title: "Petrosphere Safety Module 126" },
  {
    packageId: "127",
    title: "Mandatory Eight-Hour Safety and Health Training (MESH)",
    description: "DOLE-recognized MESH training module.",
  },
];

export const PETROSPHERE_SCORM_COURSE = {
  title: "Petrosphere SCORM Library",
  description:
    "Self-paced Storyline modules hosted on Petrosphere. Progress is saved manually for external modules; upload packages to enable automatic SCORM tracking.",
  category: "Safety",
  level: "beginner" as const,
  duration: "Self-paced",
};
