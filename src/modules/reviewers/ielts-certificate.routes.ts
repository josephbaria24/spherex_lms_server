import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import {
  buildIeltsCertificatePdf,
  getIeltsCertificate,
  issueIeltsCertificate,
  listIeltsLearnersProgress,
  loadIeltsProgress,
} from "../../lib/ielts-certificate.js";

const router = Router();

const learnersQuery = z.object({
  search: z.string().optional(),
});

// GET /reviewers/ielts/learners — admin progress monitor
router.get(
  "/ielts/learners",
  requireAuth,
  requireAdmin,
  validate(learnersQuery, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const { search } = learnersQuery.parse(req.query);
    const data = await listIeltsLearnersProgress(search);
    res.json(data);
  }),
);

router.get(
  "/ielts/certificate",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.sub;
    const tests = await loadIeltsProgress(userId);
    const passed = tests.filter((test) => test.passed).length;
    const certificate = await getIeltsCertificate(userId);
    res.json({
      total: tests.length,
      passed,
      eligible: tests.length > 0 && passed === tests.length,
      tests,
      certificate: certificate
        ? {
            id: certificate.id,
            serial_number: certificate.serial_number,
            issued_at: certificate.issued_at,
            holder_name: certificate.holder_name,
            results: certificate.results,
          }
        : null,
    });
  }),
);

router.post(
  "/ielts/certificate",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const certificate = await issueIeltsCertificate(req.user!.sub);
    res.status(201).json({
      certificate: {
        id: certificate.id,
        serial_number: certificate.serial_number,
        issued_at: certificate.issued_at,
        holder_name: certificate.holder_name,
        results: certificate.results,
      },
    });
  }),
);

router.get(
  "/ielts/certificate/pdf",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const certificate = await getIeltsCertificate(req.user!.sub);
    if (!certificate) {
      res.status(404).json({ error: "Certificate not issued yet." });
      return;
    }
    const pdf = await buildIeltsCertificatePdf(certificate);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${certificate.serial_number}.pdf"`,
    );
    res.send(pdf);
  }),
);

export default router;
