"use client";
import { useEffect, useRef, useState } from "react";
import { StudioBrand } from "@/components/studio-brand";

export default function WordPressComplete() {
  const started = useRef(false);
  const [result, setResult] = useState<{ edit_url?: string; return_url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void fetch("/api/wordpress/complete", { method: "POST", signal: AbortSignal.timeout(220000) }).then(async response => {
      const data = await response.json();
      if (!response.ok) { setFailed(true); setResult({ return_url: data.return_url || "/wordpress/result?status=failed" }); return; }
      setResult(data);
    }).catch(() => { setFailed(true); setResult({ return_url: "/wordpress/result?status=failed" }); });
  }, []);
  return <main className="auth-shell"><header className="auth-masthead"><StudioBrand /></header><section className="wordpress-progress-card" aria-live="polite">
    <span className="auth-kicker">Your editorial workspace</span>
    <h1>{!result ? "Creating your draft…" : failed ? "Let’s check your draft" : "Your WordPress draft is ready."}</h1>
    <p>{!result ? "You’re signed in to WordPress. We’re sending your collage, story and credits. Keep this page open." : failed ? "WordPress hasn’t confirmed the result. Return to your story and check the previous handoff before sending again." : "Your collage and story are saved as a draft. Review and publish them in WordPress when you’re ready."}</p>
    {!result && <div className="edition-progress" role="progressbar" aria-label="Creating WordPress draft"/>}
    {result?.edit_url && <a className="auth-submit" href={result.edit_url} referrerPolicy="no-referrer">Open draft in WordPress ↗</a>}
    {result && <a className="wordpress-return-link" href={result.return_url}>{failed ? "Return to your story" : "Back to your story"}</a>}
  </section></main>;
}
