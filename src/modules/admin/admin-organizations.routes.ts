import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query, withTransaction } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { generateTeacherJoinCode, generateStudentJoinCode } from "../../utils/org-code.js";
import { slugifyName } from "../../utils/slug.js";
import { hashPassword } from "../../utils/password.js";
import { ORG_MEMBER_ROLES, type OrgMemberRole } from "../../lib/org-types.js";
import { assertOrgMemberCapacity } from "../../lib/org-limits.js";
import { orgLogoPublicPath } from "../../lib/org-uploads.js";
import { handleOrgLogoUpload } from "../../middleware/org-logo-upload.js";
import { logoAppearanceSchema } from "../../lib/org-logo-schema.js";

const router = Router();
router.use(requireAuth, requireAdmin);

const idParam = z.object({ id: z.string().uuid() });
const memberIdParam = z.object({
  id: z.string().uuid(),
  memberId: z.string().uuid(),
});

const hexColor = z
  .string()
  .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, "Invalid hex color")
  .optional()
  .or(z.literal(""));

const orgAdminSchema = z
  .object({
    existing_user_id: z.string().uuid().optional(),
    email: z.string().email().optional(),
    password: z.string().min(8).max(128).optional(),
    full_name: z.string().min(1).max(120).optional(),
    role: z.enum(["owner", "admin"]).optional(),
  })
  .optional();

const createOrgSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase letters, numbers, and hyphens")
    .optional(),
  description: z.string().max(2000).optional(),
  website: z.string().url().optional().or(z.literal("")),
  industry: z.string().max(120).optional(),
  logo: z.string().url().optional().or(z.literal("")),
  status: z.enum(["pending", "active", "suspended"]).optional(),
  max_members: z.number().int().positive().nullable().optional(),
  brand_primary: hexColor,
  brand_accent: hexColor,
  ...logoAppearanceSchema,
  org_admin: orgAdminSchema,
});

const updateOrgSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase letters, numbers, and hyphens")
    .optional(),
  description: z.string().max(2000).optional(),
  website: z.string().url().optional().or(z.literal("")),
  industry: z.string().max(120).optional(),
  logo: z.string().url().optional().or(z.literal("")),
  status: z.enum(["pending", "active", "suspended"]).optional(),
  max_members: z.number().int().positive().nullable().optional(),
  brand_primary: hexColor,
  brand_accent: hexColor,
  ...logoAppearanceSchema,
});

const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "admin", "teacher", "student"]),
});

const updateMemberSchema = z.object({
  role: z.enum(["owner", "admin", "teacher", "student"]).optional(),
});

async function ensureUniqueSlug(base: string, excludeId?: string): Promise<string> {
  let slug = base;
  let n = 0;
  for (;;) {
    const params: unknown[] = [slug];
    let sql = "SELECT id FROM organizations WHERE slug = $1";
    if (excludeId) {
      sql += " AND id <> $2";
      params.push(excludeId);
    }
    const clash = await query<{ id: string }>(sql, params);
    if (!clash.rows[0]) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

async function ensureUniqueStudentCode(slug: string): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = generateStudentJoinCode(slug);
    const clash = await query("SELECT id FROM organizations WHERE student_join_code = $1", [code]);
    if (!clash.rows[0]) return code;
  }
  throw HttpError.badRequest("Could not generate unique student join code");
}

async function ensureUniqueTeacherCode(slug: string): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = generateTeacherJoinCode(slug);
    const clash = await query("SELECT id FROM organizations WHERE teacher_join_code = $1", [code]);
    if (!clash.rows[0]) return code;
  }
  throw HttpError.badRequest("Could not generate unique teacher join code");
}

