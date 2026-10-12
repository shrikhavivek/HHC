"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [applicationPassword, setApplicationPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session").then(response => {
      if (response.ok) router.replace("/dashboard");
    });
  }, [router]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, applicationPassword }),
    });
    const data = await response.json();
    setLoading(false);
    if (!response.ok) return setError(data.detail || "Login failed.");
    router.push("/dashboard");
  }

  return (
    <main className="login-shell login-shell-refined">
      <section className="login-visual">
        <div className="login-brand">
          <span>HHC</span>
          <div>
            <strong>High Heel Confidential</strong>
            <small>Private editorial studio</small>
          </div>
        </div>

        <div className="login-visual-body login-visual-body-refined">
          <div className="visual-copy">
            <span className="login-kicker">High Heel Confidential</span>
            <h1>Good looks.<br /><em>Great stories.</em></h1>
            <p>A little fashion. A lot of perspective. Your next great edit starts here.</p>
            <div className="atelier-tags"><span>The looks</span><span>The details</span><span>The conversation</span></div>
          </div>

          <div className="atelier-art" aria-hidden="true">
            <div className="atelier-swatch"><span>THE PALETTE</span><i/><i/><i/></div>
            <div className="atelier-cover"><small>HIGH HEEL CONFIDENTIAL</small><strong>The<br/><em>style</em><br/>files.</strong><svg viewBox="0 0 220 200" fill="none"><path d="M33 135c24-6 44-27 58-57l25-39c5 29 17 56 43 72l27 16c14 8 10 23-7 23H76c-19 0-34-4-43-15Z" fill="currentColor"/><path d="m147 149 11 38h7l6-38M89 78l27-39" stroke="currentColor" strokeWidth="5"/><path d="M39 136c34 13 91 9 146 6" stroke="#f9d9dd" strokeWidth="2"/></svg><span>AN EYE FOR THE DETAILS.</span></div>
            <div className="atelier-sticker">Always<br/><em>in style.</em><span>✦</span></div>
          </div>
        </div>

        <footer className="login-visual-footer"><span aria-hidden="true" /> High Heel Confidential · Private access</footer>
      </section>

      <section className="login-panel">
        <span className="login-panel-mark">Private access</span>
        <form className="login-form" onSubmit={login}>
          <header className="login-form-header">
            <div className="login-lock" aria-hidden="true">H</div>
            <span className="login-kicker dark">Your editorial escape</span>
            <h2>Hello, editor.</h2>
            <p>The looks are waiting. Let’s make an edit.</p>
          </header>

          <div className="login-fields">
            <div className="login-field">
              <label htmlFor="username">Username</label>
              <div className="login-input-shell">
                <input id="username" name="username" required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} />
              </div>
            </div>

            <div className="login-field">
              <label htmlFor="applicationPassword">Password</label>
              <div className="login-input-shell has-action">
                <input id="applicationPassword" name="applicationPassword" required type={showPassword ? "text" : "password"} autoComplete="current-password" value={applicationPassword} onChange={event => setApplicationPassword(event.target.value)} />
                <button type="button" onClick={() => setShowPassword(value => !value)} aria-pressed={showPassword}>{showPassword ? "Hide" : "Show"}</button>
              </div>
            </div>
          </div>

          {error && <div className="login-error" role="alert">{error}</div>}

          <button className="login-submit" disabled={loading}>
            {loading ? "Signing in..." : "Enter the studio"}
            <span aria-hidden="true">&rarr;</span>
          </button>
          <small className="login-form-footnote">Authorized access only</small>
        </form>
      </section>
    </main>
  );
}
