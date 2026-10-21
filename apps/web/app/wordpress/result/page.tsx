import Link from "next/link";
import { StudioBrand } from "@/components/studio-brand";

const messages: Record<string, string> = {
  cancelled: "WordPress sign-in was cancelled. Your saved story and collage are still in the studio.",
  expired: "This sign-in link expired or has already been used. Return to the studio to continue.",
  invalid: "WordPress could not confirm this connection. Return to your saved story and try again.",
  review: "The story changed, or an earlier handoff needs checking. Return to the studio, review the saved story, and use Check previous handoff if shown.",
  failed: "WordPress could not confirm the draft. Your local story is saved. Return to the studio and check the previous handoff before sending again.",
};
export default async function WordPressResult({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  return <main className="auth-shell"><header className="auth-masthead"><StudioBrand /></header><div className="auth-layout"><section className="auth-panel"><div className="auth-form"><header className="auth-form-header"><span className="auth-kicker">Your editorial workspace</span><h1>Your edit is saved.</h1><p>{messages[status || ""] || messages.failed}</p></header><Link className="auth-submit" href="/dashboard">Back to the studio →</Link></div></section></div></main>;
}
