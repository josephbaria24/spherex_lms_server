import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth } from "../../middleware/auth.js";
import { listUserMemberships } from "../../lib/org-helpers.js";
import { ORG_MEMBER_ROLES } from "../../lib/org-types.js";
import type { OrgMemberRole } from "../../lib/org-types.js";
import { assertOrgMemberCapacity } from "../../lib/org-limits.js";
import type { OrganizationRow } from "../../lib/org-types.js";
import { validate } from "../../middleware/validate.js";
import {
  createNotification,
  listOrgAdminIds,
  notifyUsers,
} from "../../lib/notifications.js";

const router = Router();

const slugParam = z.object({ slug: z.string().min(1).max(100) });

const joinSchema = z.object({
  code: z.string().min(4).max(32),
});

function normalizeJoinCode(code: string): string {
  return code.trim().toUpperCase();
}

function publicOrgFields(row: OrganizationRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    logo: row.logo,
    website: row.website,
    industry: row.industry,
    status: row.status,
    brand_primary: row.brand_primary,
    logo_padding: row.logo_padding,
    logo_position_x: row.logo_position_x,
    logo_position_y: row.logo_position_y,
    created_at: row.created_at,
  };
}

// GET /organizations/public — active orgs for landing (no join codes)
router.get(
  "/public",
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await query<OrganizationRow & { member_count: string; course_count: string }>(
      `SELECT o.*,
              (SELECT COUNT(DISTINCT om.user_id)::text FROM organization_members om WHERE om.organization_id = o.id) AS member_count,
              (SELECT COUNT(*)::text FROM courses c WHERE c.organization_id = o.id) AS course_count
         FROM organizations o
        WHERE o.status IN ('active', 'pending')
        ORDER BY CASE WHEN o.status = 'active' THEN 0 ELSE 1 END, o.name`,
    );
    res.json({
      organizations: result.rows.map((row) => ({
        ...publicOrgFields(row),
        member_count: Number(row.member_count ?? 0),
        course_count: Number(row.course_count ?? 0),
      })),
    });
  }),
);

// GET /organizations/public/:slug
router.get(
  "/public/:slug",
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = slugParam.parse(req.params);
    const result = await query<OrganizationRow>(
      `SELECT * FROM organizations WHERE slug = $1 AND status IN ('active', 'pending')`,
      [slug],
    );
    const org = result.rows[0];
    if (!org) throw HttpError.notFound("Organization not found");

    const courses = await query(
      `SELECT id, title, description, category, level, duration, lessons, enrolled_count,
              thumbnail, image
         FROM courses WHERE organization_id = $1 ORDER BY created_at DESC`,
      [org.id],
    );

    const counts = await query<{ member_count: string; course_count: string }>(
      `SELECT
         (SELECT COUNT(DISTINCT om.user_id)::text FROM organization_members om WHERE om.organization_id = $1) AS member_count,
         (SELECT COUNT(*)::text FROM courses c WHERE c.organization_id = $1) AS course_count`,
      [org.id],
    );

    res.json({
      organization: {
        ...publicOrgFields(org),
        member_count: Number(counts.rows[0]?.member_count ?? 0),
        course_count: Number(counts.rows[0]?.course_count ?? 0),
      },
      courses: courses.rows,
    });
  }),
);

// GET /organizations/me — current user's org memberships
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const memberships = await listUserMemberships(req.user!.sub);
    res.json({ memberships });
  }),
);

