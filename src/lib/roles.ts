export type AppRole = "admin" | "teacher" | "student" | "user";

export const ROLES = {
  ADMIN: "admin",
  TEACHER: "teacher",
  STUDENT: "student",
  USER: "user",
} as const satisfies Record<string, AppRole>;

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
