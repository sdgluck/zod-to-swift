# zod-to-swift

Generate Swift `Codable` types from [zod](https://zod.dev) 4 schemas — for an iOS
or macOS app talking to a TypeScript server that already describes its API in zod.

```ts
import { z } from "zod";
import { generateSwift } from "zod-to-swift";

const Film = z.object({ ratingKey: z.string(), title: z.string(), year: z.number().int().nullable() }).meta({ id: "Film" });

const source = generateSwift([
  { name: "DeckOutput", namespace: "Match", schema: z.object({ remaining: z.number().int(), films: z.array(Film) }) },
  { name: "Status", schema: z.enum(["enabled", "disabled"]) },
]);
```

```swift
public struct Film: Codable, Sendable, Hashable {
    public var ratingKey: String
    public var title: String
    public var year: Int?
    // memberwise init, CodingKeys, encode(to:)
}

public enum Status: Codable, Sendable, Hashable, RawRepresentable {
    case enabled
    case disabled
    case unknown(String)
    // …
}

public enum Match {}
extension Match {
    public struct DeckOutput: Codable, Sendable, Hashable {
        public var remaining: Int
        public var films: [Film]
    }
}
```

## What it does with each shape

| zod | Swift |
| --- | --- |
| `z.string()` | `String` |
| `z.number().int()`, or `z.number().meta({ format: "int64" })` | `Int` |
| `z.number()` | `Double` |
| `z.boolean()` | `Bool` |
| `.optional()` / `.nullable()` | `T?` — but see encoding below |
| `z.array(T)` | `[T]` |
| `z.record(z.string(), T)` | `[String: T]` |
| `z.unknown()` / `z.any()` | `JSONValue` (always optional) |
| `z.enum([...])`, a union of string literals | `enum` with an `unknown(String)` case and a `known` list |
| `z.discriminatedUnion(key, [...])` | `enum` with one associated-value case per tag (string, number or boolean tags) |
| a union of number / boolean literals | `Int` / `Double` / `Bool` |
| an inline object | a nested struct named after its property (`members: [{…}]` → `Member`) |
| `.meta({ id: "Name" })` | one top-level type, shared by every schema that reaches it |

Anything without a faithful Swift spelling — a union nothing tells apart, a
tuple, a date, a transform — throws a `SchemaError` saying where, rather than
generating a guess.

**Why these choices.** An app ships separately from its server, so it has to
survive the server moving first. String enums keep an `unknown` case, so a value
added in a minor release doesn't fail a whole decode. Encoding is written out
rather than synthesized: synthesized `Encodable` drops `nil`, but a required
`.nullable()` field means "send `null`", which a server reads differently from
"leave it unchanged" — so required keys are always written, and only
`.optional()` ones are omitted when `nil`.

## API

```ts
generateSwift(types: NamedSchema[] | IRDocument, options?: SwiftOptions): string
```

`NamedSchema` is `{ name, schema, namespace?, io? }`. `io: "input"` describes what
a sender may send (a field with a `.default()` is optional); `"output"`, the
default, describes the parsed value (it's required).

| option | |
| --- | --- |
| `header` | comment lines for the top of the file |
| `emitSupport` | also declare `JSONValue` and `AnyCodingKey`, which the output uses (default `true`; turn off if your module defines them) |
| `itemName(root)` | name of the element type of a top-level array root (default `${root}Item`) |
| `afterNamespace(ns, refs)` | extra lines after each namespace's types; `refs` maps each root's name to its qualified Swift type — e.g. for emitting typed endpoint descriptors |

The same schemas through [`zod-to-kotlin`](https://github.com/sdgluck/zod-to-kotlin)
give the matching Kotlin; both are built on
[`zod-native-ir`](https://github.com/sdgluck/zod-native-ir).

## Requirements

Node 22.18+ and zod 4. The generated code needs Swift 5.9+ (it uses `switch`
expressions) and compiles cleanly in Swift 6 language mode.

## License

MIT