// POST /organizations/join — teacher joins org via teacher code
router.post(
  "/join",
  requireAuth,
  validate(joinSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { code } = joinSchema.parse(req.body);
    const normalized = normalizeJoinCode(code);

    if (req.user!.role === "admin") {
      throw HttpError.badRequest("Platform admins cannot join organizations with a join code");
    }

    const orgResult = await query<OrganizationRow>(
      `SELECT * FROM organizations
        WHERE upper(teacher_join_code) = $1`,
      [normalized],
    );
    const org = orgResult.rows[0];
    if (!org) throw HttpError.notFound("Invalid teacher organization code");
    if (org.status === "suspended") {
      throw HttpError.forbidden("This organization is not accepting new members");
    }

    const existingMember = await query(
      "SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2",
      [org.id, req.user!.sub],
    );
    const wasNew = !existingMember.rows[0];
    if (wasNew) {
      await assertOrgMemberCapacity(org.id);
    }

    const memberResult = await query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET
         role = CASE
           WHEN organization_members.role IN ('owner', 'admin') THEN organization_members.role
           ELSE EXCLUDED.role
         END
       RETURNING id, role, organization_id`,
      [org.id, req.user!.sub, ORG_MEMBER_ROLES.TEACHER],
    );

    if (req.user!.role === "student" || req.user!.role === "user") {
      await query(
        `UPDATE users SET role = 'teacher' WHERE id = $1 AND role IN ('student', 'user')`,
        [req.user!.sub],
      );
    }

    if (wasNew) {
      const joiner = await query<{ full_name: string | null; email: string }>(
        `SELECT full_name, email FROM users WHERE id = $1`,
        [req.user!.sub],
      );
      const label =
        joiner.rows[0]?.full_name?.trim() || joiner.rows[0]?.email || "A teacher";

      await createNotification({
        userId: req.user!.sub,
        type: "organization.member_joined",
        title: "Joined organization",
        body: `You joined ${org.name} as a teacher.`,
        link: "/teacher",
        referenceId: memberResult.rows[0]!.id,
      });

      await notifyUsers(
        (await listOrgAdminIds(org.id)).filter((id) => id !== req.user!.sub),
        {
          type: "organization.member_joined",
          title: "New teacher joined",
          body: `${label} joined ${org.name}.`,
          link: `/org/${org.slug}/members`,
          referenceId: memberResult.rows[0]!.id,
        },
      );
    }

    res.status(201).json({
      membership: memberResult.rows[0],
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
      },
      promoted_to_teacher: req.user!.role === "student" || req.user!.role === "user",
    });
  }),
);

// POST /organizations/join/student — student joins org via student code
router.post(
  "/join/student",
  requireAuth,
  validate(joinSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { code } = joinSchema.parse(req.body);
    const normalized = normalizeJoinCode(code);

    if (req.user!.role === "admin") {
      throw HttpError.badRequest("Platform admins cannot join organizations with a join code");
    }

    const orgResult = await query<OrganizationRow>(
      `SELECT * FROM organizations
        WHERE upper(student_join_code) = $1`,
      [normalized],
    );
    const org = orgResult.rows[0];
    if (!org) throw HttpError.notFound("Invalid student organization code");
    if (org.status === "suspended") {
      throw HttpError.forbidden("This organization is not accepting new members");
    }

    const existingMember = await query(
      "SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2",
      [org.id, req.user!.sub],
    );
    const wasNew = !existingMember.rows[0];
    if (wasNew) {
      await assertOrgMemberCapacity(org.id);
    }

    const memberResult = await query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET
         role = CASE
           WHEN organization_members.role IN ('owner', 'admin', 'teacher') THEN organization_members.role
           ELSE EXCLUDED.role
         END
       RETURNING id, role, organization_id`,
      [org.id, req.user!.sub, ORG_MEMBER_ROLES.STUDENT],
    );

    if (wasNew) {
      const joiner = await query<{ full_name: string | null; email: string }>(
        `SELECT full_name, email FROM users WHERE id = $1`,
        [req.user!.sub],
      );
      const label =
        joiner.rows[0]?.full_name?.trim() || joiner.rows[0]?.email || "A student";

      await createNotification({
        userId: req.user!.sub,
        type: "organization.member_joined",
        title: "Joined organization",
        body: `You joined ${org.name}.`,
        link: "/dashboard",
        referenceId: memberResult.rows[0]!.id,
      });

      await notifyUsers(
        (await listOrgAdminIds(org.id)).filter((id) => id !== req.user!.sub),
        {
          type: "organization.member_joined",
          title: "New student joined",
          body: `${label} joined ${org.name}.`,
          link: `/org/${org.slug}/members`,
          referenceId: memberResult.rows[0]!.id,
        },
      );
    }

    res.status(201).json({
      membership: memberResult.rows[0],
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
      },
    });
  }),
);

export default router;
