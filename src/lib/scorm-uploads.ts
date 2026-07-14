import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { getUploadsRoot } from "./org-uploads.js";

export const SCORM_UPLOADS_SEGMENT = "scorm";

const LAUNCH_CANDIDATES_SCORM = ["index_lms.html", "story.html", "index.html"];
const LAUNCH_CANDIDATES_PLAYBACK = ["story.html", "index_lms.html", "index.html"];

export function getScormPackageDir(courseId: string, lessonId: string): string {
  return path.join(getUploadsRoot(), SCORM_UPLOADS_SEGMENT, courseId, lessonId);
}

export function initScormUploadsDirectory(): void {
  fs.mkdirSync(path.join(getUploadsRoot(), SCORM_UPLOADS_SEGMENT), { recursive: true });
}

export function clearScormPackage(courseId: string, lessonId: string): void {
  const dir = getScormPackageDir(courseId, lessonId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function findLaunchFile(rootDir: string, candidates = LAUNCH_CANDIDATES_SCORM): string | null {
  for (const name of candidates) {
    const full = path.join(rootDir, name);
    if (fs.existsSync(full)) return name;
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("__"));
  for (const sub of subdirs) {
    const nested = findLaunchFile(path.join(rootDir, sub.name), candidates);
    if (nested) return path.join(sub.name, nested).replace(/\\/g, "/");
  }

  return null;
}

export function extractScormZip(
  zipPath: string,
  courseId: string,
  lessonId: string,
): { launchPath: string; publicUrl: string; sanitization: ScormSanitizeReport } {
  const dest = getScormPackageDir(courseId, lessonId);
  clearScormPackage(courseId, lessonId);
  fs.mkdirSync(dest, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(dest, true);

  const launchFile = findLaunchFile(dest, LAUNCH_CANDIDATES_SCORM);
  if (!launchFile) {
    clearScormPackage(courseId, lessonId);
    throw new Error(
      "Could not find index_lms.html, story.html, or index.html in the SCORM package",
    );
  }

  // Store story.html for direct playback; embed layer switches to index_lms for SCORM API.
  const playbackFile =
    findLaunchFile(dest, LAUNCH_CANDIDATES_PLAYBACK) ?? launchFile;

  const publicPath = `/uploads/${SCORM_UPLOADS_SEGMENT}/${courseId}/${lessonId}/${playbackFile}`;
  const sanitization = sanitizeScormPackage(dest);
  return { launchPath: playbackFile, publicUrl: publicPath, sanitization };
}

const SAFE_STORYLINE_USER_JS = `function ExecuteScript(strId) {
  switch (strId) {
  }
}
`;

export type ScormPackageFormat = "scorm12" | "xapi" | "unknown";

export type ScormSanitizeReport = {
  packageFormat: ScormPackageFormat;
  patchedUserJs: string[];
  patchedLmsLaunch: string[];
  patchedPlayerScale: string[];
  patchedFrameStrings: string[];
  patchedFrameUpscale: string[];
  patchedScormDriver: string[];
  warnings: string[];
};

export function detectScormPackageFormat(packageDir: string): ScormPackageFormat {
  const manifestPath = path.join(packageDir, "imsmanifest.xml");
  if (fs.existsSync(manifestPath)) {
    const manifest = fs.readFileSync(manifestPath, "utf8");
    if (/ADL SCORM|adlcp|scorm/i.test(manifest)) {
      return "scorm12";
    }
  }
  if (fs.existsSync(path.join(packageDir, "tincan.xml"))) {
    return "xapi";
  }
  return "unknown";
}

function findFilesNamed(rootDir: string, filename: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(rootDir)) return results;

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === filename) {
      results.push(full);
    } else if (entry.isDirectory() && !entry.name.startsWith("__")) {
      results.push(...findFilesNamed(full, filename));
    }
  }
  return results;
}

