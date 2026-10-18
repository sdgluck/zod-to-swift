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
import { type IRDocument, type NamedSchema } from "zod-native-ir";
export type { NamedSchema } from "zod-native-ir";
/** The wrappers a top-level root can put around the type it names. */
export type Wrapper = "array" | "record" | "nullable";
export declare function enumCaseNames(values: string[]): string[];
export interface SwiftOptions {
    /** Comment lines for the top of the file, without the `// `. */
    header?: string[];
    /**
     * Also declare `JSONValue` (for `z.unknown()`) and `AnyCodingKey` (for
     * unions), which the generated code refers to. Turn off when the module
     * already defines them. Default true.
     */
    emitSupport?: boolean;
    /**
     * The name of the shape a top-level root wraps: the element of a list, the
     * value of a map, the object behind an optional. `wrapper` is the one
     * directly around the shape. Default `${root}Item` for a list element and
     * `${root}Value` otherwise.
     */
    itemName?: (root: string, wrapper: Wrapper) => string;
    /**
     * Extra lines after a namespace's types — e.g. endpoint descriptors that
     * refer to them. `refs` maps each root's name to its qualified Swift type.
     */
    afterNamespace?: (namespace: string, refs: Map<string, string>) => string[];
}
export declare const SWIFT_SUPPORT = "/// A value with no fixed shape \u2014 whatever `z.unknown()` allowed.\npublic enum JSONValue: Codable, Sendable, Hashable {\n    case null\n    case bool(Bool)\n    case number(Double)\n    case string(String)\n    case array([JSONValue])\n    case object([String: JSONValue])\n\n    public init(from decoder: Decoder) throws {\n        let c = try decoder.singleValueContainer()\n        if c.decodeNil() { self = .null }\n        else if let b = try? c.decode(Bool.self) { self = .bool(b) }\n        else if let n = try? c.decode(Double.self) { self = .number(n) }\n        else if let s = try? c.decode(String.self) { self = .string(s) }\n        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }\n        else { self = .object(try c.decode([String: JSONValue].self)) }\n    }\n\n    public func encode(to encoder: Encoder) throws {\n        var c = encoder.singleValueContainer()\n        switch self {\n        case .null: try c.encodeNil()\n        case .bool(let b): try c.encode(b)\n        case .number(let n): try c.encode(n)\n        case .string(let s): try c.encode(s)\n        case .array(let a): try c.encode(a)\n        case .object(let o): try c.encode(o)\n        }\n    }\n}\n\n/// A coding key made from any string \u2014 how a union reads its discriminator.\npublic struct AnyCodingKey: CodingKey, Hashable, Sendable {\n    public var stringValue: String\n    public var intValue: Int? { nil }\n    public init(_ string: String) { stringValue = string }\n    public init?(stringValue: String) { self.stringValue = stringValue }\n    public init?(intValue: Int) { nil }\n}\n";
/**
 * Swift source declaring each named schema, plus every `.meta({ id })` shape
 * they reach, once, at the top level. Namespaced roots are nested in
 * `public enum <Namespace> {}` via an extension.
 */
export declare function generateSwift(types: NamedSchema[] | IRDocument, options?: SwiftOptions): string;
