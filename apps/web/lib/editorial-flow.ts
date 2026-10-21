export type StudioStep = "collage" | "story" | "review";
export const validCaseId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export function storyDestination(caseId: string, step: StudioStep = "story") {
  return validCaseId(caseId) ? `/dashboard?case=${encodeURIComponent(caseId)}&step=${step}` : "/dashboard";
}
export function rememberStory(username: string, caseId: string, step: StudioStep) {
  try { sessionStorage.setItem(`hhc:resume:${username}`, JSON.stringify({ caseId, step })); } catch { /* The server draft still works without browser storage. */ }
}
export function readResume(username: string): { caseId: string; step: StudioStep } | null {
  try {
    const data = JSON.parse(sessionStorage.getItem(`hhc:resume:${username}`) || "null");
    return validCaseId(data?.caseId) && ["collage", "story", "review"].includes(data.step) ? data : null;
  } catch { return null; }
}
export function loginDestination(username: string) {
  const next = new URLSearchParams(window.location.search).get("next");
  if (next) {
    const url = new URL(next, window.location.origin);
    const id = url.searchParams.get("case");
    if (url.origin === window.location.origin && url.pathname === "/dashboard" && validCaseId(id)) return storyDestination(id, url.searchParams.get("step") === "review" ? "review" : "story");
  }
  const resume = readResume(username);
  return resume ? storyDestination(resume.caseId, resume.step) : "/dashboard";
}
