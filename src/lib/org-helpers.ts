import type { Request } from "express";
import { query } from "../config/db.js";
import { HttpError } from "../utils/httpError.js";
import { isAdmin } from "./roles.js";
import type { OrgMemberRole, OrganizationMembership, OrganizationRow } from "./org-types.js";

export function isSuperAdmin(role?: string | null): boolean {
  return isAdmin(role);
}

export async function getUserOrgIds(
  userId: string,
  roles?: OrgMemberRole[],
): Promise<string[]> {
  if (roles && roles.length > 0) {
    const placeholders = roles.map((_, i) => `$${i + 2}`).join(", ");
    const result = await query<{ organization_id: string }>(
      `SELECT organization_id FROM organization_members
       WHERE user_id = $1 AND role IN (${placeholders})`,
      [userId, ...roles],
    );
    return result.rows.map((r) => r.organization_id);
  }

  const result = await query<{ organization_id: string }>(
    "SELECT organization_id FROM organization_members WHERE user_id = $1",
    [userId],
  );
  return result.rows.map((r) => r.organization_id);
}

const orgOrganizationFields = `
              'id', o.id,
              'name', o.name,
              'slug', o.slug,
              'logo', o.logo,
              'status', o.status,
              'industry', o.industry,
              'brand_primary', o.brand_primary,
              'logo_padding', o.logo_padding,
              'logo_position_x', o.logo_position_x,
              'logo_position_y', o.logo_position_y`;

export async function getUserOrgMembership(
  userId: string,
  organizationId: string,
): Promise<OrganizationMembership | null> {
  const result = await query<OrganizationMembership>(
    `SELECT om.id, om.organization_id, om.user_id, om.role, om.joined_at,
            json_build_object(
              ${orgOrganizationFields}
            ) AS organization
       FROM organization_members om
       JOIN organizations o ON o.id = om.organization_id
      WHERE om.user_id = $1 AND om.organization_id = $2`,
    [userId, organizationId],
  );
  return result.rows[0] ?? null;
}

export async function listUserMemberships(userId: string): Promise<OrganizationMembership[]> {
  const result = await query<OrganizationMembership>(
    `SELECT om.id, om.organization_id, om.user_id, om.role, om.joined_at,
            json_build_object(
              ${orgOrganizationFields}
            ) AS organization
       FROM organization_members om
       JOIN organizations o ON o.id = om.organization_id
      WHERE om.user_id = $1
      ORDER BY o.name`,
    [userId],
  );
  return result.rows;
}

export async function getOrganizationById(id: string): Promise<OrganizationRow | null> {
  const result = await query<OrganizationRow>(
    "SELECT * FROM organizations WHERE id = $1",
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getOrganizationBySlug(slug: string): Promise<OrganizationRow | null> {
  const result = await query<OrganizationRow>(
    "SELECT * FROM organizations WHERE slug = $1",
    [slug],
  );
  return result.rows[0] ?? null;
}

export async function assertOrgRole(
  userId: string,
  organizationId: string,
  allowed: OrgMemberRole[],
): Promise<OrganizationMembership> {
  const membership = await getUserOrgMembership(userId, organizationId);
  if (!membership) {
    throw HttpError.forbidden("You are not a member of this organization");
  }
  if (!allowed.includes(membership.role)) {
    throw HttpError.forbidden("Insufficient organization permissions");
  }
  return membership;
}

export async function assertOrgRoleFromRequest(
  req: Request,
  organizationId: string,
  allowed: OrgMemberRole[],
): Promise<OrganizationMembership> {
  if (!req.user) throw HttpError.unauthorized();
  if (isSuperAdmin(req.user.role)) {
    const org = await getOrganizationById(organizationId);
    if (!org) throw HttpError.notFound("Organization not found");
    return {
      id: "",
      organization_id: organizationId,
      user_id: req.user.sub,
      role: "owner",
      joined_at: new Date().toISOString(),
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        logo: org.logo,
        status: org.status,
        industry: org.industry,
        brand_primary: org.brand_primary,
        logo_padding: org.logo_padding,
        logo_position_x: org.logo_position_x,
        logo_position_y: org.logo_position_y,
      },
    };
  }
  return assertOrgRole(req.user.sub, organizationId, allowed);
}
