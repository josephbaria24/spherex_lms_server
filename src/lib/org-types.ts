export type OrganizationStatus = "pending" | "active" | "suspended";

export type OrgMemberRole = "owner" | "admin" | "teacher" | "student";

export const ORG_MEMBER_ROLES = {
  OWNER: "owner",
  ADMIN: "admin",
  TEACHER: "teacher",
  STUDENT: "student",
} as const satisfies Record<string, OrgMemberRole>;

export type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logo: string | null;
  website: string | null;
  industry: string | null;
  status: OrganizationStatus;
  teacher_join_code: string;
  student_join_code: string | null;
  max_members: number | null;
  brand_primary: string | null;
  brand_accent: string | null;
  logo_padding: number;
  logo_position_x: number;
  logo_position_y: number;
  created_at: string;
  updated_at: string;
};

export type OrganizationMemberRow = {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrgMemberRole;
  joined_at: string;
};

export type OrganizationMembership = OrganizationMemberRow & {
  organization: Pick<
    OrganizationRow,
    | "id"
    | "name"
    | "slug"
    | "logo"
    | "status"
    | "industry"
    | "brand_primary"
    | "logo_padding"
    | "logo_position_x"
    | "logo_position_y"
  >;
};
