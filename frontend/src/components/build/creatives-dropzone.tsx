"use client";

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { BadgeCheck, Film, ImagePlus, Loader2, Trash2, Upload } from "lucide-react";
import { useSetBuild } from "@/components/build/use-build";
import { Button } from "@/components/ui/button";
import { apiFetch, type Asset, type Build } from "@/lib/api";
import { fmtBytes, IMAGE_TYPES, rejectReason, uploadAsset, VIDEO_TYPES } from "@/lib/upload";
import { cn } from "@/lib/utils";

interface UploadItem {
  key: string;
  name: string;
  size: number;
  progress: number; // 0..1
  error: string | null;
  done: boolean;
}

/** Drag-and-drop / file-picker uploads with per-file XHR progress, then a thumbnail grid. */
export function CreativesDropzone({ build, canEdit }: { build: Build; canEdit: boolean }) {
  const setBuild = useSetBuild(build.id);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);

  function patchUpload(key: string, patch: Partial<UploadItem>) {
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));
  }

  async function handleFiles(files: FileList | File[]) {
    if (!canEdit) return;
    const items: { file: File; item: UploadItem }[] = [];
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 7)}`;
      const reason = rejectReason(file);
      items.push({ file, item: { key, name: file.name, size: file.size, progress: 0, error: reason, done: !!reason } });
    }
    if (items.length === 0) return;
    setUploads((list) => [...list, ...items.map((i) => i.item)]);
    // Sequential so each file gets a truthful progress bar and the server isn't hammered.
    for (const { file, item } of items) {
      if (item.error) continue;
      try {
        const assets = await uploadAsset(build.id, file, (f) => patchUpload(item.key, { progress: f }));
        setBuild((b) => ({ ...b, assets }));
        patchUpload(item.key, { progress: 1, done: true });
        // Clear the finished row shortly after so the grid is the single source of truth.
        setTimeout(() => setUploads((list) => list.filter((u) => u.key !== item.key)), 1200);
      } catch (err) {
        patchUpload(item.key, { error: (err as Error).message.replace(/^\d{3}:\s*/, ""), done: true });
      }
    }
  }

  const remove = useMutation({
    mutationFn: (assetId: string) =>
      apiFetch<void>(`/api/builds/${encodeURIComponent(build.id)}/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" }),
    onSuccess: (_d, assetId) => setBuild((b) => ({ ...b, assets: b.assets.filter((a) => a.id !== assetId) })),
  });

  const accept = [...IMAGE_TYPES, ...VIDEO_TYPES].join(",");

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Creatives
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {build.assets.length} file{build.assets.length === 1 ? "" : "s"}
          </span>
        </h3>
        {canEdit && (
          <Button size="xs" variant="outline" onClick={() => inputRef.current?.click()}>
            <ImagePlus className="h-3.5 w-3.5" /> Add files
          </Button>
        )}
      </div>

      {canEdit && (
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void handleFiles(e.dataTransfer.files);
          }}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground transition-colors",
            dragging ? "border-primary bg-primary/5 text-foreground" : "hover:border-foreground/30",
          )}
        >
          <Upload className="h-5 w-5" />
          <span>Drop images or videos here, or click to choose</span>
          <span className="text-[11px]">JPEG · PNG · WebP up to 30 MB — MP4 · MOV up to 200 MB</span>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={accept}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      )}

      {uploads.length > 0 && (
        <ul className="space-y-1.5">
          {uploads.map((u) => (
            <li key={u.key} className="rounded-md border p-2 text-xs">
              <div className="flex items-center gap-2">
                {!u.done && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate">{u.name}</span>
                <span className="tabular-nums text-muted-foreground">{fmtBytes(u.size)}</span>
                {!u.error && <span className="w-9 text-right tabular-nums">{Math.round(u.progress * 100)}%</span>}
                {u.error && (
                  <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setUploads((l) => l.filter((x) => x.key !== u.key))} aria-label="Dismiss">
                    ×
                  </button>
                )}
              </div>
              {u.error ? (
                <p className="mt-1 text-red-400" role="alert">{u.error}</p>
              ) : (
                <div className="mt-1.5 h-1 overflow-hidden rounded bg-muted">
                  <div className={cn("h-full transition-[width]", u.done ? "bg-emerald-500" : "bg-primary")} style={{ width: `${Math.max(2, u.progress * 100)}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {build.assets.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 xl:grid-cols-3">
          {build.assets.map((a) => (
            <AssetCard key={a.id} asset={a} canEdit={canEdit} removing={remove.isPending && remove.variables === a.id} onRemove={() => remove.mutate(a.id)} />
          ))}
        </ul>
      )}
      {remove.error && (
        <p className="text-xs text-red-400" role="alert">
          {(remove.error as Error).message}
        </p>
      )}
      {build.assets.length === 0 && uploads.length === 0 && !canEdit && (
        <p className="text-xs text-muted-foreground">No creatives uploaded.</p>
      )}
    </div>
  );
}

export function AssetThumb({ asset, className }: { asset: Asset; className?: string }) {
  if (asset.kind === "video") {
    return (
      <div className={cn("relative overflow-hidden bg-muted", className)}>
        <video src={asset.url} preload="metadata" muted playsInline className="h-full w-full object-cover" />
        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
          <Film className="h-5 w-5 text-white/80" />
        </div>
      </div>
    );
  }
  return (
    // Signed Supabase URLs expire hourly and vary per fetch — next/image's optimizer
    // and remotePatterns buy nothing here, so a plain <img> is the right tool.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={asset.url} alt={asset.filename} loading="lazy" className={cn("bg-muted object-cover", className)} />
  );
}

function AssetCard({ asset, canEdit, removing, onRemove }: { asset: Asset; canEdit: boolean; removing: boolean; onRemove: () => void }) {
  const hashed = !!(asset.meta_image_hash || asset.meta_video_id);
  return (
    <li className="group relative overflow-hidden rounded-lg border">
      <AssetThumb asset={asset} className="aspect-square w-full" />
      <div className="space-y-0.5 p-1.5 text-[11px]">
        <p className="truncate font-medium" title={asset.filename}>
          {asset.filename}
        </p>
        <p className="flex items-center gap-1 tabular-nums text-muted-foreground">
          {asset.width && asset.height ? `${asset.width}×${asset.height}` : asset.kind} · {fmtBytes(asset.size_bytes)}
          {hashed && (
            <span className="ml-auto flex items-center gap-0.5 text-emerald-400" title={asset.meta_image_hash ?? asset.meta_video_id ?? ""}>
              <BadgeCheck className="h-3 w-3" /> hash uploaded
            </span>
          )}
        </p>
      </div>
      {canEdit && (
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          aria-label={`Delete ${asset.filename}`}
          className="absolute top-1 right-1 rounded-md bg-black/60 p-1 text-white/90 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 disabled:opacity-50"
        >
          {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
      )}
    </li>
  );
}
