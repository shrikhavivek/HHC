"use client";
import { FormEvent, useState } from "react";
import { editorialRequest } from "./editorial-desk";
type ContextCase = { id: string; title: string; celebrity: string; designer: string; event_name: string; event_date?: string; context_revision?: number };
export function OutfitContext({ selected, onSaved }: { selected: ContextCase; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    const fields = new FormData(event.currentTarget);
    try {
      await editorialRequest(`cases/${selected.id}/context`, { ...Object.fromEntries(fields.entries()), event_date: fields.get("event_date") || null, expected_revision: selected.context_revision || 0 });
      setMessage("Attribution updated. Re-render the collage and review its sources again."); onSaved();
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  return <details className="match-verification"><summary>Correct the person, designer or event</summary><form key={selected.context_revision || 0} onSubmit={save}>
    <div className="edition-field-row"><label>Person<input name="celebrity" defaultValue={selected.celebrity} required maxLength={180}/></label><label>Designer<input name="designer" defaultValue={selected.designer} required maxLength={180}/></label></div>
    <label>Research title<input name="title" defaultValue={selected.title} required maxLength={500}/></label>
    <div className="edition-field-row"><label>Event<input name="event_name" defaultValue={selected.event_name} maxLength={240}/></label><label>Appearance date<input name="event_date" type="date" defaultValue={selected.event_date || ""}/></label></div>
    <button type="submit" className="primary" disabled={busy}>Save attribution</button>{message && <p role="status">{message}</p>}
  </form></details>;
}
