import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import {
  assertOrgRoleFromRequest,
  getOrganizationById,
  getUserOrgIds,
  isSuperAdmin,
} from "../../lib/org-helpers.js";
import { ORG_MEMBER_ROLES, type OrgMemberRole } from "../../lib/org-types.js";
import { assertOrgMemberCapacity } from "../../lib/org-limits.js";
import { orgLogoPublicPath } from "../../lib/org-uploads.js";
import { handleOrgLogoUpload } from "../../middleware/org-logo-upload.js";
import { generateTeacherJoinCode, generateStudentJoinCode } from "../../utils/org-code.js";
import { logoAppearanceSchema } from "../../lib/org-logo-schema.js";

const router = Router();
router.use(requireAuth);

const orgIdParam = z.object({ orgId: z.string().uuid() });
const memberIdParam = z.object({
  orgId: z.string().uuid(),
  memberId: z.string().uuid(),
});

const hexColor = z
  .string()
  .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, "Invalid hex color")
  .optional()
  .or(z.literal(""));

const updateOrgSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  logo: z.string().url().optional().or(z.literal("")),
  website: z.string().url().optional().or(z.literal("")),
  industry: z.string().max(120).optional(),
  brand_primary: hexColor,
  brand_accent: hexColor,
  ...logoAppearanceSchema,
});

const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "teacher", "student"]),
});

const updateMemberSchema = z.object({
  role: z.enum(["owner", "admin", "teacher", "student"]).optional(),
});

async function requireOrgAdminAccess(req: Request, orgId: string) {
  return assertOrgRoleFromRequest(req, orgId, [
    ORG_MEMBER_ROLES.OWNER,
    ORG_MEMBER_ROLES.ADMIN,
  ]);
}

// GET /org-admin/mine — orgs the user can administer
router.get(
  "/mine",
  asyncHandler(async (req: Request, res: Response) => {
    if (isSuperAdmin(req.user!.role)) {
      const all = await query(
        `SELECT o.id, o.name, o.slug, o.logo, o.status, o.industry, o.teacher_join_code,
                o.brand_primary, o.brand_accent, o.logo_padding, o.logo_position_x, o.logo_position_y,
                o.max_members,
                'owner'::text AS role
           FROM organizations o
          ORDER BY o.name`,
      );
      return res.json({ organizations: all.rows });
    }

    const result = await query(
      `SELECT o.id, o.name, o.slug, o.logo, o.status, o.industry, o.teacher_join_code,
              o.brand_primary, o.brand_accent, o.logo_padding, o.logo_position_x, o.logo_position_y,
              o.max_members, om.role
         FROM organization_members om
         JOIN organizations o ON o.id = om.organization_id
        WHERE om.user_id = $1 AND om.role IN ('owner', 'admin')
        ORDER BY o.name`,
      [req.user!.sub],
    );
    res.json({ organizations: result.rows });
  }),
);

// GET /org-admin/:orgId/dashboard
router.get(
  "/:orgId/dashboard",
  validate(orgIdParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId } = orgIdParam.parse(req.params);
    await requireOrgAdminAccess(req, orgId);

    const org = await getOrganizationById(orgId);
    if (!org) throw HttpError.notFound("Organization not found");

    const [members, courses, students, teachers] = await Promise.all([
      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM organization_members WHERE organization_id = $1`,
        [orgId],
      ),
      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM courses WHERE organization_id = $1`,
        [orgId],
      ),
      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM organization_members
         WHERE organization_id = $1 AND role = 'student'`,
        [orgId],
      ),
      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM organization_members
         WHERE organization_id = $1 AND role = 'teacher'`,
        [orgId],
      ),
    ]);

    res.json({
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        status: org.status,
        industry: org.industry,
        logo: org.logo,
        teacher_join_code: org.teacher_join_code,
        student_join_code: org.student_join_code,
        brand_primary: org.brand_primary,
        brand_accent: org.brand_accent,
        logo_padding: org.logo_padding,
        logo_position_x: org.logo_position_x,
        logo_position_y: org.logo_position_y,
        max_members: org.max_members,
      },
      stats: {
        members: Number(members.rows[0]?.count ?? 0),
        courses: Number(courses.rows[0]?.count ?? 0),
        students: Number(students.rows[0]?.count ?? 0),
        teachers: Number(teachers.rows[0]?.count ?? 0),
      },
    });
  }),
);

