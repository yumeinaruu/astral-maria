import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type {
  Auth,
  CollectionTree,
  FolderNode,
  KeyValue,
  LoadError,
  RequestItem,
  RequestNode,
  TreeNode,
} from "../../shared/types";
import { readJson, resolveInside, writeJsonAtomic } from "./fsJson";
import { slugify, uniqueSlug } from "./slug";

const COLLECTIONS = "collections";
const REQUEST_SUFFIX = ".request.json";
const COLLECTION_FILE = "collection.json";
const FOLDER_FILE = "folder.json";

interface FolderMeta {
  id: string;
  name: string;
  order: string[];
}

interface CollectionMeta extends FolderMeta {
  variables: KeyValue[];
  auth: Auth;
}

interface Target {
  abs: string;
  rel: string;
}

/** A parent directory (collection or folder) together with its parsed metadata. */
interface Container {
  abs: string;
  rel: string;
  metaFile: string;
  meta: FolderMeta;
}

function isRequestFile(name: string): boolean {
  return name.endsWith(REQUEST_SUFFIX) && !name.startsWith(".");
}

/** Name without the request suffix, used to compare siblings for uniqueness. */
function baseName(entry: string): string {
  return isRequestFile(entry) ? entry.slice(0, -REQUEST_SUFFIX.length) : entry;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class CollectionStore {
  private readonly root: string;

  constructor(private readonly workspaceDir: string) {
    this.root = path.resolve(workspaceDir);
  }

  async list(): Promise<{
    collections: CollectionTree[];
    errors: LoadError[];
  }> {
    const errors: LoadError[] = [];
    const collections: CollectionTree[] = [];
    let entries: string[];
    try {
      entries = await this.dirNames(path.join(this.root, COLLECTIONS), "dir");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { collections, errors };
      throw e;
    }
    for (const dirName of entries.sort(compare)) {
      const rel = `${COLLECTIONS}/${dirName}`;
      const metaRel = `${rel}/${COLLECTION_FILE}`;
      let meta: CollectionMeta;
      try {
        meta = await readJson<CollectionMeta>(path.join(this.root, metaRel));
      } catch (e) {
        // A directory without collection.json is not a collection; anything else is reported.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          errors.push({ path: metaRel, message: errorMessage(e) });
        continue;
      }
      collections.push({
        id: meta.id,
        name: meta.name,
        path: rel,
        variables: meta.variables ?? [],
        auth: meta.auth ?? { type: "none" },
        children: await this.loadChildren(rel, meta.order ?? [], errors),
      });
    }
    return { collections, errors };
  }

  async createCollection(name: string): Promise<CollectionTree> {
    const collectionsDir = path.join(this.root, COLLECTIONS);
    await fs.mkdir(collectionsDir, { recursive: true });
    const taken = new Set(await fs.readdir(collectionsDir));
    const slug = uniqueSlug(slugify(name), taken);
    const meta: CollectionMeta = {
      id: randomUUID(),
      name,
      order: [],
      variables: [],
      auth: { type: "none" },
    };
    await fs.mkdir(path.join(collectionsDir, slug));
    await writeJsonAtomic(
      path.join(collectionsDir, slug, COLLECTION_FILE),
      meta,
    );
    return {
      id: meta.id,
      name,
      path: `${COLLECTIONS}/${slug}`,
      variables: meta.variables,
      auth: meta.auth,
      children: [],
    };
  }

  async createFolder(parentPath: string, name: string): Promise<FolderNode> {
    const parent = await this.container(this.target(parentPath));
    const order = await this.orderedNames(parent);
    const slug = uniqueSlug(slugify(name), new Set(order.map(baseName)));
    const meta: FolderMeta = { id: randomUUID(), name, order: [] };
    await fs.mkdir(path.join(parent.abs, slug));
    await writeJsonAtomic(path.join(parent.abs, slug, FOLDER_FILE), meta);
    await this.writeOrder(parent, [...order, slug]);
    return {
      kind: "folder",
      id: meta.id,
      name,
      path: `${parent.rel}/${slug}`,
      children: [],
    };
  }

  async createRequest(parentPath: string, name: string): Promise<RequestNode> {
    const parent = await this.container(this.target(parentPath));
    const order = await this.orderedNames(parent);
    const slug = uniqueSlug(slugify(name), new Set(order.map(baseName)));
    const request: RequestItem = {
      id: randomUUID(),
      name,
      method: "GET",
      url: "",
      params: [],
      headers: [],
      body: { mode: "none" },
      auth: { type: "inherit" },
    };
    const file = `${slug}${REQUEST_SUFFIX}`;
    await writeJsonAtomic(path.join(parent.abs, file), request);
    await this.writeOrder(parent, [...order, file]);
    return {
      kind: "request",
      id: request.id,
      name,
      path: `${parent.rel}/${file}`,
      request,
    };
  }

  async saveRequest(requestPath: string, request: RequestItem): Promise<void> {
    const t = this.target(requestPath);
    if (!isRequestFile(path.posix.basename(t.rel)))
      throw new Error("not_a_request_path");
    // Parsing first guarantees a corrupt (e.g. merge-conflicted) file is never overwritten.
    await readJson(t.abs);
    await writeJsonAtomic(t.abs, request);
  }

  async rename(itemPath: string, newName: string): Promise<string> {
    const t = this.target(itemPath);
    const isRequest = isRequestFile(path.posix.basename(t.rel));
    const parentRel = path.posix.dirname(t.rel);
    const parent =
      parentRel === COLLECTIONS
        ? null
        : await this.container(this.target(parentRel));
    const oldEntry = path.posix.basename(t.rel);

    const siblings = await this.siblingNames(parent, path.dirname(t.abs));
    const taken = new Set(siblings.filter((s) => s !== oldEntry).map(baseName));
    const slug = uniqueSlug(slugify(newName), taken);
    const newEntry = isRequest ? `${slug}${REQUEST_SUFFIX}` : slug;
    const newAbs = path.join(path.dirname(t.abs), newEntry);

    const order = parent ? await this.orderedNames(parent) : [];
    if (isRequest) {
      const request = await readJson<RequestItem>(t.abs);
      await writeJsonAtomic(t.abs, { ...request, name: newName });
    } else {
      const metaFile = path.join(
        t.abs,
        parentRel === COLLECTIONS ? COLLECTION_FILE : FOLDER_FILE,
      );
      const meta = await readJson<FolderMeta>(metaFile);
      await writeJsonAtomic(metaFile, { ...meta, name: newName });
    }
    if (newEntry !== oldEntry) await fs.rename(t.abs, newAbs);
    if (parent)
      await this.writeOrder(
        parent,
        order.map((n) => (n === oldEntry ? newEntry : n)),
      );
    return `${parentRel}/${newEntry}`;
  }

  async remove(itemPath: string): Promise<void> {
    const t = this.target(itemPath);
    const parentRel = path.posix.dirname(t.rel);
    const parent =
      parentRel === COLLECTIONS
        ? null
        : await this.container(this.target(parentRel));
    const order = parent ? await this.orderedNames(parent) : [];
    await fs.rm(t.abs, { recursive: true, force: true });
    if (parent) {
      const entry = path.posix.basename(t.rel);
      await this.writeOrder(
        parent,
        order.filter((n) => n !== entry),
      );
    }
  }

  async move(
    itemPath: string,
    newParentPath: string,
    index: number,
  ): Promise<string> {
    const t = this.target(itemPath);
    const srcParentRel = path.posix.dirname(t.rel);
    if (srcParentRel === COLLECTIONS) throw new Error("cannot_move_collection");
    const dest = this.target(newParentPath);
    if (dest.abs === t.abs || dest.abs.startsWith(t.abs + path.sep))
      throw new Error("cannot_move_into_descendant");

    const src = await this.container(this.target(srcParentRel));
    const dst = dest.rel === srcParentRel ? src : await this.container(dest);
    const entry = path.posix.basename(t.rel);

    const srcOrder = (await this.orderedNames(src)).filter((n) => n !== entry);
    let newEntry = entry;
    if (dst !== src) {
      const taken = new Set((await this.orderedNames(dst)).map(baseName));
      const slug = uniqueSlug(baseName(entry), taken);
      newEntry = isRequestFile(entry) ? `${slug}${REQUEST_SUFFIX}` : slug;
      await fs.rename(t.abs, path.join(dst.abs, newEntry));
    }
    const dstOrder =
      dst === src
        ? srcOrder
        : (await this.orderedNames(dst)).filter((n) => n !== newEntry);
    const at = Math.max(0, Math.min(Math.trunc(index) || 0, dstOrder.length));
    dstOrder.splice(at, 0, newEntry);

    if (dst !== src) await this.writeOrder(src, srcOrder);
    await this.writeOrder(dst, dstOrder);
    return `${dst.rel}/${newEntry}`;
  }

  // ---- helpers ----

  /** Validates an incoming path: inside the workspace and inside `collections/`. */
  private target(p: string): Target {
    const abs = resolveInside(this.workspaceDir, p);
    const rel = path.relative(this.root, abs).split(path.sep).join("/");
    if (!rel.startsWith(`${COLLECTIONS}/`))
      throw new Error("path_outside_workspace");
    return { abs, rel };
  }

  private async container(t: Target): Promise<Container> {
    const isCollection = t.rel.split("/").length === 2;
    const metaFile = path.join(
      t.abs,
      isCollection ? COLLECTION_FILE : FOLDER_FILE,
    );
    try {
      const meta = await readJson<FolderMeta>(metaFile);
      return { ...t, metaFile, meta };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("parent_not_found");
      throw e;
    }
  }

  private async dirNames(
    dir: string,
    kind: "dir" | "request",
  ): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          !e.name.startsWith(".") &&
          (kind === "dir"
            ? e.isDirectory()
            : e.isFile() && isRequestFile(e.name)),
      )
      .map((e) => e.name);
  }

  /** Child entry names on disk: those in `order` first, then the rest alphabetically. */
  private async entryNames(dir: string, order: string[]): Promise<string[]> {
    const onDisk = [
      ...(await this.dirNames(dir, "dir")),
      ...(await this.dirNames(dir, "request")),
    ];
    const present = new Set(onDisk);
    const listed = [...new Set(order)].filter((n) => present.has(n));
    const listedSet = new Set(listed);
    return [
      ...listed,
      ...onDisk.filter((n) => !listedSet.has(n)).sort(compare),
    ];
  }

  private orderedNames(c: Container): Promise<string[]> {
    return this.entryNames(c.abs, c.meta.order ?? []);
  }

  private async siblingNames(
    parent: Container | null,
    dir: string,
  ): Promise<string[]> {
    return parent ? this.orderedNames(parent) : this.dirNames(dir, "dir");
  }

  private async writeOrder(c: Container, order: string[]): Promise<void> {
    await writeJsonAtomic(c.metaFile, { ...c.meta, order });
  }

  private async loadChildren(
    dirRel: string,
    order: string[],
    errors: LoadError[],
  ): Promise<TreeNode[]> {
    const dirAbs = path.join(this.root, dirRel);
    let names: string[];
    try {
      names = await this.entryNames(dirAbs, order);
    } catch (e) {
      errors.push({ path: dirRel, message: errorMessage(e) });
      return [];
    }
    const nodes: TreeNode[] = [];
    for (const name of names) {
      const rel = `${dirRel}/${name}`;
      if (isRequestFile(name)) {
        try {
          const request = await readJson<RequestItem>(
            path.join(this.root, rel),
          );
          nodes.push({
            kind: "request",
            id: request.id,
            name: request.name,
            path: rel,
            request,
          });
        } catch (e) {
          errors.push({ path: rel, message: errorMessage(e) });
        }
        continue;
      }
      const metaRel = `${rel}/${FOLDER_FILE}`;
      try {
        const meta = await readJson<FolderMeta>(path.join(this.root, metaRel));
        nodes.push({
          kind: "folder",
          id: meta.id,
          name: meta.name,
          path: rel,
          children: await this.loadChildren(rel, meta.order ?? [], errors),
        });
      } catch (e) {
        // A directory without folder.json is not a folder (e.g. left behind by a merge); skip it quietly.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          errors.push({ path: metaRel, message: errorMessage(e) });
      }
    }
    return nodes;
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
