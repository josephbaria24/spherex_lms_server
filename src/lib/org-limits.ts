import { query } from "../config/db.js";
import { HttpError } from "../utils/httpError.js";

export async function getOrgMemberCount(organizationId: string): Promise<number> {
  const result = await query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM organization_members WHERE organization_id = $1",
    [organizationId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function assertOrgMemberCapacity(organizationId: string): Promise<void> {
  const org = await query<{ max_members: number | null }>(
    "SELECT max_members FROM organizations WHERE id = $1",
    [organizationId],
  );
  const limit = org.rows[0]?.max_members;
  if (limit == null) return;

  const count = await getOrgMemberCount(organizationId);
  if (count >= limit) {
    throw HttpError.forbidden(`Organization member limit reached (${limit})`);
  }
}
