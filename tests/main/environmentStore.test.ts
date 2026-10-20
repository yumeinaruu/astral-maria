import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  EnvironmentStore,
  type SecretCipher,
} from "../../src/main/storage/environmentStore";
import type { Environment } from "../../src/shared/types";

const cipher: SecretCipher = {
  encrypt: (s) => "enc:" + s,
  decrypt: (s) => {
    if (!s.startsWith("enc:")) throw new Error("bad cipher text");
    return s.slice(4);
  },
};

let dir: string;
let store: EnvironmentStore;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "am-env-"));
  store = new EnvironmentStore(dir, cipher);
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const read = (rel: string) => fsp.readFile(path.join(dir, rel), "utf8");
const readJ = async (rel: string) => JSON.parse(await read(rel));
const write = async (rel: string, text: string) => {
  await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fsp.writeFile(path.join(dir, rel), text);
};
const exists = (rel: string) =>
  fsp.access(path.join(dir, rel)).then(
    () => true,
    () => false,
  );

const env = (over: Partial<Environment> = {}): Environment => ({
  id: "e1",
  name: "Staging",
  variables: [],
  ...over,
});

async function allFiles(root: string, skip: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (p === skip) continue;
    if (e.isDirectory()) out.push(...(await allFiles(p, skip)));
    else out.push(p);
  }
  return out;
}

describe("storage rule", () => {
  it("writes secrets encrypted to .local and blank to the committed file", async () => {
    await store.save(
      env({
        variables: [
          {
            key: "token",
            value: "shared-secret",
            currentValue: "hunter2",
            secret: true,
            enabled: true,
          },
        ],
      }),
    );
    expect(await readJ("environments/staging.json")).toEqual({
      id: "e1",
      name: "Staging",
      variables: [{ key: "token", value: "", secret: true, enabled: true }],
    });
    expect(await readJ(".local/environments/staging.json")).toEqual({
      values: { token: "enc:hunter2" },
    });
    for (const f of await allFiles(dir, path.join(dir, ".local"))) {
      const raw = await fsp.readFile(f, "utf8");
      expect(raw).not.toContain("hunter2");
      expect(raw).not.toContain("shared-secret");
    }
  });

  it("keeps the shared value of a plain variable committed and its current value local in plain text", async () => {
    await store.save(
      env({
        variables: [
          {
            key: "host",
            value: "example.com",
            currentValue: "localhost",
            secret: false,
            enabled: true,
          },
        ],
      }),
    );
    expect((await readJ("environments/staging.json")).variables[0]).toEqual({
      key: "host",
      value: "example.com",
      secret: false,
      enabled: true,
    });
    expect(await readJ(".local/environments/staging.json")).toEqual({
      values: { host: "localhost" },
    });
  });

  it("creates .local lazily and drops it when no current values remain", async () => {
    await store.save(
      env({
        variables: [{ key: "a", value: "1", secret: false, enabled: true }],
      }),
    );
    expect(await exists(".local")).toBe(false);
    await store.save(
      env({
        variables: [
          {
            key: "a",
            value: "1",
            currentValue: "2",
            secret: false,
            enabled: true,
          },
        ],
      }),
    );
    expect(await exists(".local/environments/staging.json")).toBe(true);
    await store.save(
      env({
        variables: [{ key: "a", value: "1", secret: false, enabled: true }],
      }),
    );
    expect(await exists(".local/environments/staging.json")).toBe(false);
  });

  it("stores the globals set as environments/globals.json", async () => {
    await store.save(env({ id: "globals", name: "Globals" }));
    expect(await exists("environments/globals.json")).toBe(true);
    await store.save(
      env({
        id: "globals",
        name: "Globals",
        variables: [{ key: "k", value: "v", secret: false, enabled: true }],
      }),
    );
    expect((await store.list()).environments).toHaveLength(1);
  });

  it("does not let a new environment take the globals file name", async () => {
    await store.save(env({ id: "x", name: "Globals" }));
    expect(await exists("environments/globals-2.json")).toBe(true);
  });
});

describe("list and resolvedValues", () => {
  const vars: Environment["variables"] = [
    {
      key: "token",
      value: "",
      currentValue: "hunter2",
      secret: true,
      enabled: true,
    },
    {
      key: "host",
      value: "example.com",
      currentValue: "localhost",
      secret: false,
      enabled: true,
    },
    { key: "port", value: "8080", secret: false, enabled: true },
    { key: "off", value: "x", secret: false, enabled: false },
    {
      key: "empty",
      value: "fallback",
      currentValue: "",
      secret: false,
      enabled: true,
    },
  ];

  it("round-trips what save wrote, including secrets", async () => {
    await store.save(env({ variables: vars }));
    const { environments, errors } = await store.list();
    expect(errors).toEqual([]);
    expect(environments).toHaveLength(1);
    expect(
      environments[0].variables.find((v) => v.key === "token"),
    ).toMatchObject({
      value: "",
      currentValue: "hunter2",
      secret: true,
    });
    expect(
      environments[0].variables.find((v) => v.key === "host"),
    ).toMatchObject({
      value: "example.com",
      currentValue: "localhost",
    });
  });

  it("prefers the current value, falls back to the shared one, skips disabled", async () => {
    await store.save(env({ variables: vars }));
    expect(await store.resolvedValues("e1")).toEqual({
      token: "hunter2",
      host: "localhost",
      port: "8080",
      empty: "fallback",
    });
  });

  it("rejects an unknown id", async () => {
    await expect(store.resolvedValues("nope")).rejects.toThrow(
      "environment_not_found",
    );
  });

  it("returns nothing when the directory does not exist", async () => {
    expect(await store.list()).toEqual({ environments: [], errors: [] });
  });
});

