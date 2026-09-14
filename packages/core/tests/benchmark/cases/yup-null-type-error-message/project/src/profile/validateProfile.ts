import * as yup from "yup"

const profileSchema = yup.object({
  name: yup.string().required("Enter your name"),
  age: yup.number().typeError("Enter your age in years").min(18, "You must be 18 or older"),
  birthday: yup.date().typeError("Enter a valid date"),
})

export async function validateProfile(input: unknown): Promise<string[]> {
  try {
    await profileSchema.validate(input, { abortEarly: false })
    return []
  } catch (error) {
    if (error instanceof yup.ValidationError) return error.errors
    throw error
  }
}
