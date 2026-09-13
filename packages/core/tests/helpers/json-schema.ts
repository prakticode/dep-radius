// The subset of JSON Schema that schema/brief-v1.schema.json uses, enough to hold --json to it
// without a validator dependency: type, const, enum, required, properties, additionalProperties,
// items and local $ref.

type Schema = Record<string, unknown>

export function validate(
  value: unknown,
  schema: Schema,
  root: Schema = schema,
  path = "$"
): string[] {
  if (typeof schema.$ref === "string") {
    const target = schema.$ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>((node, key) => (node as Schema)[key], root) as Schema
    return validate(value, target, root, path)
  }
  const errors: string[] = []
  if ("const" in schema && value !== schema.const)
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`)
  const type = schema.type
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return [`${path}: expected object`]
    const obj = value as Record<string, unknown>
    for (const key of (schema.required as string[] | undefined) ?? [])
      if (!(key in obj)) errors.push(`${path}.${key}: required`)
    const props =
      (schema.properties as Record<string, Schema> | undefined) ?? {}
    for (const [key, v] of Object.entries(obj)) {
      if (props[key])
        errors.push(...validate(v, props[key], root, `${path}.${key}`))
      else if (schema.additionalProperties === false)
        errors.push(`${path}.${key}: not in the schema`)
      else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      )
        errors.push(
          ...validate(
            v,
            schema.additionalProperties as Schema,
            root,
            `${path}.${key}`
          )
        )
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) return [`${path}: expected array`]
    value.forEach((v, i) =>
      errors.push(
        ...validate(
          v,
          (schema.items as Schema | undefined) ?? {},
          root,
          `${path}[${i}]`
        )
      )
    )
  } else if (type === "string" && typeof value !== "string")
    errors.push(`${path}: expected string`)
  else if (type === "integer" && !Number.isInteger(value))
    errors.push(`${path}: expected integer`)
  else if (type === "boolean" && typeof value !== "boolean")
    errors.push(`${path}: expected boolean`)
  return errors
}
