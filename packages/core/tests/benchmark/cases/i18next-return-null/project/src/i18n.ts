import i18next from "i18next"

import en from "./locales/en.json" with { type: "json" }

await i18next.init({ lng: "en", resources: { en: { translation: en } } })

export function label(key: string, fallback: string) {
  // a null translation means "use the fallback"
  const value = i18next.t(key)
  return value === null ? fallback : value
}