function relativePackagePath(packageDir: string, filePath: string): string {
  return path.relative(packageDir, filePath).replace(/\\/g, "/");
}

/** LearnDash / WordPress exports inject LMS hooks into story_content/user.js. */
export function isIncompatibleStorylineUserJs(content: string): boolean {
  if (content.trim() === SAFE_STORYLINE_USER_JS.trim()) return false;

  return (
    /LearnDashId/i.test(content) ||
    /learndash/i.test(content) ||
    /getParameterByName\(\s*['"]actor['"]\s*\)/.test(content) ||
    /actor\.mbox/.test(content) ||
    /JSON\.parse\(\s*getParameterByName/.test(content) ||
    (/getParameterByName\(\s*['"]auth['"]\s*\)/.test(content) && /mailto:/i.test(content))
  );
}

/** LearnDash exports often enable Tin Can alongside SCORM; Storyline then ignores window.API. */
function patchLearnDashLmsLaunchHtml(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf8");
  if (!/lmsPresent:\s*true/.test(content) || !/tinCanPresent:\s*true/.test(content)) {
    return false;
  }

  const patched = content.replace(/tinCanPresent:\s*true/g, "tinCanPresent: false");
  if (patched !== content) {
    fs.writeFileSync(filePath, patched, "utf8");
    return true;
  }
  return false;
}

/**
 * Storyline xAPI-only exports ship index_lms.html with tinCanPresent:true and no imsmanifest.xml.
 * Without an LRS the player can stall on a blank slide; enable SCORM API + disable Tin Can instead.
 */
function patchXapiOnlyLmsLaunchHtml(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf8");
  if (!/tinCanPresent:\s*true/.test(content) || /lmsPresent:\s*true/.test(content)) {
    return false;
  }

  let patched = content.replace(/tinCanPresent:\s*true/g, "tinCanPresent: false");
  patched = patched.replace(/lmsPresent:\s*false/g, "lmsPresent: true");
  if (patched !== content) {
    fs.writeFileSync(filePath, patched, "utf8");
    return true;
  }
  return false;
}

/** Storyline xAPI publishes ship scormdriver.js in TCAPI mode (needs tc-config.js). */
function patchXapiScormDriver(driverPath: string): boolean {
  const content = fs.readFileSync(driverPath, "utf8");
  if (!content.includes('strLMSStandard = "TCAPI"')) {
    return false;
  }

  let patched = content.replace('strLMSStandard = "TCAPI"', 'strLMSStandard = "SCORM"');
  // Relative to index_lms.html, "../tc-config.js" resolves above the package folder when nested under /courseId/lessonId/.
  patched = patched.replace('loadScript("../tc-config.js"', 'loadScript("tc-config.js"');
  if (patched === content) {
    return false;
  }

  fs.writeFileSync(driverPath, patched, "utf8");
  return true;
}

/**
 * Storyline "lock at optimal size" publishes scale: 'noscale', which letterboxes in fullscreen iframes.
 * "Scale player to fill browser" uses scale: 'show all' and enables viewport scaling.
 */
function patchStorylinePlayerScale(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf8");
  if (!/scale:\s*['"]noscale['"]/.test(content)) {
    return false;
  }

  const patched = content.replace(/scale:\s*['"]noscale['"]/g, "scale: 'show all'");
  if (patched === content) {
    return false;
  }

  fs.writeFileSync(filePath, patched, "utf8");
  return true;
}

/** Unified theme caps scale at 1x when preventUpscale is true — patch so fullscreen can upscale. */
function patchUnifiedFramePreventUpscale(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf8");
  if (!/"preventUpscale":true/.test(content)) {
    return false;
  }

  const patched = content.replace(/"preventUpscale":true/g, '"preventUpscale":false');
  if (patched === content) {
    return false;
  }

  fs.writeFileSync(filePath, patched, "utf8");
  return true;
}

/** Storyline 360 unified theme renamed acc_volume; older player chrome still requests it. */
function patchUnifiedFrameStringTable(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf8");
  if (!/"theme":"unified"/.test(content) || content.includes('"acc_volume"')) {
    return false;
  }

  const accMuteMatch = content.match(/"acc_mute":"((?:\\.|[^"\\])*)"/);
  const volumeLabel = accMuteMatch?.[1]?.replace(/ \(Ctrl\+Alt\+M\)$/i, "") ?? "volume";
  const patched = content.replace(
    /"acc_mute":"((?:\\.|[^"\\])*)"/,
    `"acc_mute":"$1","acc_volume":"${volumeLabel}"`,
  );
  if (patched !== content) {
    fs.writeFileSync(filePath, patched, "utf8");
    return true;
  }
  return false;
}

/**
 * Auto-fix common LearnDash / WordPress migration issues in extracted Storyline packages.
 * Called automatically after every SCORM zip upload.
 */
export function sanitizeScormPackage(packageDir: string): ScormSanitizeReport {
  const report: ScormSanitizeReport = {
    packageFormat: detectScormPackageFormat(packageDir),
    patchedUserJs: [],
    patchedLmsLaunch: [],
    patchedPlayerScale: [],
    patchedFrameStrings: [],
    patchedFrameUpscale: [],
    patchedScormDriver: [],
    warnings: [],
  };

  if (report.packageFormat === "xapi") {
    report.warnings.push(
      "This zip is an xAPI (Tin Can) publish, not SCORM 1.2. Re-export from Storyline as LMS → SCORM 1.2 for full tracking.",
    );
  }

  for (const userJsPath of findFilesNamed(packageDir, "user.js")) {
    if (!userJsPath.includes(`${path.sep}story_content${path.sep}`)) continue;
    const content = fs.readFileSync(userJsPath, "utf8");
    if (isIncompatibleStorylineUserJs(content)) {
      fs.writeFileSync(userJsPath, SAFE_STORYLINE_USER_JS, "utf8");
      report.patchedUserJs.push(relativePackagePath(packageDir, userJsPath));
    }
  }

  for (const launchPath of findFilesNamed(packageDir, "index_lms.html")) {
    const rel = relativePackagePath(packageDir, launchPath);
    if (patchLearnDashLmsLaunchHtml(launchPath)) {
      report.patchedLmsLaunch.push(rel);
    } else if (report.packageFormat === "xapi" && patchXapiOnlyLmsLaunchHtml(launchPath)) {
      report.patchedLmsLaunch.push(rel);
    }
  }

  for (const launchName of ["story.html", "index_lms.html"] as const) {
    for (const launchPath of findFilesNamed(packageDir, launchName)) {
      if (patchStorylinePlayerScale(launchPath)) {
        report.patchedPlayerScale.push(relativePackagePath(packageDir, launchPath));
      }
    }
  }

  for (const framePath of findFilesNamed(packageDir, "frame.js")) {
    if (!framePath.includes(`${path.sep}html5${path.sep}data${path.sep}js${path.sep}`)) continue;
    const rel = relativePackagePath(packageDir, framePath);
    if (patchUnifiedFrameStringTable(framePath)) {
      report.patchedFrameStrings.push(rel);
    }
    if (patchUnifiedFramePreventUpscale(framePath)) {
      report.patchedFrameUpscale.push(rel);
    }
  }

  if (report.packageFormat === "xapi") {
    for (const driverPath of findFilesNamed(packageDir, "scormdriver.js")) {
      if (!driverPath.includes(`${path.sep}lms${path.sep}`)) continue;
      if (patchXapiScormDriver(driverPath)) {
        report.patchedScormDriver.push(relativePackagePath(packageDir, driverPath));
      }
    }
  }

  return report;
}

export function scormPackagePublicPath(courseId: string, lessonId: string, launchFile: string): string {
  return `/uploads/${SCORM_UPLOADS_SEGMENT}/${courseId}/${lessonId}/${launchFile}`;
}
