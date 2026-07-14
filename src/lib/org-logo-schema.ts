import { z } from "zod";

export const logoAppearanceSchema = {
  logo_padding: z.number().int().min(0).max(24).optional(),
  logo_position_x: z.number().int().min(0).max(100).optional(),
  logo_position_y: z.number().int().min(0).max(100).optional(),
};
