import "dotenv/config";

function required(name: string, value: string | undefined): string {
  if (!value || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

export const env = {
  nodeEnv: optional(process.env.NODE_ENV, "development"),
  port: parseInt(optional(process.env.PORT, "4000"), 10),

  databaseUrl: required("DATABASE_URL", process.env.DATABASE_URL),

  jwt: {
    secret: required("JWT_SECRET", process.env.JWT_SECRET),
    expiresIn: optional(process.env.JWT_EXPIRES_IN, "7d"),
  },

  cookie: {
    name: optional(process.env.COOKIE_NAME, "spherex_session"),
    domain: process.env.COOKIE_DOMAIN || undefined,
    secure: optional(process.env.COOKIE_SECURE, "false") === "true",
  },

  clientOrigin: optional(process.env.CLIENT_ORIGIN, "http://localhost:3000"),

  uploadsDir: optional(process.env.UPLOADS_DIR, "uploads"),

  bunny: {
    storageZone: process.env.BUNNY_STORAGE_ZONE ?? "",
    storagePassword: process.env.BUNNY_STORAGE_PASSWORD ?? "",
    storageRegion: optional(process.env.BUNNY_STORAGE_REGION, "sg"),
    pullZone: process.env.BUNNY_PULL_ZONE ?? "",
    securityKey: process.env.BUNNY_SECURITY_KEY ?? "",
  },
} as const;

export const isProd = env.nodeEnv === "production";
