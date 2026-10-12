"use client";
import { FormEvent, useState } from "react";
import { editorialRequest } from "./editorial-desk";
export function MatchVerification({ candidateId, currentDate, earlierDate, onVerified }: { candidateId: string; currentDate?: string; earlierDate?: string; onVerified: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setMessage("");
    try {
      await editorialRequest(`candidates/${candidateId}/verify`, {
        source_url: data.get("source"), publisher: data.get("publisher"), source_grade: data.get("grade"), notes: data.get("notes"),
        current_event_date: data.get("current"), earlier_event_date: data.get("earlier"),
        identity_confirmed: data.get("identity") === "on", distinct_photo_and_event: data.get("distinct") === "on", rights_confirmed: data.get("rights") === "on",
      });
      setMessage("Evidence saved. You can now record your approval decision."); onVerified();
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  return <details className="match-verification"><summary>Verify this outfit match</summary><p>Compare the garment construction, neckline, print, embroidery and silhouette. A shared designer or colour alone is not enough. Record a source supporting your conclusion.</p>
    <form onSubmit={verify}>
      <label>Supporting source URL<input type="url" name="source" placeholder="https://…" required /></label>
      <div className="edition-field-row"><label>Source / publisher<input name="publisher" required minLength={2} maxLength={200}/></label><label>Source type<select name="grade"><option value="A">Designer or first-hand source</option><option value="B">Reliable editorial reporting</option></select></label></div>
      <div className="edition-field-row"><label>Current appearance date<input type="date" name="current" defaultValue={currentDate || ""} required/></label><label>Earlier appearance date<input type="date" name="earlier" defaultValue={earlierDate || ""} required/></label></div>
      <label>What confirms the match?<textarea name="notes" required minLength={12} maxLength={3000} placeholder="Describe the distinctive matching details and designer attribution."/></label>
      <label className="edition-check"><input name="identity" type="checkbox" required/><span>I checked the garment details and designer attribution.</span></label>
      <label className="edition-check"><input name="distinct" type="checkbox" required/><span>These are distinct photographs from distinct appearances.</span></label>
      <label className="edition-check"><input name="rights" type="checkbox"/><span>I have also confirmed permission to use the historical photograph.</span></label>
      <button type="submit" className="primary" disabled={busy}>{busy ? "Saving evidence…" : "Record verification"}</button>
      {message && <p role="status">{message}</p>}
    </form>
  </details>;
}
