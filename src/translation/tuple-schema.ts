/**
 * Tuple schema conversion — bridges JSON Schema `prefixItems` (tuple) to
 * object-based representation that Codex upstream accepts.
 *
 * Request side:  convertTupleSchemas() rewrites prefixItems → properties with numeric keys
 * Response side: reconvertTupleValues() restores {"0":…,"1":…} back to […,…]
 */

type Schema = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Detection ──────────────────────────────────────────────────────

/** Returns true if the schema tree contains any `prefixItems` node. */
export function hasTupleSchemas(schema: Schema): boolean {
  return walk(schema, new Set());
}

function walk(node: Schema, seen: Set<object>): boolean {
  if (seen.has(node)) return false;
  seen.add(node);

  if (Array.isArray(node.prefixItems)) return true;

  // properties
  if (isRecord(node.properties)) {
    for (const v of Object.values(node.properties)) {
      if (isRecord(v) && walk(v, seen)) return true;
    }
  }

  // items
  if (isRecord(node.items) && walk(node.items as Schema, seen)) return true;

  // combinators
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(node[key])) {
      for (const entry of node[key] as unknown[]) {
        if (isRecord(entry) && walk(entry, seen)) return true;
      }
    }
  }

  // $defs / definitions
  for (const key of ["$defs", "definitions"] as const) {
    if (isRecord(node[key])) {
      for (const v of Object.values(node[key] as Schema)) {
        if (isRecord(v) && walk(v, seen)) return true;
      }
    }
  }

  // conditional
  for (const key of ["if", "then", "else", "not"] as const) {
    if (isRecord(node[key]) && walk(node[key] as Schema, seen)) return true;
  }

  return false;
}

// ── Request-side conversion ────────────────────────────────────────

/**
 * Recursively convert `prefixItems` tuple schemas to equivalent object schemas.
 * Input must be a clone — this function mutates in place and returns the same reference.
 */
export function convertTupleSchemas(node: Schema): Schema {
  return convertWalk(node, new Set());
}

function convertWalk(node: Schema, seen: Set<object>): Schema {
  if (seen.has(node)) return node;
  seen.add(node);

  // Convert this node if it has prefixItems
  if (Array.isArray(node.prefixItems)) {
    const items = node.prefixItems as unknown[];
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const key = String(i);
      properties[key] = isRecord(items[i]) ? convertWalk(items[i] as Schema, seen) : items[i];
      required.push(key);
    }

    node.type = "object";
    node.properties = properties;
    node.required = required;
    node.additionalProperties = false;
    delete node.prefixItems;
    delete node.items;
    return node;
  }

  // Recurse into properties
  if (isRecord(node.properties)) {
    for (const [k, v] of Object.entries(node.properties)) {
      if (isRecord(v)) node.properties[k] = convertWalk(v, seen);
    }
  }

  // Recurse into items
  if (isRecord(node.items)) {
    node.items = convertWalk(node.items as Schema, seen);
  }

  // Recurse into combinators
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(node[key])) {
      node[key] = (node[key] as unknown[]).map((entry) =>
        isRecord(entry) ? convertWalk(entry, seen) : entry,
      );
    }
  }

  // Recurse into $defs / definitions
  for (const key of ["$defs", "definitions"] as const) {
    if (isRecord(node[key])) {
      const defs = node[key] as Schema;
      for (const [k, v] of Object.entries(defs)) {
        if (isRecord(v)) defs[k] = convertWalk(v, seen);
      }
    }
  }

  // Recurse into conditional
  for (const key of ["if", "then", "else", "not"] as const) {
    if (isRecord(node[key])) {
      node[key] = convertWalk(node[key] as Schema, seen);
    }
  }

  return node;
}

// ── Response-side reconversion ─────────────────────────────────────

/**
 * Schema-guided recursive reconversion: turn {"0":…,"1":…} objects back to arrays
 * wherever the *original* schema had `prefixItems`.
 */
export function reconvertTupleValues(data: unknown, schema: Schema, rootSchema?: Schema): unknown {
  const root = rootSchema ?? schema;

  // Resolve $ref
  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, root);
    if (resolved) return reconvertTupleValues(data, resolved, root);
    return data;
  }

  // Tuple node: original schema has prefixItems → data should be {"0":…,"1":…} → convert to array
  if (Array.isArray(schema.prefixItems) && isRecord(data)) {
    const items = schema.prefixItems as unknown[];
    const result: unknown[] = [];
    for (let i = 0; i < items.length; i++) {
      const key = String(i);
      const val = data[key];
      const itemSchema = items[i];
      result.push(isRecord(itemSchema) ? reconvertTupleValues(val, itemSchema, root) : val);
    }
    return result;
  }

  // Object with properties → recurse into each property
  if (isRecord(schema.properties) && isRecord(data)) {
    const result: Record<string, unknown> = { ...data };
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in result && isRecord(propSchema)) {
        result[key] = reconvertTupleValues(result[key], propSchema, root);
      }
    }
    return result;
  }

  // Array with items schema → recurse into each element
  if (isRecord(schema.items) && Array.isArray(data)) {
    return data.map((el) => reconvertTupleValues(el, schema.items as Schema, root));
  }

  // Combinators — try to find matching branch (heuristic: first branch that has prefixItems)
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(schema[key])) {
      for (const branch of schema[key] as unknown[]) {
        if (isRecord(branch) && hasTupleSchemas(branch)) {
          return reconvertTupleValues(data, branch, root);
        }
      }
    }
  }

  return data;
}

