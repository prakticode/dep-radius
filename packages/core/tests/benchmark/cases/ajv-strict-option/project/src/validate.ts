import Ajv from "ajv"

const ajv = new Ajv({ strict: true, allErrors: true })

const orderSchema = {
  type: "object",
  properties: {
    id: { type: ["string", "integer"] },
    email: { type: "string" },
    phone: { type: "string" },
    quantity: { type: "integer", minimum: 1 },
  },
  required: ["id", "quantity"],
  anyOf: [{ required: ["email"] }, { required: ["phone"] }],
  additionalProperties: false,
}

export const validateOrder = ajv.compile(orderSchema)
