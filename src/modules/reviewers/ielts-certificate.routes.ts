import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  buildIeltsCertificatePdf,
  getIeltsCertificate,
  issueIeltsCertificate,
  loadIeltsProgress,
} from "../../lib/ielts-certificate.js";

const router = Router();

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
