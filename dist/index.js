/**
 * zod schemas → Swift `Codable, Sendable, Hashable` value types.
 *
 * Choices that matter for an app talking to a server it doesn't ship with:
 *
 * - **String enums keep an `unknown(String)` case.** A server that adds a
 *   value in a minor release must not make last month's app fail a whole
 *   screen's decode.
 * - **Discriminated unions are enums with associated values**, decoded by
 *   peeking at the discriminator, so a `switch` over them is exhaustive.
 * - **Encoding is written out** rather than synthesized, because synthesized
 *   `Encodable` drops a `nil` — and a required-nullable field has to be sent
 *   as `null`, which is different from leaving it out.
 * - **Inline objects become nested types named after their property**
 *   (`members: [{…}]` → `Member`), so the API reads like something a person
 *   named.
 */
import { camel, collect, nestedName, pascal, variantCaseName, } from "zod-native-ir";
const KEYWORDS = new Set("associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while Any as await false is nil self Self super throws true try".split(" "));
/** Names a nested type can't take without shadowing something every file uses. */
const RESERVED_TYPES = new Set([
    "Type",
    "Self",
    "Protocol",
    "Any",
    "String",
    "Int",
    "Bool",
    "Double",
    "Data",
    "Date",
    "Error",
    "Result",
    "Optional",
    "Array",
    "Set",
    "Dictionary",
    "Element",
    "CodingKeys",
    "Endpoint",
    "JSONValue",
]);
/** Set per `generateSwift` call; the emitter is synchronous, so this can't interleave. */
let itemName = (root) => `${root}Item`;
const ident = (name) => (KEYWORDS.has(name) ? `\`${name}\`` : name);
class Out {
    lines = [];
    depth = 0;
    line(s = "") {
        this.lines.push(s ? "    ".repeat(this.depth) + s : "");
    }
    indent(fn) {
        this.depth++;
        try {
            return fn();
        }
        finally {
            this.depth--;
        }
    }
}
function uniqueNested(ctx, wanted) {
    let name = RESERVED_TYPES.has(wanted) || wanted === ctx.parent ? `${ctx.parent}${wanted}` : wanted;
    for (let i = 2; ctx.taken.has(name); i++)
        name = `${wanted}${i}`;
    ctx.taken.add(name);
    return name;
}
/**
 * The Swift spelling of `t`. Inline shapes are declared into `ctx` as nested
 * types and referred to by name.
 */
