import { promises as fs } from "node:fs";
import path from "node:path";

// Discord's max upload is 25MB on the free tier; cap a little under that so a
// single huge file can't blow up the worker's memory or disk.
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;

/** Best-effort, path-traversal-safe filename derived from a URL's path. */
function filenameFromUrl(url: string, fallback: string): string {
  try {
    const p = new URL(url).pathname;
    const base = decodeURIComponent(p.slice(p.lastIndexOf("/") + 1));
    // Keep only safe chars and strip leading dots so we never write "../" etc.
    const safe = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 80);
    return safe || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Download Discord attachments (ANY type — text, images, PDFs, logs, source
 * files…) into `destDir` so Claude's `Read` tool can open them. Files over
 * MAX_ATTACHMENT_BYTES or that fail to fetch are skipped silently. Returns the
 * absolute paths of the files that were actually saved.
 *
 * Why download instead of passing the URL? Claude runs headless via the CLI and
 * reads local files with its `Read` tool; it has no way to fetch a remote URL by
 * itself, and Discord CDN links are signed + expiring.
 */
export async function downloadAttachments(urls: string[], destDir: string): Promise<string[]> {
  if (!urls?.length) return [];
  await fs.mkdir(destDir, { recursive: true });
  const saved: string[] = [];
  for (const [i, url] of urls.entries()) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      // Cheap pre-check via Content-Length, then a hard check after reading.
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared && declared > MAX_ATTACHMENT_BYTES) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_ATTACHMENT_BYTES) continue;
      // Prefix with the index to avoid collisions when names repeat.
      const dest = path.join(destDir, `${i}-${filenameFromUrl(url, `file-${i}`)}`);
      await fs.writeFile(dest, buf);
      saved.push(dest);
    } catch {
      /* unreachable / oversized / write error — skip this one */
    }
  }
  return saved;
}
