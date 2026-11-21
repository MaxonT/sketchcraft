import { useLocale } from "./locale";
// File › Restore from backup…: the model's earlier copies, newest first. Restoring is one undo step
// (and the model it replaces is kept as a backup first); "Save a copy" leaves the model alone and puts the
// old version in a Restored folder beside it. Work SketchCraft set aside (a plugin run another program cut
// across, a model file it couldn't read) is listed here too.

import { useEffect, useState } from "react";
import { exec, type Reply } from "./engine";
import { ago, bytes, cleanItems, type Item } from "./restoreclean";
import { Sheet } from "./sheet";

type Run = (cmd: Record<string, unknown>) => Promise<Reply>;

export function RestoreDialog({ run, onClose, onToast }: { run: Run; onClose: () => void; onToast: (t: string, bad?: boolean) => void }) {
  const { t } = useLocale();
  const [items, setItems] = useState<Item[] | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    exec({ cmd: "list_backups" }).then(
      (r) => {
        if (!live) return;
        if (r.ok) setItems(cleanItems(r.items));
        else setProblem(String(r.error ?? "Couldn't list the backups"));
      },
      (e) => live && setProblem(String(e))
    );
    return () => {
      live = false;
    };
  }, []);

  const act = async (it: Item, mode: "replace" | "copy") => {
    setBusy(`${it.kind}:${it.name}:${mode}`);
    try {
      const r = await run({ cmd: "restore_backup", kind: it.kind, name: it.name, mode });
      if (!r.ok) return;
      if (mode === "replace") {
        onToast("Restored. Undo (⌘Z) takes it back; the model it replaced is in the backups.");
        onClose();
      } else {
        const p = String(r.path ?? "");
        onToast(`Saved a copy: ${p.split("/").pop()}. It's in the Restored folder beside your model; File › Open… opens it.`);
        await exec({ cmd: "reveal", path: p });
      }
    } finally {
      setBusy(null);
    }
  };

  const backups = (items ?? []).filter((i) => i.kind === "backup");
  const aside = (items ?? []).filter((i) => i.kind !== "backup");
  const row = (it: Item) => {
    const d = new Date(it.secs * 1000);
    return (
      <li key={`${it.kind}:${it.name}`} className="restore-row">
        <span className="restore-when">
          <b>{ago(it.secs)}</b>
          <span className="muted small">{d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
        </span>
        <span className="restore-what">{it.label}</span>
        <span className="restore-size muted small" title={it.size > 100 * 1024 * 1024 ? "A big file: restoring it takes a few seconds and a lot of memory." : undefined}>{bytes(it.size)}{it.size > 100 * 1024 * 1024 ? " (big)" : ""}</span>
        <span className="restore-acts">
          <button className="btn small" disabled={busy !== null} onClick={() => act(it, "replace")} title="Replace the model with this version. One undo step.">
            {t("restore.restore")}
          </button>
          <button className="btn small" disabled={busy !== null} onClick={() => act(it, "copy")} title="Leave the model alone; put this version in a Restored folder beside it.">
            {t("restore.copy")}
          </button>
        </span>
      </li>
    );
  };
  return (
    <Sheet onClose={onClose} label={t("restore.title")} width={720}>
      <div className="sheet-head">
        <b>{t("restore.title")}</b>
        <span className="muted">{t("restore.versions")}</span>
        <button className="btn" style={{ marginLeft: "auto" }} onClick={onClose}>
          {t("restore.close")}
        </button>
      </div>
      {problem && <p className="muted">{problem}</p>}
      {!problem && items === null && <p className="muted">{t("restore.loading")}</p>}
      {items && backups.length === 0 && aside.length === 0 && <p className="muted">No backups yet. SketchCraft keeps one every few minutes while you work, and one before anything that removes a lot.</p>}
      {backups.length > 0 && <ul className="restore-list">{backups.map(row)}</ul>}
      {aside.length > 0 && (
        <>
          <h4 className="restore-sub">Work set aside</h4>
          <p className="muted small">Kept beside your model when another program saved over it, or the file couldn't be read.</p>
          <ul className="restore-list">{aside.map(row)}</ul>
        </>
      )}
      <p className="muted small">Restore replaces the model with that version as one step (⌘Z takes it back), and the model it replaces is kept in the backups first. Files over 768 MB are too big to restore here. A file marked “not verified” has the right kind of name but SketchCraft didn’t note making it (its note was lost); it is checked like any other file before it replaces anything.</p>
    </Sheet>
  );
}
