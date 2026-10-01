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
            <h1>The daily edit.<br /><em>Distinctly HHC.</em></h1>
            <p>A private space for the High Heel Confidential editorial team.</p>
          </div>

          <div className="login-emblem" aria-hidden="true">
            <div className="login-emblem-ring">
              <span>HHC</span>
              <small>Private edition</small>
            </div>
            <i className="login-emblem-line line-one" />
            <i className="login-emblem-line line-two" />
          </div>
        </div>

        <footer className="login-visual-footer"><span aria-hidden="true" /> High Heel Confidential · Private access</footer>
      </section>

      <section className="login-panel">
        <span className="login-panel-mark">Private access</span>
        <form className="login-form" onSubmit={login}>
          <header className="login-form-header">
            <div className="login-lock" aria-hidden="true">H</div>
            <span className="login-kicker dark">Member sign in</span>
            <h2>Welcome back</h2>
            <p>Sign in to continue to your private workspace.</p>
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
            {loading ? "Signing in..." : "Sign in"}
            <span aria-hidden="true">&rarr;</span>
          </button>
          <small className="login-form-footnote">Authorized access only</small>
        </form>
      </section>
    </main>
  );
}