function resolveRef(ref: string, root: Schema): Schema | undefined {
  // Only handle internal refs: #/$defs/Name or #/definitions/Name
  const match = ref.match(/^#\/(\$defs|definitions)\/(.+)$/);
  if (!match) return undefined;
  const defs = root[match[1]];
  if (!isRecord(defs)) return undefined;
  const resolved = defs[match[2]];
  return isRecord(resolved) ? resolved : undefined;
}

// ── Incremental streaming decoder ─────────────────────────────────

type DecoderState = "await-open" | "skip-key" | "collect-value" | "done";

/**
 * Incrementally decodes a Codex-streamed tuple object {"0":v0,"1":v1,...}
 * back into a JSON array [v0,v1,...], emitting each element as soon as its
 * JSON boundary is detected rather than buffering the entire response.
 *
 * Feed text deltas via push(); call flush() at stream end to close any
 * unclosed bracket on a truncated stream.
 */
export class TupleStreamDecoder {
  private state: DecoderState = "await-open";
  private valueBuf = "";
  private valueDepth = 0;
  private inStr = false;
  private escaped = false;
  private keyBuf = "";
  private currentKey = "";

  constructor(
    private readonly schema: Schema,
    private readonly rootSchema: Schema = schema,
  ) {}

  push(delta: string): string {
    let out = "";
    for (let i = 0; i < delta.length; i++) {
      out += this.step(delta[i]);
    }
    return out;
  }

  /** Safety-net closer for truncated streams. */
  flush(): string {
    return this.state === "done" ? "" : "]";
  }

  private step(ch: string): string {
    switch (this.state) {
      case "await-open":
        if (ch === "{") {
          this.state = "skip-key";
          return "[";
        }
        return "";

      case "skip-key":
        return this.stepKey(ch);

      case "collect-value":
        return this.stepValue(ch);

      case "done":
        return "";
    }
  }

  private stepKey(ch: string): string {
    if (this.escaped) {
      this.escaped = false;
      if (this.inStr) this.keyBuf += ch;
      return "";
    }
    if (ch === "\\") {
      if (this.inStr) {
        this.escaped = true;
        this.keyBuf += ch;
      }
      return "";
    }
    if (ch === '"') {
      if (!this.inStr) {
        this.inStr = true;
        this.keyBuf = "";
      } else {
        this.inStr = false;
        this.currentKey = this.keyBuf;
      }
      return "";
    }
    if (this.inStr) {
      this.keyBuf += ch;
      return "";
    }
    if (ch === ":") {
      this.state = "collect-value";
      this.valueBuf = "";
      this.valueDepth = 0;
      this.inStr = false;
      this.escaped = false;
    }
    // whitespace and other chars between key and colon — skip
    return "";
  }

  private stepValue(ch: string): string {
    if (this.escaped) {
      this.escaped = false;
      this.valueBuf += ch;
      return "";
    }
    if (ch === "\\") {
      if (this.inStr) {
        this.escaped = true;
        this.valueBuf += ch;
      } else {
        // bare backslash outside string — pass through
        this.valueBuf += ch;
      }
      return "";
    }
    if (ch === '"') {
      this.inStr = !this.inStr;
      this.valueBuf += ch;
      return "";
    }
    if (!this.inStr) {
      if (ch === "{" || ch === "[") {
        this.valueDepth++;
        this.valueBuf += ch;
        return "";
      }
      if (ch === "}" || ch === "]") {
        if (this.valueDepth > 0) {
          this.valueDepth--;
          this.valueBuf += ch;
          return "";
        }
        // Outer object closed — last value complete
        const emitted = this.emitValue();
        this.state = "done";
        return emitted + "]";
      }
      if (ch === "," && this.valueDepth === 0) {
        const emitted = this.emitValue();
        this.state = "skip-key";
        this.inStr = false;
        this.escaped = false;
        return emitted + ",";
      }
    }
    // Skip leading whitespace before value content starts
    if (this.valueBuf.length === 0 && (ch === " " || ch === "\t" || ch === "\n" || ch === "\r")) {
      return "";
    }
    this.valueBuf += ch;
    return "";
  }

  private emitValue(): string {
    const raw = this.valueBuf.trimEnd();
    this.valueBuf = "";
    if (!raw) return "null";

    const keyIndex = parseInt(this.currentKey, 10);
    const prefixItems = this.schema.prefixItems as unknown[] | undefined;
    const itemSchema = Number.isFinite(keyIndex) ? prefixItems?.[keyIndex] : undefined;

    try {
      const parsed = JSON.parse(raw) as unknown;
      const reconverted = isRecord(itemSchema)
        ? reconvertTupleValues(parsed, itemSchema, this.rootSchema)
        : parsed;
      return JSON.stringify(reconverted);
    } catch {
      return raw;
    }
  }
}
