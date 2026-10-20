import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CollectionStore } from "../../src/main/storage/collectionStore";
import { CorruptFileError } from "../../src/main/storage/fsJson";
import type {
  FolderNode,
  RequestItem,
  RequestNode,
} from "../../src/shared/types";

let dir: string;
let store: CollectionStore;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "am-col-"));
  await fsp.mkdir(path.join(dir, "collections"));
  store = new CollectionStore(dir);
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const names = (nodes: { name: string }[]) => nodes.map((n) => n.name);
const read = (rel: string) => fsp.readFile(path.join(dir, rel), "utf8");

describe("create and list", () => {
  it("lists a nested tree with workspace-relative paths", async () => {
    const col = await store.createCollection("My API");
    expect(col.path).toBe("collections/my-api");
    const folder = await store.createFolder(col.path, "Users");
    expect(folder.path).toBe("collections/my-api/users");
    const req = await store.createRequest(folder.path, "Login");
    expect(req.path).toBe("collections/my-api/users/login.request.json");
    expect(req.request).toMatchObject({
      name: "Login",
      method: "GET",
      url: "",
      params: [],
      headers: [],
      body: { mode: "none" },
      auth: { type: "inherit" },
    });

    const { collections, errors } = await store.list();
    expect(errors).toEqual([]);
    expect(collections).toHaveLength(1);
    const c = collections[0];
    expect(c).toMatchObject({
      id: col.id,
      name: "My API",
      path: "collections/my-api",
      variables: [],
    });
    const f = c.children[0] as FolderNode;
    expect(f).toMatchObject({
      kind: "folder",
      name: "Users",
      path: "collections/my-api/users",
    });
    const r = f.children[0] as RequestNode;
    expect(r).toMatchObject({ kind: "request", name: "Login", path: req.path });
    expect(r.request.id).toBe(req.request.id);
  });

  it("writes 2-space JSON with a trailing newline", async () => {
    await store.createCollection("A");
    const text = await read("collections/a/collection.json");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "order": []');
  });

  it("suffixes duplicate request names and ignores case", async () => {
    const col = await store.createCollection("C");
    await store.createRequest(col.path, "Login");
    await store.createRequest(col.path, "Login");
    await store.createRequest(col.path, "LOGIN");
    const files = (await fsp.readdir(path.join(dir, col.path))).sort();
    expect(files).toEqual([
      "collection.json",
      "login-2.request.json",
      "login-3.request.json",
      "login.request.json",
    ]);
  });

  it("keeps hostile names inside the parent", async () => {
    const col = await store.createCollection("x");
    const req = await store.createRequest("collections/x", "../../evil");
    expect(req.path).toBe("collections/x/evil.request.json");
    expect(await fsp.readdir(dir)).toEqual(["collections"]);
    expect(col.path).toBe("collections/x");
  });

  it("orders by order, then appends unlisted files alphabetically", async () => {
    const col = await store.createCollection("C");
    const b = await store.createRequest(col.path, "B");
    await store.createRequest(col.path, "A");
    await store.move(b.path, col.path, 0);
    const hand = { ...b.request, id: "hand", name: "Aardvark" };
    await fsp.writeFile(
      path.join(dir, col.path, "aardvark.request.json"),
      JSON.stringify(hand),
    );
    await fsp.writeFile(
      path.join(dir, col.path, "zeta.request.json"),
      JSON.stringify({ ...hand, name: "Zeta" }),
    );
    const { collections } = await store.list();
    expect(names(collections[0].children)).toEqual([
      "B",
      "A",
      "Aardvark",
      "Zeta",
    ]);
  });

  it("ignores stale order entries and drops them on the next write", async () => {
    const col = await store.createCollection("C");
    await store.createRequest(col.path, "A");
    const file = path.join(dir, col.path, "collection.json");
    const meta = JSON.parse(await fsp.readFile(file, "utf8"));
    meta.order = ["gone.request.json", ...meta.order];
    await fsp.writeFile(file, JSON.stringify(meta));
    expect(names((await store.list()).collections[0].children)).toEqual(["A"]);
    await store.createRequest(col.path, "B");
    expect(JSON.parse(await fsp.readFile(file, "utf8")).order).toEqual([
      "a.request.json",
      "b.request.json",
    ]);
  });
});

