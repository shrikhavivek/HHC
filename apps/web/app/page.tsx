"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [applicationPassword, setApplicationPassword] = useState("");

  useEffect(() => {
    fetch("/api/auth/session").then(response => { if (response.ok) router.replace("/dashboard"); });
  }, [router]);

  function useDemoAccess() {
    setUsername("hhc-demo");
    setApplicationPassword("HHC-Demo-2026!");
    setError("");
  }

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

  return <main className="login-shell">
    <section className="login-visual">
      <div className="login-brand"><span>HHC</span><div><strong>High Heel Confidential</strong><small>Outfit intelligence</small></div></div>
      <div className="visual-copy"><span className="login-kicker">Private editorial workspace</span><h1>Find the look.<br/><em>Trace its story.</em></h1><p>Daily Bollywood fashion research, exact-match evidence and editor-approved collages in one beautifully guarded desk.</p></div>
      <div className="look-stack"><div className="look-photo first"><img src="/media/static/look-1.png" alt="Current editorial look study"/><span>Today · Mumbai</span></div><div className="look-photo second"><img src="/media/static/look-2.png" alt="Historical editorial look study"/><span>Archive · 2023</span></div><div className="match-orbit"><b>94%</b><small>candidate</small></div></div>
      <footer>Editorial evidence, not automated claims.</footer>
    </section>
    <section className="login-panel">
      <form className="login-form" onSubmit={login}>
        <div className="login-lock">✦</div><span className="login-kicker dark">WordPress identity</span><h2>Welcome back</h2><p>Sign in to open today’s private collage and outfit-research desk.</p>
        <div className="demo-access"><div><small>Temporary demo access</small><strong>Explore every workspace now</strong><span>Uses a local demonstration account. Replace it with WordPress access in version 2.</span></div><button type="button" onClick={useDemoAccess}>Use demo access</button></div>
        <label>WordPress username<input name="username" required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} placeholder="Your username"/></label>
        <label>Application Password<input name="applicationPassword" required type="password" autoComplete="current-password" value={applicationPassword} onChange={event => setApplicationPassword(event.target.value)} placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"/></label>
        {error && <div className="login-error">{error}</div>}
        <button className="login-submit" disabled={loading}>{loading ? "Verifying securely…" : "Enter research desk"}<span>→</span></button>
        <div className="login-security"><b>Credentials are never stored.</b><span>For production, use WordPress → Users → Profile → Application Passwords. Do not enter a normal account password.</span></div>
      </form>
    </section>
  </main>;
}
