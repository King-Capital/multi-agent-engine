/**
 * FilesView — lists files changed in a session with folder grouping,
 * file-type icons, and diff stat badges.
 * Fetches /api/pg/sessions/:id/diff (normalised to DiffFile[]).
 */

import * as React from "react";
import {
  FileText,
  FileCode,
  FileJson,
  File,
  FolderOpen,
  Image,
  Plus,
  Minus,
  RefreshCw,
  Trash2,
  CornerDownRight,
} from "lucide-react";
import type { DiffFile } from "@/lib/types";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

// ─── File icon by extension ───────────────────────────────────────────────────

function fileIcon(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, React.ReactNode> = {
    ts: <FileCode className="w-3.5 h-3.5 text-blue-400" />,
    tsx: <FileCode className="w-3.5 h-3.5 text-blue-400" />,
    js: <FileCode className="w-3.5 h-3.5 text-yellow-400" />,
    jsx: <FileCode className="w-3.5 h-3.5 text-yellow-400" />,
    go: <FileCode className="w-3.5 h-3.5 text-cyan-400" />,
    py: <FileCode className="w-3.5 h-3.5 text-green-400" />,
    rs: <FileCode className="w-3.5 h-3.5 text-orange-400" />,
    json: <FileJson className="w-3.5 h-3.5 text-amber-400" />,
    yaml: <FileJson className="w-3.5 h-3.5 text-amber-300" />,
    yml: <FileJson className="w-3.5 h-3.5 text-amber-300" />,
    md: <FileText className="w-3.5 h-3.5 text-zinc-400" />,
    css: <FileCode className="w-3.5 h-3.5 text-pink-400" />,
    scss: <FileCode className="w-3.5 h-3.5 text-pink-400" />,
    html: <FileCode className="w-3.5 h-3.5 text-orange-400" />,
    png: <Image className="w-3.5 h-3.5 text-purple-400" />,
    jpg: <Image className="w-3.5 h-3.5 text-purple-400" />,
    svg: <Image className="w-3.5 h-3.5 text-purple-400" />,
  };
  return map[ext] ?? <File className="w-3.5 h-3.5 text-zinc-500" />;
}

function statusChip(status: DiffFile["status"]) {
  const conf: Record<
    DiffFile["status"],
    { label: string; cls: string; Icon: React.ElementType }
  > = {
    added: {
      label: "A",
      cls: "text-emerald-400 bg-emerald-500/10 border-emerald-900/40",
      Icon: Plus,
    },
    deleted: {
      label: "D",
      cls: "text-red-400 bg-red-500/10 border-red-900/40",
      Icon: Trash2,
    },
    renamed: {
      label: "R",
      cls: "text-blue-400 bg-blue-500/10 border-blue-900/40",
      Icon: CornerDownRight,
    },
    modified: {
      label: "M",
      cls: "text-amber-400 bg-amber-500/10 border-amber-900/40",
      Icon: RefreshCw,
    },
  };
  const { label, cls, Icon } = conf[status] ?? conf.modified;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded border px-1 py-0.5 text-[9px] font-bold uppercase",
        cls,
      )}
      title={status}
    >
      <Icon className="w-2.5 h-2.5" />
      {label}
    </span>
  );
}

// ─── Group files by directory ─────────────────────────────────────────────────