// GET /org-admin/:orgId/members
router.get(
  "/:orgId/members",
  validate(orgIdParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId } = orgIdParam.parse(req.params);
    await requireOrgAdminAccess(req, orgId);

    const result = await query(
      `SELECT om.id, om.role, om.joined_at,
              u.id AS user_id, u.email, u.full_name, u.name, u.role AS platform_role, u.status
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
        WHERE om.organization_id = $1
        ORDER BY om.role, u.full_name, u.email`,
      [orgId],
    );
    res.json({ members: result.rows });
  }),
);

// POST /org-admin/:orgId/members
router.post(
  "/:orgId/members",
  validate(orgIdParam, "params"),
  validate(addMemberSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId } = orgIdParam.parse(req.params);
    await requireOrgAdminAccess(req, orgId);
    const body = addMemberSchema.parse(req.body);

    const userResult = await query<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = lower($1)",
      [body.email],
    );
    const targetUser = userResult.rows[0];
    if (!targetUser) {
      throw HttpError.badRequest("No user with that email. They must register first.");
    }

    await assertOrgMemberCapacity(orgId);

    const inserted = await query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING id, role, joined_at`,
      [orgId, targetUser.id, body.role],
    );

    if (body.role === "teacher") {
      await query(
        `UPDATE users SET role = 'teacher' WHERE id = $1 AND role IN ('student', 'user')`,
        [targetUser.id],
      );
    }

    res.status(201).json({ member: inserted.rows[0] });
  }),
);

// PATCH /org-admin/:orgId/members/:memberId
router.patch(
  "/:orgId/members/:memberId",
  validate(memberIdParam, "params"),
  validate(updateMemberSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId, memberId } = memberIdParam.parse(req.params);
    const membership = await requireOrgAdminAccess(req, orgId);
    const body = updateMemberSchema.parse(req.body);

    const existing = await query<{ id: string; role: OrgMemberRole; user_id: string }>(
      `SELECT id, role, user_id FROM organization_members
       WHERE id = $1 AND organization_id = $2`,
      [memberId, orgId],
    );
    const member = existing.rows[0];
    if (!member) throw HttpError.notFound("Member not found");

    if (body.role && body.role !== member.role) {
      if (member.role === "owner") {
        const owners = await query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM organization_members
           WHERE organization_id = $1 AND role = 'owner'`,
          [orgId],
        );
        if (Number(owners.rows[0]?.count ?? 0) <= 1) {
          throw HttpError.badRequest("Cannot change role of the only organization owner");
        }
      }
      if (body.role === "owner" && membership.role !== "owner" && !isSuperAdmin(req.user!.role)) {
        throw HttpError.forbidden("Only the organization owner can assign owner role");
      }
    }

    if (body.role) {
      await query(
        `UPDATE organization_members SET role = $1 WHERE id = $2`,
        [body.role, memberId],
      );
    }

    res.json({ ok: true });
  }),
);

// DELETE /org-admin/:orgId/members/:memberId
router.delete(
  "/:orgId/members/:memberId",
  validate(memberIdParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId, memberId } = memberIdParam.parse(req.params);
    await requireOrgAdminAccess(req, orgId);

    const existing = await query<{ role: OrgMemberRole }>(
      `SELECT role FROM organization_members WHERE id = $1 AND organization_id = $2`,
      [memberId, orgId],
    );
    const member = existing.rows[0];
    if (!member) throw HttpError.notFound("Member not found");

    if (member.role === "owner") {
      const owners = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM organization_members
         WHERE organization_id = $1 AND role = 'owner'`,
        [orgId],
      );
      if (Number(owners.rows[0]?.count ?? 0) <= 1) {
        throw HttpError.badRequest("Cannot remove the only organization owner");
      }
    }

    await query("DELETE FROM organization_members WHERE id = $1", [memberId]);
    res.json({ ok: true });
  }),
);

// GET /org-admin/:orgId/settings
router.get(
  "/:orgId/settings",
  validate(orgIdParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId } = orgIdParam.parse(req.params);
    await requireOrgAdminAccess(req, orgId);
    const org = await getOrganizationById(orgId);
    if (!org) throw HttpError.notFound("Organization not found");
    res.json({ organization: org });
  }),
);

// PATCH /org-admin/:orgId/settings
router.patch(
  "/:orgId/settings",
  validate(orgIdParam, "params"),
  validate(updateOrgSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId } = orgIdParam.parse(req.params);
    await requireOrgAdminAccess(req, orgId);
    const body = updateOrgSchema.parse(req.body);

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      values.push(v === "" ? null : v);
    }
    if (fields.length === 0) throw HttpError.badRequest("No fields to update");
    values.push(orgId);

    const result = await query(
      `UPDATE organizations SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values,
    );
    res.json({ organization: result.rows[0] });
  }),
);

