import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

export const useDeviceId = create(
  persist(
    () => ({
      id: crypto.randomUUID(),
    }),
    {
      name: "device-id",
      storage: createJSONStorage(() => localStorage),
    },
  ),
)