describe("rename", () => {
  it("renames a request file and its name field", async () => {
    const col = await store.createCollection("C");
    const req = await store.createRequest(col.path, "Old");
    const next = await store.rename(req.path, "New Name");
    expect(next).toBe("collections/c/new-name.request.json");
    await expect(fsp.access(path.join(dir, req.path))).rejects.toThrow();
    expect(JSON.parse(await read(next)).name).toBe("New Name");
    expect(
      JSON.parse(await read("collections/c/collection.json")).order,
    ).toEqual(["new-name.request.json"]);
  });

  it("renames a folder directory and metadata, keeping its position", async () => {
    const col = await store.createCollection("C");
    await store.createFolder(col.path, "A");
    const f = await store.createFolder(col.path, "B");
    await store.createFolder(col.path, "C");
    const next = await store.rename(f.path, "Beta");
    expect(next).toBe("collections/c/beta");
    expect(JSON.parse(await read("collections/c/beta/folder.json")).name).toBe(
      "Beta",
    );
    expect(names((await store.list()).collections[0].children)).toEqual([
      "A",
      "Beta",
      "C",
    ]);
  });

  it("renames a collection", async () => {
    const col = await store.createCollection("Old");
    const next = await store.rename(col.path, "Fresh");
    expect(next).toBe("collections/fresh");
    expect((await store.list()).collections[0].name).toBe("Fresh");
  });

  it("picks a unique name on collision", async () => {
    const col = await store.createCollection("C");
    await store.createRequest(col.path, "A");
    const b = await store.createRequest(col.path, "B");
    expect(await store.rename(b.path, "a")).toBe(
      "collections/c/a-2.request.json",
    );
  });

  it("allows a case-only rename", async () => {
    const col = await store.createCollection("C");
    const r = await store.createRequest(col.path, "login");
    expect(await store.rename(r.path, "Login")).toBe(r.path);
    expect(JSON.parse(await read(r.path)).name).toBe("Login");
  });
});

describe("move", () => {
  it("moves into a folder at an index and returns the new path", async () => {
    const col = await store.createCollection("C");
    const f = await store.createFolder(col.path, "F");
    await store.createRequest(f.path, "X");
    const y = await store.createRequest(col.path, "Y");
    const next = await store.move(y.path, f.path, 0);
    expect(next).toBe("collections/c/f/y.request.json");
    const tree = (await store.list()).collections[0];
    expect(names((tree.children[0] as FolderNode).children)).toEqual([
      "Y",
      "X",
    ]);
    expect(tree.children).toHaveLength(1);
  });

  it("picks a unique name when the target already has one", async () => {
    const col = await store.createCollection("C");
    const f = await store.createFolder(col.path, "F");
    await store.createRequest(f.path, "Same");
    const s = await store.createRequest(col.path, "Same");
    expect(await store.move(s.path, f.path, 5)).toBe(
      "collections/c/f/same-2.request.json",
    );
  });

  it("rejects moving a folder into itself or a descendant", async () => {
    const col = await store.createCollection("C");
    const a = await store.createFolder(col.path, "A");
    const b = await store.createFolder(a.path, "B");
    await expect(store.move(a.path, b.path, 0)).rejects.toThrow(
      "cannot_move_into_descendant",
    );
    await expect(store.move(a.path, a.path, 0)).rejects.toThrow(
      "cannot_move_into_descendant",
    );
  });

  it("does not treat a sibling with a shared name prefix as a descendant", async () => {
    const col = await store.createCollection("C");
    const a = await store.createFolder(col.path, "a");
    const ab = await store.createFolder(col.path, "ab");
    expect(await store.move(a.path, ab.path, 0)).toBe("collections/c/ab/a");
  });
});

