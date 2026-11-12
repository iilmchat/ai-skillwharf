import { describe, expect, it } from "vitest";

import { skillManifestSchema, type SkillManifest } from "./skill-manifest";

/**
 * Пример валидного SKILL.md из
 * `docs/ecosystem/Manifest-Specification.md` (frontmatter, разобранный в объект).
 */
const documentedManifest: SkillManifest = {
  name: "web-researcher-pro",
  version: "1.2.0",
  description:
    "Ищет актуальную информацию в интернете, анализирует сайты и делает выжимку.",
  author: {
    name: "Ivan Petrov",
    email: "ivan@example.com",
  },
  dependencies: {
    tools: ["web_search", "read_url"],
  },
  permissions: ["network"],
  pricing: {
    model: "Pay-per-Call",
    price: 0.05,
    currency: "RUB",
  },
  checksum:
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};

/** Минимально допустимый манифест: только обязательные поля. */
const minimalManifest: SkillManifest = {
  name: "minimal-skill",
  version: "0.0.1",
  description: "",
  author: { name: "Anonymous" },
  permissions: [],
};

describe("skillManifestSchema", () => {
  it("принимает пример из документации", () => {
    const result = skillManifestSchema.safeParse(documentedManifest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(documentedManifest);
    }
  });

  it("принимает манифест без необязательных полей", () => {
    expect(skillManifestSchema.safeParse(minimalManifest).success).toBe(true);
  });

  it("отклоняет манифест без обязательного name", () => {
    const { name: _name, ...withoutName } = documentedManifest;

    expect(skillManifestSchema.safeParse(withoutName).success).toBe(false);
  });

  it("отклоняет манифест без обязательного permissions", () => {
    const { permissions: _permissions, ...withoutPermissions } =
      documentedManifest;

    expect(skillManifestSchema.safeParse(withoutPermissions).success).toBe(
      false,
    );
  });

  it("отклоняет name не в kebab-case", () => {
    const manifest = { ...documentedManifest, name: "Web Researcher" };

    expect(skillManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("отклоняет невалидную версию", () => {
    for (const version of ["1.2", "v1.2.0", "01.2.3", "1.2.3.4"]) {
      const manifest = { ...documentedManifest, version };

      expect(skillManifestSchema.safeParse(manifest).success, version).toBe(
        false,
      );
    }
  });

  it("принимает SemVer с pre-release и build-метаданными", () => {
    const manifest = { ...documentedManifest, version: "1.2.0-beta.1+build.5" };

    expect(skillManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("отклоняет разрешение вне enum permissions", () => {
    const manifest = { ...documentedManifest, permissions: ["root"] };

    expect(skillManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("отклоняет description длиннее 256 символов", () => {
    const manifest = { ...documentedManifest, description: "x".repeat(257) };

    expect(skillManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("отклоняет невалидный e-mail автора", () => {
    const manifest = {
      ...documentedManifest,
      author: { name: "Ivan Petrov", email: "not-an-email" },
    };

    expect(skillManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("отклоняет невалидную модель монетизации", () => {
    const manifest = {
      ...documentedManifest,
      pricing: { model: "Pay-what-you-want" },
    };

    expect(skillManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("отклоняет невалидный checksum", () => {
    const manifest = { ...documentedManifest, checksum: "sha256:abc" };

    expect(skillManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("допускает лишние ключи, как и JSON Schema (они отбрасываются)", () => {
    const withExtra = {
      ...documentedManifest,
      unexpected: true,
    };

    const result = skillManifestSchema.safeParse(withExtra);

    expect(result.success).toBe(true);
    if (result.success) {
      expect("unexpected" in result.data).toBe(false);
    }
  });
});
