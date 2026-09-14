export function CalendarPopover({ onSelect }: { onSelect: (date: string) => void }) {
  return (
    <div role="dialog">
      <input type="date" onChange={(event) => onSelect(event.target.value)} />
    </div>
  )
}