function typeRef(t, ctx, hint, isArrayItem = false) {
    switch (t.k) {
        case "string":
            return "String";
        case "int":
            return "Int";
        case "double":
            return "Double";
        case "bool":
            return "Bool";
        case "json":
            return "JSONValue";
        case "literal":
            return typeof t.value === "string" ? "String" : typeof t.value === "boolean" ? "Bool" : "Double";
        case "ref":
            return t.name;
        case "nullable": {
            const inner = typeRef(t.of, ctx, hint, isArrayItem);
            return inner.endsWith("?") ? inner : `${inner}?`;
        }
        case "array":
            return `[${typeRef(t.of, ctx, hint, true)}]`;
        case "record":
            return `[String: ${typeRef(t.of, ctx, hint)}]`;
        case "enum":
        case "object":
        case "union": {
            const name = uniqueNested(ctx, nestedName(hint, isArrayItem));
            declare(name, t, ctx.out);
            return name;
        }
    }
}
/** Declare a named type for `t`: a struct, an enum, or a typealias. */
function declare(name, t, out) {
    if (t.k === "object")
        return struct(name, t.props, out);
    if (t.k === "enum")
        return stringEnum(name, t.values, out);
    if (t.k === "union")
        return union(name, t, out);
    // A top-level output that is a list or a scalar: name its element if it
    // needs one, and alias the rest.
    if (t.k === "array" && (t.of.k === "object" || t.of.k === "enum" || t.of.k === "union")) {
        const item = itemName(name);
        declare(item, t.of, out);
        out.line(`public typealias ${name} = [${item}]`);
        return;
    }
    const ctx = { out, taken: new Set(), parent: name };
    out.line(`public typealias ${name} = ${typeRef(t, ctx, name)}`);
}
function struct(name, props, out) {
    out.line(`public struct ${name}: Codable, Sendable, Hashable {`);
    out.indent(() => {
        const ctx = { out, taken: new Set(), parent: name };
        const fields = props.map((p) => {
            let type = typeRef(p.t, ctx, p.key);
            if (p.optional && !type.endsWith("?"))
                type += "?";
            const swiftName = camel(p.key);
            return { key: p.key, name: swiftName, type, optional: type.endsWith("?") };
        });
        // Two keys that camelCase alike (`a-b`, `a_b`) — keep both, distinctly.
        const seen = new Map();
        for (const f of fields) {
            const n = seen.get(f.name) ?? 0;
            seen.set(f.name, n + 1);
            if (n > 0)
                f.name = `${f.name}${n + 1}`;
        }
        if (fields.length > 0)
            out.line();
        for (const f of fields)
            out.line(`public var ${ident(f.name)}: ${f.type}`);
        out.line();
        const params = fields.map((f) => `${ident(f.name)}: ${f.type}${f.optional ? " = nil" : ""}`).join(", ");
        out.line(`public init(${params}) {`);
        out.indent(() => {
            for (const f of fields)
                out.line(`self.${f.name} = ${ident(f.name)}`);
        });
        out.line("}");
        if (fields.length > 0) {
            out.line();
            out.line("enum CodingKeys: String, CodingKey {");
            out.indent(() => {
                for (const f of fields)
                    out.line(f.name === f.key ? `case ${ident(f.name)}` : `case ${ident(f.name)} = ${JSON.stringify(f.key)}`);
            });
            out.line("}");
        }
        out.line();
        out.line("public func encode(to encoder: Encoder) throws {");
        out.indent(() => {
            if (fields.length === 0) {
                out.line("_ = encoder.container(keyedBy: AnyCodingKey.self)");
                return;
            }
            out.line("var c = encoder.container(keyedBy: CodingKeys.self)");
            for (const p of props) {
                const f = fields[props.indexOf(p)];
                // Absent-allowed → omit nil; required (even if nullable) → always written.
                out.line(`try c.${p.optional ? "encodeIfPresent" : "encode"}(${ident(f.name)}, forKey: .${ident(f.name)})`);
            }
        });
        out.line("}");
    });
    out.line("}");
    out.line();
}
export function enumCaseNames(values) {
    const used = new Set();
    return values.map((v) => {
        let n = camel(v);
        if (n === "unknown")
            n = "unknownValue";
        for (let i = 2; used.has(n); i++)
            n = `${camel(v)}${i}`;
        used.add(n);
        return n;
    });
}
function stringEnum(name, values, out) {
    const cases = enumCaseNames(values);
    out.line(`public enum ${name}: Codable, Sendable, Hashable, RawRepresentable {`);
    out.indent(() => {
        for (const c of cases)
            out.line(`case ${ident(c)}`);
        out.line("/** A value this build doesn't know — a newer server's. */");
        out.line("case unknown(String)");
        out.line();
        out.line(`public static let known: [${name}] = [${cases.map((c) => `.${ident(c)}`).join(", ")}]`);
        out.line();
        out.line("public init(rawValue: String) {");
        out.indent(() => {
            out.line("switch rawValue {");
            values.forEach((v, i) => out.line(`case ${JSON.stringify(v)}: self = .${ident(cases[i])}`));
            out.line("default: self = .unknown(rawValue)");
            out.line("}");
        });
        out.line("}");
        out.line();
        out.line("public var rawValue: String {");
        out.indent(() => {
            out.line("switch self {");
            values.forEach((v, i) => out.line(`case .${ident(cases[i])}: ${JSON.stringify(v)}`));
            out.line("case .unknown(let raw): raw");
            out.line("}");
        });
        out.line("}");
        out.line();
        out.line("public init(from decoder: Decoder) throws {");
        out.indent(() => out.line("self.init(rawValue: try decoder.singleValueContainer().decode(String.self))"));
        out.line("}");
        out.line();
        out.line("public func encode(to encoder: Encoder) throws {");
        out.indent(() => {
            out.line("var c = encoder.singleValueContainer()");
            out.line("try c.encode(rawValue)");
        });
        out.line("}");
    });
    out.line("}");
    out.line();
}
function union(name, t, out) {
    const tagType = typeof t.variants[0].tag === "string" ? "String" : typeof t.variants[0].tag === "boolean" ? "Bool" : "Double";
    out.line(`public enum ${name}: Codable, Sendable, Hashable {`);
    out.indent(() => {
        const ctx = { out, taken: new Set(), parent: name };
        const cases = t.variants.map((v) => {
            const caseName = variantCaseName(t.discriminator, v.tag);
            const payload = v.t.k === "ref" ? v.t.name : uniqueNested(ctx, pascal(caseName));
            if (v.t.k !== "ref")
                declare(payload, v.t, out);
            return { caseName, payload, tag: v.tag };
        });
        for (const c of cases)
            out.line(`case ${ident(c.caseName)}(${c.payload})`);
        out.line();
        out.line("public init(from decoder: Decoder) throws {");
        out.indent(() => {
            out.line("let c = try decoder.container(keyedBy: AnyCodingKey.self)");
            out.line(`let key = AnyCodingKey(${JSON.stringify(t.discriminator)})`);
            out.line(`switch try c.decode(${tagType}.self, forKey: key) {`);
            for (const c of cases)
                out.line(`case ${JSON.stringify(c.tag)}: self = .${ident(c.caseName)}(try ${c.payload}(from: decoder))`);
            out.line("case let other:");
            out.indent(() => out.line(`throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: "Unknown ${name} \\(other)")`));
            out.line("}");
        });
        out.line("}");
        out.line();
        out.line("public func encode(to encoder: Encoder) throws {");
        out.indent(() => {
            out.line("switch self {");
            for (const c of cases)
                out.line(`case .${ident(c.caseName)}(let value): try value.encode(to: encoder)`);
            out.line("}");
        });
        out.line("}");
    });
    out.line("}");
    out.line();
}
export const SWIFT_SUPPORT = `/// A value with no fixed shape — whatever \`z.unknown()\` allowed.
public enum JSONValue: Codable, Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

/// A coding key made from any string — how a union reads its discriminator.
public struct AnyCodingKey: CodingKey, Hashable, Sendable {
    public var stringValue: String
    public var intValue: Int? { nil }
    public init(_ string: String) { stringValue = string }
    public init?(stringValue: String) { self.stringValue = stringValue }
    public init?(intValue: Int) { nil }
}
`;
/**
 * Swift source declaring each named schema, plus every `.meta({ id })` shape
 * they reach, once, at the top level. Namespaced roots are nested in
 * `public enum <Namespace> {}` via an extension.
 */
