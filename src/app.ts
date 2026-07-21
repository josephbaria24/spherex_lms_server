import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { env, isProd } from "./config/env.js";
import { attachUser } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/error.js";
import { protectUploads } from "./middleware/protect-uploads.js";
import { authRateLimiter } from "./middleware/rateLimit.js";

import authRoutes from "./modules/auth/auth.routes.js";
import userRoutes from "./modules/users/users.routes.js";
import courseRoutes from "./modules/courses/courses.routes.js";
import enrollmentRoutes from "./modules/enrollments/enrollments.routes.js";
import materialRoutes from "./modules/materials/materials.routes.js";
import certificateRoutes from "./modules/certificates/certificates.routes.js";
import trainingRoutes from "./modules/training/training.routes.js";
import bunnyRoutes from "./modules/bunny/bunny.routes.js";
import teacherRoutes from "./modules/teacher/teacher.routes.js";
import organizationRoutes from "./modules/organizations/organizations.routes.js";
import orgAdminRoutes from "./modules/org-admin/org-admin.routes.js";
import adminOrganizationsRoutes from "./modules/admin/admin-organizations.routes.js";
import adminDashboardRoutes from "./modules/admin/admin-dashboard.routes.js";
import learnRoutes from "./modules/learn/learn.routes.js";
import paymentRequestRoutes from "./modules/payment-requests/payment-requests.routes.js";
import notificationRoutes from "./modules/notifications/notifications.routes.js";
import { initUploadsDirectory, getUploadsRoot } from "./lib/org-uploads.js";
import { initLessonUploadsDirectory } from "./lib/lesson-uploads.js";
import { initScormUploadsDirectory } from "./lib/scorm-uploads.js";
import { initCourseUploadsDirectory } from "./lib/course-uploads.js";
import { initReceiptUploadsDirectory } from "./lib/payment-requests.js";

export function createApp(): Express {
  const app = express();

  initUploadsDirectory();
  initLessonUploadsDirectory();
  initScormUploadsDirectory();
  initCourseUploadsDirectory();
  initReceiptUploadsDirectory();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.clientOrigin,
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(cookieParser());
  app.use(morgan(isProd ? "combined" : "dev"));

  app.use(attachUser);

  app.use(
    "/api/uploads",
    protectUploads,
    express.static(getUploadsRoot(), {
      index: false,
      fallthrough: true,
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true, env: env.nodeEnv });
  });

  app.use("/api/auth", authRateLimiter, authRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/courses", courseRoutes);
  app.use("/api/enrollments", enrollmentRoutes);
  app.use("/api/materials", materialRoutes);
  app.use("/api/certificates", certificateRoutes);
  app.use("/api/training", trainingRoutes);
  app.use("/api/teacher", teacherRoutes);
  app.use("/api/organizations", organizationRoutes);
  app.use("/api/org-admin", orgAdminRoutes);
  app.use("/api/admin", adminDashboardRoutes);
  app.use("/api/admin/organizations", adminOrganizationsRoutes);
  app.use("/api/learn", learnRoutes);
  app.use("/api/bunny", bunnyRoutes);
  app.use("/api/payment-requests", paymentRequestRoutes);
  app.use("/api/notifications", notificationRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
