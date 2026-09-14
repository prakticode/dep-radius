import { useState } from "react"
import { useForm } from "react-hook-form"
import { CalendarPopover } from "./CalendarPopover"

type Stay = {
  checkIn: string
  checkOut: string
}

export function StayForm({ onSubmit }: { onSubmit: (stay: Stay) => void }) {
  const [picking, setPicking] = useState<keyof Stay | null>(null)
  const {
    register,
    handleSubmit,
    setValue,
    trigger,
    formState: { errors },
  } = useForm<Stay>()

  const pick = (field: keyof Stay, date: string) => {
    setValue(field, date)
    setPicking(null)
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <label htmlFor="checkIn">Check-in</label>
      <input
        id="checkIn"
        readOnly
        onFocus={() => setPicking("checkIn")}
        {...register("checkIn", { required: "Pick a check-in date", onBlur: () => trigger("checkOut") })}
      />

      <label htmlFor="checkOut">Check-out</label>
      <input
        id="checkOut"
        readOnly
        onFocus={() => setPicking("checkOut")}
        {...register("checkOut", {
          validate: (value, values) => value > values.checkIn || "Check-out must be after check-in",
        })}
      />
      {errors.checkOut && <p role="alert">{errors.checkOut.message}</p>}

      {picking && <CalendarPopover onSelect={(date) => pick(picking, date)} />}

      <button type="submit">Book</button>
    </form>
  )
}