describe("damaged files", () => {
  it("reports a corrupt environment file and loads the others", async () => {
    await store.save(env({ id: "good", name: "Good" }));
    await write("environments/bad.json", "{ nope");
    const { environments, errors } = await store.list();
    expect(environments.map((e) => e.id)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("environments/bad.json");
  });

  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["empty object", "{}"],
    ["variables not an array", '{"id":"a","name":"A","variables":{}}'],
    [
      "non-string key",
      '{"id":"a","name":"A","variables":[{"key":1,"value":"","secret":false,"enabled":true}]}',
    ],
  ])(
    "reports a wrongly shaped environment file (%s) without throwing",
    async (_n, text) => {
      await write("environments/odd.json", text);
      await store.save(env({ id: "good", name: "Good" }));
      const { environments, errors } = await store.list();
      expect(environments.map((e) => e.id)).toEqual(["good"]);
      expect(errors.map((e) => e.path)).toEqual(["environments/odd.json"]);
    },
  );

  it("never overwrites a corrupt globals file", async () => {
    await write("environments/globals.json", "<<<<<<< HEAD\n");
    await expect(
      store.save(env({ id: "globals", name: "Globals" })),
    ).rejects.toThrow();
    expect(await read("environments/globals.json")).toBe("<<<<<<< HEAD\n");
  });

  it.each([
    ["not json"],
    ["null"],
    ["[]"],
    ['{"values":[]}'],
    ['{"values":{"a":1}}'],
  ])(
    "loads the shared values when the .local file is bad (%s) and reports it",
    async (text) => {
      await store.save(
        env({
          variables: [
            {
              key: "host",
              value: "example.com",
              currentValue: "localhost",
              secret: false,
              enabled: true,
            },
            {
              key: "token",
              value: "",
              currentValue: "hunter2",
              secret: true,
              enabled: true,
            },
          ],
        }),
      );
      await write(".local/environments/staging.json", text);
      const { environments, errors } = await store.list();
      expect(errors.map((e) => e.path)).toEqual([
        ".local/environments/staging.json",
      ]);
      expect(environments).toHaveLength(1);
      expect(environments[0].variables.map((v) => v.currentValue)).toEqual([
        undefined,
        undefined,
      ]);
      expect(await store.resolvedValues("e1")).toEqual({
        host: "example.com",
        token: "",
      });
      await expect(store.save(environments[0])).rejects.toThrow();
      expect(await read(".local/environments/staging.json")).toBe(text);
    },
  );

  it("reports a secret that fails to decrypt and treats it as empty", async () => {
    await store.save(
      env({
        variables: [
          {
            key: "token",
            value: "",
            currentValue: "hunter2",
            secret: true,
            enabled: true,
          },
        ],
      }),
    );
    await write(
      ".local/environments/staging.json",
      '{"values":{"token":"garbage"}}',
    );
    const { environments, errors } = await store.list();
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe(".local/environments/staging.json");
    expect(environments[0].variables[0].currentValue).toBeUndefined();
    expect(await store.resolvedValues("e1")).toEqual({ token: "" });
  });
});

describe("remove and path safety", () => {
  it("deletes both files", async () => {
    await store.save(
      env({
        variables: [
          {
            key: "a",
            value: "",
            currentValue: "b",
            secret: true,
            enabled: true,
          },
        ],
      }),
    );
    await store.remove("e1");
    expect(await exists("environments/staging.json")).toBe(false);
    expect(await exists(".local/environments/staging.json")).toBe(false);
    expect((await store.list()).environments).toEqual([]);
  });

  it("leaves other environments alone and tolerates a missing id", async () => {
    await store.save(env({ id: "a", name: "A" }));
    await store.save(env({ id: "b", name: "B" }));
    await store.remove("a");
    await store.remove("zzz");
    expect((await store.list()).environments.map((e) => e.id)).toEqual(["b"]);
  });

  it.each(["../outside", "a/b", "..", "a\\b", ""])(
    "rejects the id %j in remove and save",
    async (id) => {
      await write("keep.json", "{}");
      await expect(store.remove(id)).rejects.toThrow("invalid_id");
      await expect(store.save(env({ id }))).rejects.toThrow("invalid_id");
      expect(await exists("keep.json")).toBe(true);
    },
  );

  it("keeps file names short and inside environments/", async () => {
    await store.save(env({ name: "é".repeat(300) }));
    const files = await fsp.readdir(path.join(dir, "environments"));
    expect(files).toHaveLength(1);
    expect(Buffer.byteLength(files[0])).toBeLessThan(255 - 10);
    expect(await fsp.readdir(dir)).toEqual(["environments"]);
  });

  it("treats names with path characters as plain slugs", async () => {
    await store.save(env({ name: "../../etc/passwd" }));
    expect(await fsp.readdir(path.join(dir, "environments"))).toEqual([
      "etc-passwd.json",
    ]);
  });
});

describe("concurrency", () => {
  it("gives parallel saves of same-named new environments distinct files", async () => {
    await Promise.all(
      ["a", "b", "c", "d", "e"].map((id) =>
        store.save(env({ id, name: "Same" })),
      ),
    );
    const files = (await fsp.readdir(path.join(dir, "environments"))).sort();
    expect(files).toHaveLength(5);
    expect((await store.list()).environments.map((e) => e.id).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("keeps the chain alive after a rejected call", async () => {
    const results = await Promise.allSettled([
      store.save(env({ id: "../x" })),
      store.save(env({ id: "ok" })),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
  });

  it("saving an existing id updates its file in place", async () => {
    await store.save(env());
    await store.save(env({ name: "Renamed" }));
    expect(await fsp.readdir(path.join(dir, "environments"))).toEqual([
      "staging.json",
    ]);
    expect((await store.list()).environments[0].name).toBe("Renamed");
  });
});
