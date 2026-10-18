/**
 * zod → Swift, one test per shape. Assertions are on the generated source,
 * since that is the artifact; the last test hands a representative file to
 * `swiftc` (when there is one) so "it compiles" is proven, not inferred.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { generateSwift } from "./index.ts";

const int = () => z.number().meta({ format: "int64" });
const swift = (schema: z.ZodType, extra: Partial<Parameters<typeof generateSwift>[1]> = {}) =>
  generateSwift([{ name: "Root", schema }], { emitSupport: false, ...extra });

describe("scalars and absence", () => {
  test("int64 numbers are Int, others Double", () => {
    const s = swift(z.object({ count: int(), rating: z.number() }));
    assert.match(s, /public var count: Int\n/);
    assert.match(s, /public var rating: Double\n/);
  });

  test("optional and nullable are both Swift optionals, but only optional is omitted on encode", () => {
    const s = swift(z.object({ a: z.string().optional(), b: z.string().nullable() }));
    assert.match(s, /public var a: String\?\n/);
    assert.match(s, /public var b: String\?\n/);
    assert.match(s, /try c\.encodeIfPresent\(a, forKey: \.a\)/);
    assert.match(s, /try c\.encode\(b, forKey: \.b\)/);
  });

  test("records are dictionaries, unknown is JSONValue", () => {
    const s = swift(z.object({ pins: z.record(z.string(), z.array(z.string())), meta: z.unknown() }));
    assert.match(s, /public var pins: \[String: \[String\]\]/);
    assert.match(s, /public var meta: JSONValue\?/);
  });
});

describe("enums", () => {
  test("cases are camelCase, with an unknown fallback and the known list", () => {
    const s = swift(z.enum(["item-added", "new_to_me", "3d"]));
    assert.match(s, /case itemAdded\n/);
    assert.match(s, /case newToMe\n/);
    assert.match(s, /case v3d\n/);
    assert.match(s, /case unknown\(String\)/);
    assert.match(s, /public static let known: \[Root\] = \[\.itemAdded, \.newToMe, \.v3d\]/);
  });

  test("a value called unknown doesn't collide with the fallback", () => {
    assert.match(swift(z.enum(["known", "unknown"])), /case unknownValue\n/);
  });
});

describe("unions", () => {
  test("a shared variant is a payload by name; an inline one nests", () => {
    const Signed = z.object({ status: z.literal("ok"), token: z.string() }).meta({ id: "SignedFixture" });
    const s = swift(z.discriminatedUnion("status", [z.object({ status: z.literal("open") }), Signed]));
    assert.match(s, /public struct SignedFixture: Codable/);
    assert.match(s, /case `open`\(Open\)/);
    assert.match(s, /case "ok": self = \.ok\(try SignedFixture\(from: decoder\)\)/);
  });

  test("a boolean tag decodes as Bool", () => {
    const s = swift(
      z.discriminatedUnion("ok", [z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), why: z.string() })]),
    );
    assert.match(s, /case okTrue\(OkTrue\)/);
    assert.match(s, /switch try c\.decode\(Bool\.self, forKey: key\)/);
  });
});

describe("naming and layout", () => {
  test("inline objects nest under their property, singular for lists", () => {
    const s = swift(z.object({ members: z.array(z.object({ name: z.string() })) }));
    assert.match(s, /public struct Member: Codable/);
    assert.match(s, /public var members: \[Member\]/);
  });

  test("a top-level list names its element with itemName", () => {
    const list = z.array(z.object({ title: z.string() }));
    assert.match(swift(list), /public typealias Root = \[RootItem\]/);
    assert.match(swift(list, { itemName: () => "Film" }), /public typealias Root = \[Film\]/);
  });

  test("an optional or map root names the shape it wraps once, not after itself twice", () => {
    const shape = z.object({ title: z.string() });
    const optional = swift(shape.nullable());
    assert.match(optional, /public struct RootValue: /);
    assert.match(optional, /public typealias Root = RootValue\?/);
    assert.doesNotMatch(optional, /RootRoot/);
    assert.match(swift(z.record(z.string(), shape)), /public typealias Root = \[String: RootValue\]/);
    assert.match(swift(z.array(shape).nullable()), /public typealias Root = \[RootItem\]\?/);
    const named = swift(shape.nullable(), { itemName: (root, wrapper) => `${root}${wrapper === "nullable" ? "Detail" : "Item"}` });
    assert.match(named, /public typealias Root = RootDetail\?/);
  });

  test("dotted and keyword keys get Swift names and keep their wire key", () => {
    const s = swift(z.object({ "tab.match": z.boolean(), default: z.boolean() }));
    assert.match(s, /case tabMatch = "tab\.match"/);
    assert.match(s, /public var `default`: Bool/);
  });

  test("namespaced roots nest in an enum, and afterNamespace sees their qualified names", () => {
    const s = generateSwift([{ namespace: "Api", name: "Thing", schema: z.object({ a: z.string() }) }], {
      emitSupport: false,
      afterNamespace: (ns, refs) => [`// ${ns}: ${[...refs.values()].join(",")}`],
    });
    assert.match(s, /public enum Api \{\}\n\nextension Api \{\n {4}public struct Thing/);
    assert.match(s, /\/\/ Api: Api\.Thing/);
  });

  test("support types are emitted unless turned off", () => {
    assert.match(generateSwift([{ name: "R", schema: z.string() }]), /public enum JSONValue/);
    assert.doesNotMatch(swift(z.string()), /JSONValue/);
  });

  test("the same input gives the same bytes", () => {
    const schema = z.object({ a: z.string(), b: z.enum(["x", "y"]) });
    assert.equal(swift(schema), swift(schema));
  });
});

test("the output compiles", { skip: !hasSwiftc() && "no swiftc on PATH" }, () => {
  const Shared = z.object({ id: z.string(), at: int() }).meta({ id: "Shared" });
  const source = generateSwift([
    {
      namespace: "Api",
      name: "Everything",
      schema: z.object({
        "dotted.key": z.boolean(),
        default: z.string().nullable(),
        list: z.array(z.object({ n: int() })),
        map: z.record(z.string(), Shared),
        meta: z.unknown(),
        kind: z.enum(["a-b", "unknown"]),
        result: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), shared: Shared }), z.object({ ok: z.literal(false) })]),
      }),
    },
    { namespace: "Api", name: "Films", schema: z.array(z.object({ title: z.string() })) },
  ]);
  const dir = mkdtempSync(join(tmpdir(), "zod-to-swift-"));
  try {
    writeFileSync(join(dir, "Generated.swift"), source);
    execFileSync("swiftc", ["-typecheck", "-swift-version", "6", join(dir, "Generated.swift")], { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function hasSwiftc(): boolean {
  try {
    execFileSync("swiftc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