function groupByDirectory(files: DiffFile[]): Map<string, DiffFile[]> {
  const groups = new Map<string, DiffFile[]>();
  for (const f of files) {
    const parts = f.path.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(f);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// ─── File Row ─────────────────────────────────────────────────────────────────

function FileRow({ file }: { file: DiffFile }) {
  const name = file.path.split("/").pop() ?? file.path;
  return (
    <div className="flex items-center gap-2 py-1.5 px-3 rounded hover:bg-zinc-800/50 transition-colors group">
      {fileIcon(file.path)}
      <span
        className="flex-1 text-xs text-zinc-300 font-mono min-w-0 truncate"
        title={file.path}
      >
        {name}
        {file.old_path && (
          <span className="text-zinc-600 ml-1">
            ← {file.old_path.split("/").pop()}
          </span>
        )}
      </span>

      {/* Diff counters (only shown when API provides them) */}
      {(file.additions > 0 || file.deletions > 0) && (
        <div className="flex items-center gap-1.5 opacity-60 group-hover:opacity-100 text-[10px] font-mono">
          {file.additions > 0 && (
            <span className="text-emerald-400">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="text-red-400">−{file.deletions}</span>
          )}
        </div>
      )}

      {statusChip(file.status)}
    </div>
  );
}

// ─── Directory Group ──────────────────────────────────────────────────────────

function DirectoryGroup({ dir, files }: { dir: string; files: DiffFile[] }) {
  const [open, setOpen] = React.useState(true);
  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);

  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-zinc-800/40 rounded transition-colors"
      >
        <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
        <span className="text-xs text-zinc-400 font-mono flex-1 truncate">
          {dir}/
        </span>
        <span className="text-[10px] text-zinc-600">
          {files.length} file{files.length !== 1 ? "s" : ""}
        </span>
        {totalAdd > 0 && (
          <span className="text-[10px] text-emerald-500 font-mono">
            +{totalAdd}
          </span>
        )}
        {totalDel > 0 && (
          <span className="text-[10px] text-red-500 font-mono">
            −{totalDel}
          </span>
        )}
        <span
          className={cn(
            "text-zinc-600 text-[10px] ml-1 transition-transform duration-200 inline-block",
            open && "rotate-90",
          )}
        >
          ▶
        </span>
      </button>

      {open && (
        <div className="ml-3 border-l border-zinc-800 pl-2">
          {files.map((f) => (
            <FileRow key={f.path} file={f} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface FilesViewProps {
  sessionId: string;
}

export function FilesView({ sessionId }: FilesViewProps) {
  const [files, setFiles] = React.useState<DiffFile[]>([]);
  const [count, setCount] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .sessionDiff(sessionId)
      .then(({ files: f, count: c }) => {
        if (!cancelled) {
          setFiles(f);
          setCount(c);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-zinc-500 text-sm">
        Loading files…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-48 text-red-400 text-sm">
        {error}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-2 text-zinc-600 text-sm">
        <File className="w-8 h-8 text-zinc-700" />
        <p>No file changes recorded for this session</p>
      </div>
    );
  }

  const groups = groupByDirectory(files);
  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);

  return (
    <div className="space-y-2">
      {/* Summary bar */}
      <div className="flex items-center gap-4 px-3 py-2 bg-zinc-900 rounded-lg border border-zinc-800 text-xs">
        <span className="text-zinc-300 font-medium">
          {count || files.length} file{(count || files.length) !== 1 ? "s" : ""} changed
        </span>
        {totalAdd > 0 && (
          <span className="text-emerald-400 font-mono">+{totalAdd}</span>
        )}
        {totalDel > 0 && (
          <span className="text-red-400 font-mono">−{totalDel}</span>
        )}
        <span className="ml-auto text-zinc-600">
          {groups.size} director{groups.size !== 1 ? "ies" : "y"}
        </span>
        <span className="text-zinc-600">
          {files.filter((f) => f.status === "added").length} added
        </span>
        <span className="text-zinc-600">
          {files.filter((f) => f.status === "modified").length} modified
        </span>
        {files.filter((f) => f.status === "deleted").length > 0 && (
          <span className="text-zinc-600">
            {files.filter((f) => f.status === "deleted").length} deleted
          </span>
        )}
      </div>

      {/* File tree */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 py-1">
        {Array.from(groups.entries()).map(([dir, dirFiles]) => (
          <DirectoryGroup key={dir} dir={dir} files={dirFiles} />
        ))}
      </div>
    </div>
  );
}
