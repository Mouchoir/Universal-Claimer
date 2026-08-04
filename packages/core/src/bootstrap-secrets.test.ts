import { describe, expect, it, vi } from "vitest";
import { bootstrapSecrets, type SecretFile } from "./bootstrap-secrets.js";

/**
 * The precedence rules here decide whether an update can destroy a deployment's data, so they are
 * pinned down rather than trusted. Every case below corresponds to a real redeploy shape.
 */

/** In-memory stand-in for the file on the config volume. */
function fakeFile(initial: string | null = null) {
  let contents = initial;
  const file: SecretFile = {
    read: () => contents,
    write: vi.fn((next: string) => {
      contents = next;
    }),
  };
  return { file, current: () => contents, write: file.write as ReturnType<typeof vi.fn> };
}

const gen = (() => {
  let n = 0;
  return (kind: string) => `generated-${kind}-${++n}`;
})();

const stored = (values: Record<string, string>) => JSON.stringify(values);

describe("bootstrapSecrets", () => {
  it("generates and persists both secrets on a first boot", () => {
    const { file, current } = fakeFile();

    const r = bootstrapSecrets({}, file, gen);

    expect(r.generated).toEqual(["APP_ENCRYPTION_KEY", "RELAY_TOKEN"]);
    expect(r.persisted).toBe(true);
    expect(JSON.parse(current()!)).toEqual(r.values);
  });

  it("reuses the persisted secrets on a later boot, generating nothing", () => {
    // The case that matters: the container is replaced by an update and the data must stay
    // readable.
    const { file, write } = fakeFile(
      stored({ APP_ENCRYPTION_KEY: "persisted-key", RELAY_TOKEN: "persisted-token" }),
    );

    const r = bootstrapSecrets({}, file, gen);

    expect(r.values.APP_ENCRYPTION_KEY).toBe("persisted-key");
    expect(r.generated).toEqual([]);
    expect(r.persisted).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("lets the environment win over the file", () => {
    const { file } = fakeFile(
      stored({ APP_ENCRYPTION_KEY: "persisted-key", RELAY_TOKEN: "persisted-token" }),
    );

    const r = bootstrapSecrets({ APP_ENCRYPTION_KEY: "pinned-key" }, file, gen);

    expect(r.values.APP_ENCRYPTION_KEY).toBe("pinned-key");
    expect(r.values.RELAY_TOKEN).toBe("persisted-token");
  });

  it("persists a secret supplied by the environment, so removing it later is harmless", () => {
    const { file, current } = fakeFile();

    bootstrapSecrets({ APP_ENCRYPTION_KEY: "pinned-key", RELAY_TOKEN: "pinned-token" }, file, gen);
    expect(JSON.parse(current()!).APP_ENCRYPTION_KEY).toBe("pinned-key");

    // Same volume, next deploy, env vars dropped from the stack file.
    const second = bootstrapSecrets({}, { read: () => current(), write: () => {} }, gen);
    expect(second.values.APP_ENCRYPTION_KEY).toBe("pinned-key");
    expect(second.generated).toEqual([]);
  });

  it("ignores blank and whitespace-only environment values", () => {
    // An unset variable in a compose file often arrives as an empty string rather than absent.
    const { file } = fakeFile(stored({ APP_ENCRYPTION_KEY: "persisted-key" }));

    const r = bootstrapSecrets({ APP_ENCRYPTION_KEY: "   ", RELAY_TOKEN: "" }, file, gen);

    expect(r.values.APP_ENCRYPTION_KEY).toBe("persisted-key");
    expect(r.generated).toEqual(["RELAY_TOKEN"]);
  });

  it("trims a value pasted with surrounding whitespace", () => {
    const { file } = fakeFile();
    const r = bootstrapSecrets({ APP_ENCRYPTION_KEY: "  pinned-key\n" }, file, gen);
    expect(r.values.APP_ENCRYPTION_KEY).toBe("pinned-key");
  });

  it("fills in only what a partially populated file is missing", () => {
    const { file } = fakeFile(stored({ RELAY_TOKEN: "persisted-token" }));

    const r = bootstrapSecrets({}, file, gen);

    expect(r.values.RELAY_TOKEN).toBe("persisted-token");
    expect(r.generated).toEqual(["APP_ENCRYPTION_KEY"]);
    expect(r.persisted).toBe(true);
  });

  it("survives a corrupt file rather than crashing the boot", () => {
    const { file } = fakeFile("{ this is not json");
    expect(() => bootstrapSecrets({}, file, gen)).not.toThrow();
  });

  it("ignores non-string entries in the file", () => {
    const { file } = fakeFile(JSON.stringify({ APP_ENCRYPTION_KEY: 42, RELAY_TOKEN: null }));

    const r = bootstrapSecrets({}, file, gen);

    expect(r.generated).toEqual(["APP_ENCRYPTION_KEY", "RELAY_TOKEN"]);
  });
});
