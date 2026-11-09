/**
 * iSpring often visits every slide and writes rich suspend_data without ever
 * setting cmi.core.lesson_status to completed. Detect the "reached the end"
 * bookmark so the LMS can finish the lesson.
 */
export function ispringSuspendIndicatesFinished(
  suspendData: string | null | undefined,
): boolean {
  if (!suspendData?.trim()) return false
  try {
    const data = JSON.parse(suspendData) as {
      l?: unknown
      v?: unknown
      V?: unknown
      p?: { lastViewedSlide?: unknown }
    }
    const lastIndex = typeof data.l === "number" ? data.l : null
    const lastViewed = data.p?.lastViewedSlide
    if (typeof lastIndex !== "number" || lastIndex < 0) return false
    if (typeof lastViewed !== "number" || lastViewed < lastIndex) return false

    const visitedRaw = Array.isArray(data.V)
      ? data.V
      : Array.isArray(data.v)
        ? data.v
        : []
    const visited = new Set(
      visitedRaw.filter((item): item is number => typeof item === "number"),
    )
    if (visited.size < lastIndex + 1) return false
    for (let i = 0; i <= lastIndex; i++) {
      if (!visited.has(i)) return false
    }
    return true
  } catch {
    return false
  }
}
