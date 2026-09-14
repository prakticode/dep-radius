import { asyncScheduler, fromEvent, map, switchMap, throttleTime } from "rxjs"
import { ajax } from "rxjs/ajax"

export function searchAsYouType(input: HTMLInputElement, render: (results: string[]) => void) {
  return fromEvent(input, "input")
    .pipe(
      map(() => input.value),
      throttleTime(500, asyncScheduler, { trailing: true }),
      switchMap((query) => ajax.getJSON<string[]>(`/api/search?q=${encodeURIComponent(query)}`)),
    )
    .subscribe(render)
}
