import validator from "validator"

export function isValidEmail(input: string) {
  return validator.isEmail(input)
}