describe("remove", () => {
  it("deletes a folder subtree and its order entry", async () => {
    const col = await store.createCollection("C");
    const f = await store.createFolder(col.path, "F");
    await store.createRequest(f.path, "X");
    await store.createRequest(col.path, "Keep");
    await store.remove(f.path);
    await expect(fsp.access(path.join(dir, f.path))).rejects.toThrow();
    expect(
      JSON.parse(await read("collections/c/collection.json")).order,
    ).toEqual(["keep.request.json"]);
  });
});

describe("path safety", () => {
  it("rejects paths outside the workspace or outside collections/", async () => {
    const col = await store.createCollection("C");
    const req = await store.createRequest(col.path, "A");
    await expect(
      store.saveRequest("../x.request.json", req.request),
    ).rejects.toThrow("path_outside_workspace");
    await expect(store.remove("../x")).rejects.toThrow(
      "path_outside_workspace",
    );
    await expect(store.remove("workspace.json")).rejects.toThrow(
      "path_outside_workspace",
    );
    await expect(store.remove("collections/../workspace.json")).rejects.toThrow(
      "path_outside_workspace",
    );
    await expect(store.rename("collections", "x")).rejects.toThrow(
      "path_outside_workspace",
    );
    await expect(store.createFolder("/etc", "x")).rejects.toThrow(
      "path_outside_workspace",
    );
  });
});

describe("saveRequest", () => {
  it("persists edits", async () => {
    const col = await store.createCollection("C");
    const r = await store.createRequest(col.path, "A");
    const edited: RequestItem = {
      ...r.request,
      method: "POST",
      url: "https://example.test",
    };
    await store.saveRequest(r.path, edited);
    expect(JSON.parse(await read(r.path))).toEqual(edited);
    expect((await read(r.path)).endsWith("\n")).toBe(true);
  });
});

describe("corrupt files", () => {
  it("reports a conflicted request, loads the rest, and refuses to overwrite it", async () => {
    const col = await store.createCollection("C");
    const good = await store.createRequest(col.path, "Good");
    const bad = await store.createRequest(col.path, "Bad");
    const conflict = "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> other\n";
    await fsp.writeFile(path.join(dir, bad.path), conflict);

    const { collections, errors } = await store.list();
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe(bad.path);
    expect(names(collections[0].children)).toEqual(["Good"]);
    expect(collections[0].children[0].path).toBe(good.path);

    await expect(
      store.saveRequest(bad.path, bad.request),
    ).rejects.toBeInstanceOf(CorruptFileError);
    expect(await read(bad.path)).toBe(conflict);
  });

  it("reports a corrupt collection.json and skips that collection only", async () => {
    const a = await store.createCollection("A");
    await store.createCollection("B");
    const file = path.join(dir, a.path, "collection.json");
    await fsp.writeFile(file, "{ nope");
    const { collections, errors } = await store.list();
    expect(names(collections)).toEqual(["B"]);
    expect(errors.map((e) => e.path)).toEqual([
      "collections/a/collection.json",
    ]);
    await expect(store.createRequest(a.path, "X")).rejects.toBeInstanceOf(
      CorruptFileError,
    );
    expect(await fsp.readFile(file, "utf8")).toBe("{ nope");
  });

  it("reports a corrupt folder.json and skips that folder only", async () => {
    const col = await store.createCollection("C");
    const f = await store.createFolder(col.path, "F");
    await store.createRequest(f.path, "Inside");
    await store.createRequest(col.path, "Outside");
    await fsp.writeFile(
      path.join(dir, f.path, "folder.json"),
      "<<<<<<< HEAD\n",
    );
    const { collections, errors } = await store.list();
    expect(names(collections[0].children)).toEqual(["Outside"]);
    expect(errors.map((e) => e.path)).toEqual(["collections/c/f/folder.json"]);
  });
});
