"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { StudioBrand } from "@/components/studio-brand";
import { loginDestination } from "@/lib/editorial-flow";

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    fetch("/api/auth/session").then(async response => {
      if (response.ok) router.replace(loginDestination((await response.json()).username));
    }).catch(() => { /* Login remains available if the session check fails. */ });
  }, [router]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    const fields = new FormData(event.currentTarget);
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: fields.get("username"), password: fields.get("password") }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await response.json();
      if (!response.ok) return setError(data.detail || "The studio could not be opened. Please try again.");
      router.replace(loginDestination(data.username));
    } catch {
      setError("The studio could not be reached. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-shell" id="main-content" tabIndex={-1}>
      <img className="auth-editorial-image" src="/images/editorial-atelier.webp" alt="" fetchPriority="high" width="1122" height="1402"/>
      <header className="auth-masthead">
        <StudioBrand />
        <span className="auth-access">Your editorial playground</span>
      </header>
      <div className="auth-layout">
        <section className="auth-visual" aria-label="The editorial perspective">
          <span className="auth-image-label">The art of a considered edit</span>
          <div className="auth-visual-copy">
            <span className="auth-kicker">Fashion, with perspective</span>
            <h1>An eye for style.<br/><em>A point of view.</em></h1>
            <svg className="auth-flourish" viewBox="0 0 220 28" fill="none" aria-hidden="true"><path d="M8 14h74c12 0 14-10 6-10-8 0-6 10 6 10h10m108 0h-74c-12 0-14-10-6-10 8 0 6 10-6 10h-10M94 14c-12 0-14 10-6 10m38-10c12 0 14 10 6 10" stroke="currentColor" strokeWidth="1"/><path d="m110 9 5 5-5 5-5-5Z" fill="currentColor"/></svg>
            <p>The looks, the details, and the stories worth telling.</p>
            <div className="auth-manifesto"><span>Look closer. Tell it better.</span><p>Because the best stories begin with a discerning eye.</p></div>
          </div>
        </section>
        <section className="auth-panel" aria-labelledby="sign-in-heading">
        <form className="auth-form" onSubmit={login} aria-busy={loading}>
          <header className="auth-form-header">
            <span className="auth-kicker">Your editorial workspace</span>
            <h2 id="sign-in-heading">Welcome to<br/>the studio.</h2>
            <p>Spot the look. Shape the story. Make it yours.</p>
          </header>

          {error && <div className="auth-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}

          <div className="auth-fields">
            <div className="auth-field">
              <label htmlFor="editor-username">Username</label>
              <div className="auth-input-shell"><input id="editor-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={120} required disabled={loading} /></div>
            </div>
            <div className="auth-field">
              <label htmlFor="editor-password">Password</label>
              <div className="auth-input-shell"><input id="editor-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" maxLength={256} required disabled={loading} /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button></div>
            </div>
          </div>

          <button className="auth-submit" disabled={loading}>
            {loading ? "Opening your studio…" : "Unleash your editorial eye"}
            <span aria-hidden="true">&rarr;</span>
          </button>
          <p className="auth-form-footnote"><strong>Your perspective makes the difference.</strong>Sign in to your editorial workspace. Connect to WordPress when your draft is ready.</p>
        </form>
      </section>
      </div>
      <footer className="auth-footer"><span>High Heel Confidential</span><span>Independent perspective. Every day.</span></footer>
    </main>
  );
}
