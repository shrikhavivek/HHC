"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { StudioBrand } from "@/components/studio-brand";

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [applicationPassword, setApplicationPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    fetch("/api/auth/session").then(response => {
      if (response.ok) router.replace("/dashboard");
    }).catch(() => { /* Login remains available if the session check fails. */ });
  }, [router]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, applicationPassword }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await response.json();
      if (!response.ok) return setError(data.detail || "Sign-in failed. Please try again.");
      router.replace("/dashboard");
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
        <span className="auth-access"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>Private editor access</span>
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
            <p>Sign in to curate the next edit.</p>
          </header>

          <div className="auth-fields">
            <div className="auth-field">
              <label htmlFor="username">Username</label>
              <div className="auth-input-shell">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg>
                <input id="username" name="username" required autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={120} placeholder="Your editor username" value={username} onChange={event => setUsername(event.target.value)} />
              </div>
            </div>

            <div className="auth-field">
              <label htmlFor="applicationPassword">Password</label>
              <div className="auth-input-shell">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
                <input id="applicationPassword" name="applicationPassword" required maxLength={256} type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="Your password" value={applicationPassword} onChange={event => setApplicationPassword(event.target.value)} onKeyUp={event => setCapsLock(event.getModifierState("CapsLock"))} onBlur={() => setCapsLock(false)} aria-describedby={capsLock ? "caps-lock-note" : undefined}/>
                <button type="button" onClick={() => setShowPassword(value => !value)} aria-controls="applicationPassword" aria-pressed={showPassword}>{showPassword ? "Hide" : "Show"}</button>
              </div>
            </div>
          </div>

          {capsLock && <p id="caps-lock-note" className="auth-helper" role="status">Caps Lock is on.</p>}

          {error && <div className="auth-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}

          <button className="auth-submit" disabled={loading}>
            {loading ? "Signing in..." : "Enter the studio"}
            <span aria-hidden="true">&rarr;</span>
          </button>
          <p className="auth-form-footnote"><strong>Your perspective makes the difference.</strong>Private access for the High Heel Confidential editorial team.</p>
        </form>
      </section>
      </div>
      <footer className="auth-footer"><span>High Heel Confidential</span><span>Independent perspective. Every day.</span></footer>
    </main>
  );
}
