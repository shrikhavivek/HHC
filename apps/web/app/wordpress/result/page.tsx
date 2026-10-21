import Link from "next/link";
import { StudioBrand } from "@/components/studio-brand";
import { storyDestination, validCaseId } from "@/lib/editorial-flow";

const messages: Record<string, string> = {
  cancelled: "WordPress sign-in was cancelled. Your saved story and collage are still in the studio.",
  expired: "This sign-in link expired or has already been used. Return to the studio to continue.",
  invalid: "WordPress could not confirm this connection. Return to your saved story and try again.",
  review: "The story changed, or an earlier handoff needs checking. Return to the studio, review the saved story, and use Check previous handoff if shown.",
  failed: "WordPress could not confirm the draft. Your local story is saved. Return to the studio and check the previous handoff before sending again.",
};
export default async function WordPressResult({ searchParams }: { searchParams: Promise<{ status?: string; case?: string }> }) {
  const { status, case: caseId } = await searchParams;
  const destination = new URL(validCaseId(caseId) ? storyDestination(caseId, "review") : "/dashboard", process.env.APP_ORIGIN || "http://localhost:3100").href;
  return <main className="auth-shell"><header className="auth-masthead"><StudioBrand /></header><section className="wordpress-progress-card"><span className="auth-kicker">Your editorial workspace</span><h1>Your edit is saved.</h1><p>{messages[status || ""] || messages.failed}</p><Link className="auth-submit" href={destination}>Return to your story →</Link></section></main>;
}
