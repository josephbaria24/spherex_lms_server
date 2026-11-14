export type AppRole = "admin" | "teacher" | "student" | "user";
export type TeachingField = "ielts" | "courses";

export const ROLES = {
  ADMIN: "admin",
  TEACHER: "teacher",
  STUDENT: "student",
  USER: "user",
} as const satisfies Record<string, AppRole>;

export const TEACHING_FIELDS = {
  IELTS: "ielts",
  COURSES: "courses",
} as const satisfies Record<string, TeachingField>;

export function isAdmin(role?: string | null): role is typeof ROLES.ADMIN {
  return role === ROLES.ADMIN;
}

export function isTeacher(role?: string | null): role is typeof ROLES.TEACHER {
  return role === ROLES.TEACHER;
}

export function canAccessAdminPanel(role?: string | null): boolean {
  return isAdmin(role);
}

export function canAccessTeacherPanel(role?: string | null): boolean {
  return isTeacher(role) || isAdmin(role);
}

export function isIeltsTeacher(
  role?: string | null,
  teachingField?: string | null,
): boolean {
  return isTeacher(role) && teachingField === TEACHING_FIELDS.IELTS;
}

export function canAccessIeltsStaff(
  role?: string | null,
  teachingField?: string | null,
): boolean {
  return isAdmin(role) || isIeltsTeacher(role, teachingField);
}