async function resolveOrgAdminUser(
  orgAdmin: z.infer<typeof orgAdminSchema>,
): Promise<string | null> {
  if (!orgAdmin) return null;

  if (orgAdmin.existing_user_id) {
    const user = await query<{ id: string }>("SELECT id FROM users WHERE id = $1", [
      orgAdmin.existing_user_id,
    ]);
    if (!user.rows[0]) throw HttpError.badRequest("Existing user not found");
    return user.rows[0].id;
  }

  if (orgAdmin.email && orgAdmin.password) {
    const existing = await query<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = lower($1)",
      [orgAdmin.email],
    );
    if (existing.rows[0]) {
      throw HttpError.conflict("Email already registered — use existing user ID instead");
    }

    const password_hash = await hashPassword(orgAdmin.password);
    const inserted = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, name, role, status)
       VALUES ($1, $2, $3, $3, 'teacher', 'active')
       RETURNING id`,
      [
        orgAdmin.email.toLowerCase(),
        password_hash,
        orgAdmin.full_name ?? orgAdmin.email.split("@")[0],
      ],
    );
    return inserted.rows[0]!.id;
  }

  throw HttpError.badRequest(
    "org_admin requires existing_user_id or email + password",
  );
}

// GET /admin/organizations
router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await query(
      `SELECT o.*,
              (SELECT COUNT(*)::int FROM organization_members om WHERE om.organization_id = o.id) AS member_count,
              (SELECT COUNT(*)::int FROM courses c WHERE c.organization_id = o.id) AS course_count,
              (SELECT u.email FROM organization_members om
                 JOIN users u ON u.id = om.user_id
                WHERE om.organization_id = o.id AND om.role = 'owner'
                ORDER BY om.joined_at LIMIT 1) AS owner_email
         FROM organizations o
        ORDER BY o.created_at DESC`,
    );
    res.json({ organizations: result.rows });
  }),
);

// GET /admin/organizations/:id
router.get(
  "/:id",
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const org = await query("SELECT * FROM organizations WHERE id = $1", [id]);
    if (!org.rows[0]) throw HttpError.notFound("Organization not found");

    const members = await query(
      `SELECT om.id, om.role, om.joined_at, u.id AS user_id, u.email, u.full_name, u.name,
              u.role AS platform_role, u.status
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
        WHERE om.organization_id = $1
        ORDER BY om.role, u.email`,
      [id],
    );

    const member_count = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM organization_members WHERE organization_id = $1",
      [id],
    );

    res.json({
      organization: org.rows[0],
      members: members.rows,
      member_count: Number(member_count.rows[0]?.count ?? 0),
    });
  }),
);

// POST /admin/organizations
router.post(
  "/",
  validate(createOrgSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = createOrgSchema.parse(req.body);
    const baseSlug = body.slug ?? slugifyName(body.name);
    const slug = await ensureUniqueSlug(baseSlug);
    const teacherJoinCode = await ensureUniqueTeacherCode(slug);
    const studentJoinCode = await ensureUniqueStudentCode(slug);

    const orgAdminUserId = await resolveOrgAdminUser(body.org_admin);
    const orgAdminRole = body.org_admin?.role ?? ORG_MEMBER_ROLES.OWNER;

    const organization = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO organizations
           (name, slug, description, website, industry, logo, status, teacher_join_code, student_join_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          body.name,
          slug,
          body.description ?? null,
          body.website || null,
          body.industry ?? null,
          body.logo || null,
          body.status ?? "pending",
          teacherJoinCode,
          studentJoinCode,
        ],
      );
      const org = inserted.rows[0];

      if (orgAdminUserId) {
        await client.query(
          `INSERT INTO organization_members (organization_id, user_id, role)
           VALUES ($1, $2, $3)`,
          [org.id, orgAdminUserId, orgAdminRole],
        );
      }

      return org;
    });

    res.status(201).json({
      organization,
      teacher_join_code: organization.teacher_join_code,
      org_admin_assigned: Boolean(orgAdminUserId),
    });
  }),
);

// PATCH /admin/organizations/:id
router.patch(
  "/:id",
  validate(idParam, "params"),
  validate(updateOrgSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const body = updateOrgSchema.parse(req.body);

    if (body.slug) {
      body.slug = await ensureUniqueSlug(body.slug, id);
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      if (v === "") values.push(null);
      else values.push(v);
    }
    if (fields.length === 0) throw HttpError.badRequest("No fields to update");
    values.push(id);

    const result = await query(
      `UPDATE organizations SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values,
    );
    if (!result.rows[0]) throw HttpError.notFound("Organization not found");
    res.json({ organization: result.rows[0] });
  }),
);

// POST /admin/organizations/:id/logo
router.post(
  "/:id/logo",
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response, next) => {
    const { id } = idParam.parse(req.params);
    const org = await query("SELECT id FROM organizations WHERE id = $1", [id]);
    if (!org.rows[0]) throw HttpError.notFound("Organization not found");

    handleOrgLogoUpload(id)(req, res, async (err) => {
      if (err) return next(err);
      try {
        const logo = orgLogoPublicPath(id, req.file!.filename);
        const updated = await query(
          "UPDATE organizations SET logo = $1 WHERE id = $2 RETURNING logo",
          [logo, id],
        );
        res.json({ logo: updated.rows[0]?.logo });
      } catch (e) {
        next(e);
      }
    });
  }),
);