// POST /org-admin/:orgId/logo
router.post(
  "/:orgId/logo",
  validate(orgIdParam, "params"),
  asyncHandler(async (req: Request, res: Response, next) => {
    const { orgId } = orgIdParam.parse(req.params);
    await requireOrgAdminAccess(req, orgId);

    handleOrgLogoUpload(orgId)(req, res, async (err) => {
      if (err) return next(err);
      try {
        const logo = orgLogoPublicPath(orgId, req.file!.filename);
        const updated = await query(
          "UPDATE organizations SET logo = $1 WHERE id = $2 RETURNING logo",
          [logo, orgId],
        );
        res.json({ logo: updated.rows[0]?.logo });
      } catch (e) {
        next(e);
      }
    });
  }),
);

// POST /org-admin/:orgId/regenerate-teacher-code
router.post(
  "/:orgId/regenerate-teacher-code",
  validate(orgIdParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId } = orgIdParam.parse(req.params);
    await requireOrgAdminAccess(req, orgId);
    const org = await getOrganizationById(orgId);
    if (!org) throw HttpError.notFound("Organization not found");

    let code = generateTeacherJoinCode(org.slug);
    for (let attempt = 0; attempt < 5; attempt++) {
      const clash = await query(
        "SELECT id FROM organizations WHERE teacher_join_code = $1 AND id <> $2",
        [code, orgId],
      );
      if (!clash.rows[0]) break;
      code = generateTeacherJoinCode(org.slug);
    }

    const updated = await query(
      `UPDATE organizations SET teacher_join_code = $1 WHERE id = $2 RETURNING teacher_join_code`,
      [code, orgId],
    );
    res.json({ teacher_join_code: updated.rows[0]?.teacher_join_code });
  }),
);

// POST /org-admin/:orgId/regenerate-student-code
router.post(
  "/:orgId/regenerate-student-code",
  validate(orgIdParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId } = orgIdParam.parse(req.params);
    await requireOrgAdminAccess(req, orgId);
    const org = await getOrganizationById(orgId);
    if (!org) throw HttpError.notFound("Organization not found");

    let code = generateStudentJoinCode(org.slug);
    for (let attempt = 0; attempt < 5; attempt++) {
      const clash = await query(
        "SELECT id FROM organizations WHERE student_join_code = $1 AND id <> $2",
        [code, orgId],
      );
      if (!clash.rows[0]) break;
      code = generateStudentJoinCode(org.slug);
    }

    const updated = await query(
      `UPDATE organizations SET student_join_code = $1 WHERE id = $2 RETURNING student_join_code`,
      [code, orgId],
    );
    res.json({ student_join_code: updated.rows[0]?.student_join_code });
  }),
);

// GET /org-admin/:orgId/courses
router.get(
  "/:orgId/courses",
  validate(orgIdParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId } = orgIdParam.parse(req.params);
    await requireOrgAdminAccess(req, orgId);

    const adminOrgIds = isSuperAdmin(req.user!.role)
      ? [orgId]
      : await getUserOrgIds(req.user!.sub, ["owner", "admin"]);
    if (!adminOrgIds.includes(orgId)) throw HttpError.forbidden();

    const result = await query(
      `SELECT c.*,
              (SELECT COUNT(*)::int FROM enrollments e WHERE e.course_id = c.id) AS student_count,
              (SELECT COUNT(*)::int FROM lessons l WHERE l.course_id = c.id) AS lesson_count
         FROM courses c
        WHERE c.organization_id = $1
        ORDER BY c.created_at DESC`,
      [orgId],
    );
    res.json({ courses: result.rows });
  }),
);

export default router;