export function generateSwift(types, options = {}) {
    const doc = Array.isArray(types) ? collect(types) : types;
    itemName = options.itemName ?? ((root) => `${root}Item`);
    const out = new Out();
    for (const line of options.header ?? [])
        out.line(`// ${line}`);
    if (options.header?.length)
        out.line();
    out.line("import Foundation");
    out.line();
    if (options.emitSupport ?? true)
        for (const line of SWIFT_SUPPORT.split("\n"))
            out.line(line);
    for (const d of doc.defs)
        declare(d.name, d.t, out);
    for (const r of doc.roots.filter((r) => !r.namespace))
        declare(r.name, r.t, out);
    const namespaces = [...new Set(doc.roots.flatMap((r) => (r.namespace ? [r.namespace] : [])))];
    for (const ns of namespaces) {
        const roots = doc.roots.filter((r) => r.namespace === ns);
        out.line(`public enum ${ns} {}`);
        out.line();
        out.line(`extension ${ns} {`);
        out.indent(() => {
            for (const r of roots)
                declare(r.name, r.t, out);
        });
        out.line("}");
        out.line();
        if (options.afterNamespace) {
            const refs = new Map(roots.map((r) => [r.name, `${ns}.${r.name}`]));
            for (const line of options.afterNamespace(ns, refs))
                out.line(line);
            out.line();
        }
    }
    return out.lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
//# sourceMappingURL=index.js.map