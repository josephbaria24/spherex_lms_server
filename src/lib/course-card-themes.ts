export const COURSE_CARD_THEMES = [
  "coral",
  "sunflower",
  "sage",
  "mint",
  "sky",
  "lilac",
] as const;

export type CourseCardTheme = (typeof COURSE_CARD_THEMES)[number];

export const DEFAULT_COURSE_CARD_THEME: CourseCardTheme = "sage";