// POST /admin/organizations/:id/regenerate-teacher-code
router.post(
  "/:id/regenerate-teacher-code",
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const orgRow = await query<{ slug: string }>("SELECT slug FROM organizations WHERE id = $1", [
      id,
    ]);
    const org = orgRow.rows[0];
    if (!org) throw HttpError.notFound("Organization not found");

    const code = await ensureUniqueTeacherCode(org.slug);
    const updated = await query(
      `UPDATE organizations SET teacher_join_code = $1 WHERE id = $2 RETURNING teacher_join_code`,
      [code, id],
    );
    res.json({ teacher_join_code: updated.rows[0]?.teacher_join_code });
  }),
);

// POST /admin/organizations/:id/regenerate-student-code
router.post(
  "/:id/regenerate-student-code",
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const orgRow = await query<{ slug: string }>("SELECT slug FROM organizations WHERE id = $1", [
      id,
    ]);
    const org = orgRow.rows[0];
    if (!org) throw HttpError.notFound("Organization not found");

    const code = await ensureUniqueStudentCode(org.slug);
    const updated = await query(
      `UPDATE organizations SET student_join_code = $1 WHERE id = $2 RETURNING student_join_code`,
      [code, id],
    );
    res.json({ student_join_code: updated.rows[0]?.student_join_code });
  }),
);

// POST /admin/organizations/:id/members
router.post(
  "/:id/members",
  validate(idParam, "params"),
  validate(addMemberSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const body = addMemberSchema.parse(req.body);

    const org = await query("SELECT id FROM organizations WHERE id = $1", [id]);
    if (!org.rows[0]) throw HttpError.notFound("Organization not found");

    const userResult = await query<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = lower($1)",
      [body.email],
    );
    const targetUser = userResult.rows[0];
    if (!targetUser) {
      throw HttpError.badRequest("No user with that email. They must register first.");
    }

    const existing = await query(
      "SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2",
      [id, targetUser.id],
    );
    if (!existing.rows[0]) {
      await assertOrgMemberCapacity(id);
    }

    const inserted = await query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING id, role, joined_at`,
      [id, targetUser.id, body.role],
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

// PATCH /admin/organizations/:id/members/:memberId
router.patch(
  "/:id/members/:memberId",
  validate(memberIdParam, "params"),
  validate(updateMemberSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id, memberId } = memberIdParam.parse(req.params);
    const body = updateMemberSchema.parse(req.body);

    const existing = await query<{ id: string; role: OrgMemberRole }>(
      `SELECT id, role FROM organization_members WHERE id = $1 AND organization_id = $2`,
      [memberId, id],
    );
    const member = existing.rows[0];
    if (!member) throw HttpError.notFound("Member not found");

    if (body.role && body.role !== member.role && member.role === "owner") {
      const owners = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM organization_members
         WHERE organization_id = $1 AND role = 'owner'`,
        [id],
      );
      if (Number(owners.rows[0]?.count ?? 0) <= 1) {
        throw HttpError.badRequest("Cannot change role of the only organization owner");
      }
    }

    if (body.role) {
      await query(`UPDATE organization_members SET role = $1 WHERE id = $2`, [body.role, memberId]);
    }

    res.json({ ok: true });
  }),
);

// DELETE /admin/organizations/:id/members/:memberId
router.delete(
  "/:id/members/:memberId",
  validate(memberIdParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id, memberId } = memberIdParam.parse(req.params);

    const existing = await query<{ role: OrgMemberRole }>(
      `SELECT role FROM organization_members WHERE id = $1 AND organization_id = $2`,
      [memberId, id],
    );
    const member = existing.rows[0];
    if (!member) throw HttpError.notFound("Member not found");

    if (member.role === "owner") {
      const owners = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM organization_members
         WHERE organization_id = $1 AND role = 'owner'`,
        [id],
      );
      if (Number(owners.rows[0]?.count ?? 0) <= 1) {
        throw HttpError.badRequest("Cannot remove the only organization owner");
      }
    }

    await query("DELETE FROM organization_members WHERE id = $1", [memberId]);
    res.json({ ok: true });
  }),
);

export default router;
